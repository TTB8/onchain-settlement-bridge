/**
 * @file The settlement submitter: the `OutboxHandler` for `settlement` outbox rows. It turns a
 * reserved operation into a signed, recorded and then broadcast transaction.
 *
 * One call of `handle`, in order (each step names the rule it serves):
 *
 * 1. Load the operation and its deployment; the deployment must be the one this engine's gateway
 *    talks to, else the row waits (`DeploymentMismatchError`, a retry): an operation is never
 *    sent to another contract than the one it was created for (ADR 0011, obligation 17).
 * 2. Idempotent per row (README requirement 3): if the row already has an attempt, rebroadcast
 *    THAT attempt (the same signed bytes, same nonce, same hash). A crash between the commit and
 *    the broadcast, a lease takeover, a retry after an unknown answer: all end up here.
 * 3. Otherwise, with the node's pending nonce and fee estimate read first (no network call holds
 *    a lock), ONE transaction: fence the outbox lease (the row FAIL/REVERSE cancel), lock
 *    `signer_state` and allocate the nonce, sign, insert the attempt, and apply SUBMIT `first`
 *    through `moveOperation` (fenced by the operation's version). Commit (obligation 1).
 * 4. Only after the commit, and right before sending: `signal` not aborted and `stillHolds()`
 *    true (README requirement 2). A handler that timed out may still be running; it must not send.
 * 5. Broadcast and sort the answer (ADR 0009): sent or "already known" is `done`; nonce already
 *    used is `done` (the monitor decides from receipts and the reference); an unknown outcome is
 *    THROWN so the dispatcher retries, which rebroadcasts the same bytes (never a fresh nonce);
 *    a definite refusal by this node is recorded on the attempt (kept, still counted) and the row
 *    is `failed`, while the operation stays `submitted` for the monitor.
 */

import type { ChainGateway, ContractCall } from '@bridge/chain';
import type { ChainAttempt, Operation, OutboxMessage, PrismaClient } from '@bridge/db';
import { FeeCapExceededError, initialFees } from '@bridge/domain';

import {
  broadcastAttempt,
  commitWithFreshNonce,
  contractCallFromJson,
  fenceOutboxLease,
  insertAttempt,
  recordBroadcast,
} from './attempts';
import type { AlarmSink } from './alarms';
import { InvalidRequestError, LeaseLostError, SignerMismatchError } from './errors';
import { moveOperation } from './move-operation';
import type { HandlerContext, OutboxHandler, OutboxOutcome } from './outbox-dispatcher';
import type { Clock } from './ports';
import { describeError, type SanitizeOptions } from './redact';
import {
  assertBound,
  assertSignerBound,
  bindingOf,
  type DeploymentBinding,
  signingExpectationFor,
} from './signer-binding';
import type { RawTransactionInspector } from './signing';
import type { TransactionOptions } from './transaction';

/** Fee settings for a first attempt. */
export interface InitialFeePolicy {
  /** Headroom on the max fee over the node's estimate, in basis points. */
  readonly marginBps: number;
  /** The highest `maxFeePerGas` the signer may pay; above it the row waits. */
  readonly feeCap: bigint;
  /** How long to wait before trying again when the estimate is above the cap, in ms. */
  readonly feeWaitMs: number;
}

/** Construction options for `SettlementSubmitter`. */
export interface SettlementSubmitterOptions {
  /** The database. */
  readonly prisma: PrismaClient;
  /** The chain: reads, signs (`signTransaction`), sends exact bytes (`sendRaw`). Its own
   * `deployment()` is the binding. */
  readonly gateway: ChainGateway;
  /** Decodes signed bytes so they are checked before they are stored. */
  readonly inspector: RawTransactionInspector;
  /** The time source. */
  readonly clock: Clock;
  /** First-attempt fees. */
  readonly fees: InitialFeePolicy;
  /** Transaction settings. */
  readonly transactions?: TransactionOptions;
  /** Literal secrets (RPC URL, API key, host) removed from every error text written. */
  readonly secrets?: readonly string[];
  /** Where alarms go (a signer mismatch). Default: nowhere but the row's wait. */
  readonly alarms?: AlarmSink;
}

/** Sends `settlement` outbox rows. See the file comment. */
export class SettlementSubmitter implements OutboxHandler {
  private readonly prisma: PrismaClient;
  private readonly gateway: ChainGateway;
  private readonly inspector: RawTransactionInspector;
  private readonly clock: Clock;
  private readonly binding: DeploymentBinding;
  private readonly fees: InitialFeePolicy;
  private readonly transactions: TransactionOptions;
  private readonly redaction: SanitizeOptions;
  private readonly alarms: AlarmSink | undefined;

  /** @param options Database, gateway, signer, clock, binding and fee policy. */
  constructor(options: SettlementSubmitterOptions) {
    this.prisma = options.prisma;
    this.gateway = options.gateway;
    this.inspector = options.inspector;
    this.clock = options.clock;
    this.binding = bindingOf(options.gateway);
    this.fees = options.fees;
    this.transactions = options.transactions ?? {};
    this.redaction = { secrets: [...(options.secrets ?? [])] };
    this.alarms = options.alarms;
  }

  /** @inheritdoc */
  async handle(row: OutboxMessage, context: HandlerContext): Promise<OutboxOutcome> {
    if (row.signer !== 'settlement' || row.operationId === null) {
      return { failed: 'not_a_settlement_row' };
    }
    const op = await this.prisma.operation.findUnique({
      where: { id: row.operationId },
      include: { deployment: true },
    });
    if (op === null) return { failed: 'operation_missing' };
    assertBound(op.deployment, this.binding);
    let call: ContractCall;
    try {
      call = contractCallFromJson(row.call);
    } catch (err) {
      return { failed: 'invalid_call', detail: describeError(err, this.redaction) };
    }
    if (call.ref !== op.ref || row.ref !== op.ref) return { failed: 'reference_mismatch' };

    const [existing] = await this.prisma.chainAttempt.findMany({
      where: { outboxId: row.id },
      // Newest = highest nonce, then most bumps (never by time alone: two attempts can share a
      // timestamp, and then an id order would pick an arbitrary one).
      orderBy: [{ nonce: 'desc' }, { bumpsSoFar: 'desc' }, { submittedAt: 'desc' }, { id: 'desc' }],
      take: 1,
    });
    if (existing !== undefined) {
      // Settled, failed or reversed since: nothing left to send for this row.
      if (op.status !== 'submitted') return 'done';
      return this.send(op, existing, call, context);
    }
    // Failed (or reversed) before anything was signed: nothing may ever be sent.
    if (op.status !== 'ledger_reserved') return 'done';

    // The gateway's key must be the deployment's recorded signer before any nonce is read or
    // anything signed (review M-1). A mismatch waits (and alarms); it never signs.
    try {
      await assertSignerBound(this.prisma, this.gateway, op.deploymentId, (detail) =>
        this.alarms?.raise({
          kind: 'signer_mismatch',
          detail,
          operationId: op.id,
          at: this.clock.now(),
        }),
      );
    } catch (err) {
      if (err instanceof SignerMismatchError) {
        return { retryAt: new Date(this.clock.now().getTime() + this.fees.feeWaitMs) };
      }
      throw err;
    }
    // Network reads first, outside the transaction: no lock is held across a node call.
    const signerAddress = this.gateway.signerAddress('settlement');
    const { pending } = await this.gateway.getNonce('settlement');
    const estimate = await this.gateway.estimateFees();
    let fees;
    try {
      fees = initialFees(estimate, { marginBps: this.fees.marginBps, cap: this.fees.feeCap });
    } catch (err) {
      if (err instanceof FeeCapExceededError) {
        return { retryAt: new Date(this.clock.now().getTime() + this.fees.feeWaitMs) };
      }
      throw err;
    }

    const expected = await signingExpectationFor(this.prisma, op.deployment, 'settlement');
    // Signed and verified OUTSIDE the lock, for the predicted nonce; committed only if the
    // locked allocation agrees (commitWithFreshNonce).
    const attempt = await commitWithFreshNonce({
      prisma: this.prisma,
      gateway: this.gateway,
      inspector: this.inspector,
      expected,
      allocation: {
        deploymentId: op.deploymentId,
        signer: 'settlement',
        signerAddress,
        chainPending: pending,
      },
      build: (nonce) => ({ signer: 'settlement', call, nonce, fees }),
      fence: (tx) => fenceOutboxLease(tx, row, this.clock.now()),
      commit: async (tx, request, signed) => {
        const at = this.clock.now();
        const inserted = await insertAttempt(tx, {
          deploymentId: op.deploymentId,
          outboxId: row.id,
          request,
          signed,
          contractAddress: op.deployment.tokenAddress,
          bumpsSoFar: 0,
          at,
        });
        await moveOperation(tx, {
          operationId: op.id,
          from: 'ledger_reserved',
          version: op.version,
          move: { event: 'SUBMIT', kind: 'first' },
          at,
          txHash: signed.hash,
          note: `first attempt signed with nonce ${request.nonce} and recorded before broadcast`,
        });
        return inserted;
      },
      transactions: this.transactions,
    });
    return this.send(op, attempt, call, context);
  }

  /** Broadcasts a recorded attempt, after the lease and abort checks (steps 4 and 5). */
  private async send(
    op: Operation,
    attempt: ChainAttempt,
    call: ContractCall,
    context: HandlerContext,
  ): Promise<OutboxOutcome> {
    if (context.signal.aborted) throw new LeaseLostError('handler time limit reached');
    if (!(await context.stillHolds())) {
      throw new LeaseLostError('lease lost before broadcast');
    }
    if (context.signal.aborted) throw new LeaseLostError('handler time limit reached');
    const result = await broadcastAttempt(this.gateway, attempt);
    await recordBroadcast(
      this.prisma,
      attempt,
      result,
      { entity: 'operation', id: op.id, state: 'submitted' },
      this.clock.now(),
      this.redaction,
    );
    switch (result.kind) {
      case 'sent':
      case 'nonce_used':
        return 'done';
      case 'rejected':
        return {
          failed: 'submission_rejected',
          detail: describeError(result.error, this.redaction),
        };
      case 'unknown':
        // Unknown outcome: retried by the dispatcher, which rebroadcasts these same bytes.
        throw result.error instanceof Error
          ? result.error
          : new InvalidRequestError('broadcast failed with a non-error value');
    }
  }
}
