/**
 * @file The attempt and nonce machinery every sender shares (the settlement submitter and monitor
 * here, the compliance sender of piece C): decoding the outbox call, allocating a nonce under the
 * signer lock, recording a signed attempt, fencing the outbox lease, and broadcasting a recorded
 * attempt with its outcome sorted the way ADR 0009 requires.
 *
 * The rules this file exists to keep in one place:
 *
 * - A nonce is allocated only while `signer_state` is locked FOR UPDATE (`lockSignerState`), and
 *   never one that any recorded attempt of this signer already holds (`nextNonce` with every
 *   attempt nonce at or above the chain's pending count). Attempts are never deleted, so a nonce
 *   that was signed once is never handed out again (ADR 0012 item 1).
 * - An attempt is inserted only in the transaction that also applies its SUBMIT move (the caller
 *   does that), so the operation's version fences it, and, for an outbox-driven send, only while
 *   the row's lease is still ours (`fenceOutboxLease`, the same row FAIL/REVERSE cancel).
 * - Broadcasting is classified, never guessed: sent, `unknown` (keep the attempt, check by hash
 *   later, never a fresh nonce), `rejected` (THIS node refused; the attempt still counts in
 *   `attemptCanStillMine` until its nonce is final), `nonce_used` (something, maybe this very
 *   transaction, already used the nonce; the monitor decides from receipts and the reference).
 */

import {
  AlreadyKnownError,
  type ContractCall,
  type Fees,
  InsufficientFundsError as ChainInsufficientFunds,
  NonceTooLowError,
  ReplacementUnderpricedError,
  type SignerName,
  type SubmitRequest,
  SubmissionRejectedError,
  type TxHash,
} from '@bridge/chain';
import {
  bigintFromDecimal,
  type ChainAttempt,
  lockSignerState,
  type OutboxMessage,
  type PrismaClient,
} from '@bridge/db';
import { type AttemptRecord, auditEntryFor, type AuditEntity, nextNonce } from '@bridge/domain';

import { InvalidRequestError, LeaseLostError } from './errors';
import { writeAudit } from './ledger-writes';
import { describeError } from './redact';
import type { SignedTransaction, TransactionSigner } from './signing';
import type { Tx } from './transaction';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;

function field(o: Record<string, unknown>, name: string): unknown {
  return o[name];
}

function address(o: Record<string, unknown>, name: string): `0x${string}` {
  const v = field(o, name);
  if (typeof v !== 'string' || !ADDRESS.test(v)) {
    throw new InvalidRequestError(`outbox call: ${name} must be a lowercase address`);
  }
  return v as `0x${string}`;
}

function amount(o: Record<string, unknown>): bigint {
  const v = field(o, 'amount');
  if (typeof v !== 'string') throw new InvalidRequestError('outbox call: amount must be decimal');
  const n = bigintFromDecimal(v);
  if (n <= 0n) throw new InvalidRequestError('outbox call: amount must be positive');
  return n;
}

function flag(o: Record<string, unknown>, name: string): boolean {
  const v = field(o, name);
  if (typeof v !== 'boolean') throw new InvalidRequestError(`outbox call: ${name} must be boolean`);
  return v;
}

/**
 * The typed `ContractCall` stored in an outbox row's `call` column (bigints as decimal strings).
 * Strict: an unknown kind, a missing field or a malformed value is `InvalidRequestError`, never
 * a guess. The object's key order is the one `OperationService` writes, so the signed request is
 * the same whichever process decodes it.
 *
 * @param json The stored column.
 */
export function contractCallFromJson(json: unknown): ContractCall {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new InvalidRequestError('outbox call must be an object');
  }
  const o = json as Record<string, unknown>;
  const ref = field(o, 'ref');
  if (typeof ref !== 'string' || !BYTES32.test(ref)) {
    throw new InvalidRequestError('outbox call: ref must be a lowercase bytes32');
  }
  const r = ref as `0x${string}`;
  switch (field(o, 'kind')) {
    case 'mint':
      return { kind: 'mint', to: address(o, 'to'), amount: amount(o), ref: r };
    case 'burn':
      return { kind: 'burn', from: address(o, 'from'), amount: amount(o), ref: r };
    case 'settleTransfer':
      return {
        kind: 'settleTransfer',
        from: address(o, 'from'),
        to: address(o, 'to'),
        amount: amount(o),
        ref: r,
      };
    case 'setVerified':
      return {
        kind: 'setVerified',
        account: address(o, 'account'),
        verified: flag(o, 'verified'),
        ref: r,
      };
    case 'setFrozen':
      return {
        kind: 'setFrozen',
        account: address(o, 'account'),
        frozen: flag(o, 'frozen'),
        ref: r,
      };
    default:
      throw new InvalidRequestError('outbox call: unknown kind');
  }
}

/** The fees an attempt was signed with. */
export function feesOf(attempt: ChainAttempt): Fees {
  return {
    maxFeePerGas: attempt.maxFeePerGas,
    maxPriorityFeePerGas: attempt.maxPriorityFeePerGas,
  };
}

/**
 * The exact request a recorded attempt was signed from: its signer, nonce and fees, and the call
 * of its outbox row. Re-signing it gives the same bytes (signing is deterministic).
 *
 * @param attempt The recorded attempt.
 * @param call The decoded call of its outbox row.
 */
export function requestOf(attempt: ChainAttempt, call: ContractCall): SubmitRequest {
  return { signer: attempt.signer, call, nonce: attempt.nonce, fees: feesOf(attempt) };
}

/** The signed transaction a recorded attempt holds. */
export function signedOf(attempt: ChainAttempt): SignedTransaction {
  return { hash: attempt.hash as TxHash, raw: attempt.rawTransaction as `0x${string}` };
}

/**
 * The domain's view of an attempt, for `assessAttempt` / `attemptCanStillMine`.
 *
 * @param attempt The recorded attempt.
 * @param resubmitsSoFar The operation's resubmission count.
 */
export function attemptRecordOf(attempt: ChainAttempt, resubmitsSoFar: number): AttemptRecord {
  return {
    nonce: attempt.nonce,
    fees: feesOf(attempt),
    submittedAt: attempt.submittedAt,
    bumpsSoFar: attempt.bumpsSoFar,
    resubmitsSoFar,
  };
}

/**
 * Re-checks, inside the caller's transaction, that `row` is still `processing` under the lease
 * this worker claimed, and touches it so the row is locked until commit. Throws `LeaseLostError`
 * otherwise (the transaction then rolls back and nothing is broadcast). FAIL and REVERSE cancel
 * live outbox rows with an UPDATE of the same row, so the two serialise: either the cancellation
 * commits first and this fence fails, or the attempt commits first and the cancellation sees it.
 *
 * @param tx The caller's transaction.
 * @param row The claimed outbox row (its `lockedBy` is the lease token).
 * @param at The time to stamp as the lease renewal.
 */
export async function fenceOutboxLease(tx: Tx, row: OutboxMessage, at: Date): Promise<void> {
  if (row.lockedBy === null) throw new LeaseLostError(`outbox row ${row.id} has no lease`);
  const r = await tx.outboxMessage.updateMany({
    where: { id: row.id, status: 'processing', lockedBy: row.lockedBy },
    data: { lockedAt: at },
  });
  if (r.count !== 1) {
    throw new LeaseLostError(`outbox row ${row.id} is no longer leased to this worker`);
  }
}

/** What `allocateNonce` needs. */
export interface NonceAllocation {
  /** The deployment the attempt is bound to. */
  readonly deploymentId: string;
  /** Which signer. */
  readonly signer: SignerName;
  /** The address the gateway signs with; must equal the locked `signer_state` row. */
  readonly signerAddress: string;
  /** The signer's pending count read from the node (before the transaction). */
  readonly chainPending: number;
}

/**
 * Locks `signer_state` and returns the next nonce no recorded attempt of this signer holds.
 * Throws `InvalidRequestError` when the gateway's signer is not the deployment's recorded one
 * (signing with another key would use another nonce sequence, ADR 0011).
 *
 * @param tx The caller's transaction; the lock is held until it ends.
 * @param input Deployment, signer, its address and the node's pending count.
 */
export async function allocateNonce(tx: Tx, input: NonceAllocation): Promise<number> {
  const locked = await lockSignerState(tx, input.deploymentId, input.signer);
  if (locked.address !== input.signerAddress.toLowerCase()) {
    throw new InvalidRequestError(
      `the gateway's ${input.signer} signer is not the one recorded for deployment ${input.deploymentId}`,
    );
  }
  const held = await tx.chainAttempt.findMany({
    where: {
      deploymentId: input.deploymentId,
      signer: input.signer,
      nonce: { gte: input.chainPending },
    },
    select: { nonce: true },
    distinct: ['nonce'],
  });
  return nextNonce({ chainPending: input.chainPending, reservedLocally: held.map((h) => h.nonce) });
}

/** What `insertAttempt` records. */
export interface NewAttempt {
  /** The deployment. */
  readonly deploymentId: string;
  /** The outbox row the attempt belongs to. */
  readonly outboxId: string;
  /** The request it was signed from. */
  readonly request: SubmitRequest;
  /** The signed transaction. */
  readonly signed: SignedTransaction;
  /** The contract it calls (the deployment's token or registry; the database checks). */
  readonly contractAddress: string;
  /** Fee-bump replacements already sent for this nonce, this one included. */
  readonly bumpsSoFar: number;
  /** When it was signed. */
  readonly at: Date;
}

/**
 * Inserts the signed attempt (status `signed`). Call it only in the transaction that also applies
 * the matching SUBMIT move.
 *
 * @param tx The caller's transaction.
 * @param a The attempt.
 */
export function insertAttempt(tx: Tx, a: NewAttempt): Promise<ChainAttempt> {
  return tx.chainAttempt.create({
    data: {
      deploymentId: a.deploymentId,
      outboxId: a.outboxId,
      signer: a.request.signer,
      nonce: a.request.nonce,
      hash: a.signed.hash,
      rawTransaction: a.signed.raw,
      maxFeePerGas: a.request.fees.maxFeePerGas,
      maxPriorityFeePerGas: a.request.fees.maxPriorityFeePerGas,
      contractAddress: a.contractAddress,
      ref: a.request.call.ref,
      status: 'signed',
      bumpsSoFar: a.bumpsSoFar,
      submittedAt: a.at,
    },
  });
}

/** How a broadcast ended. */
export type BroadcastResult =
  /** The node took it (or already held these exact bytes). */
  | { readonly kind: 'sent' }
  /** No answer, or an answer nobody recognised: it may have been accepted. Retry by hash. */
  | { readonly kind: 'unknown'; readonly error: unknown }
  /** THIS node refused it. Another node may still hold it: keep counting it. */
  | { readonly kind: 'rejected'; readonly error: unknown }
  /** The nonce is already used (possibly by this very transaction). The monitor decides. */
  | { readonly kind: 'nonce_used'; readonly error: unknown };

/**
 * Sorts a broadcast failure (ADR 0009). Only the allowlisted definite answers are `rejected` or
 * `nonce_used`; everything else, including errors that are not `ChainError`s, is `unknown`.
 *
 * @param err What the broadcast threw.
 */
export function classifyBroadcastError(err: unknown): BroadcastResult {
  if (err instanceof AlreadyKnownError) return { kind: 'sent' };
  if (err instanceof NonceTooLowError) return { kind: 'nonce_used', error: err };
  if (
    err instanceof SubmissionRejectedError ||
    err instanceof ReplacementUnderpricedError ||
    err instanceof ChainInsufficientFunds
  ) {
    return { kind: 'rejected', error: err };
  }
  // ChainUnavailableError, any other ChainError, a hash mismatch, a bug: the outcome is unknown.
  return { kind: 'unknown', error: err };
}

/**
 * Broadcasts a recorded attempt and classifies the outcome. Never throws for a chain answer.
 *
 * @param signer The transaction signer.
 * @param attempt The recorded attempt.
 * @param call The decoded call of its outbox row.
 */
export async function broadcastAttempt(
  signer: TransactionSigner,
  attempt: ChainAttempt,
  call: ContractCall,
): Promise<BroadcastResult> {
  try {
    await signer.broadcast(signedOf(attempt), requestOf(attempt, call));
    return { kind: 'sent' };
  } catch (err) {
    return classifyBroadcastError(err);
  }
}

/**
 * Records what a broadcast did on the attempt's observation columns (identity never changes) and,
 * for anything but a plain send, an audit row with the redacted error. A `rejected` attempt is
 * marked `dropped` ("this node does not hold it") and is still counted by the monitor.
 *
 * @param prisma The database.
 * @param attempt The attempt.
 * @param result The broadcast outcome.
 * @param subject The audited entity and its id (an operation, or a compliance change in piece C).
 * @param at The time.
 */
export async function recordBroadcast(
  prisma: PrismaClient,
  attempt: ChainAttempt,
  result: BroadcastResult,
  subject: { readonly entity: AuditEntity; readonly id: string; readonly state: string },
  at: Date,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const status = result.kind === 'rejected' ? 'dropped' : 'sent';
    if (result.kind !== 'unknown') {
      // Only a still-unobserved attempt moves; the monitor's own observations are not overwritten.
      await tx.chainAttempt.updateMany({
        where: { id: attempt.id, status: { in: ['signed', 'sent', 'dropped'] } },
        data: { status, lastCheckedAt: at },
      });
    }
    if (result.kind !== 'sent') {
      await writeAudit(
        tx,
        auditEntryFor({
          entity: subject.entity,
          entityId: subject.id,
          fromState: subject.state,
          toState: subject.state,
          txHash: attempt.hash as TxHash,
          detail: `broadcast ${result.kind}: ${describeError(result.error)}`,
          at,
        }),
        { attemptId: attempt.id, nonce: attempt.nonce, broadcast: result.kind },
      );
    }
  });
}
