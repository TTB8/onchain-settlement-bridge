/**
 * @file The compliance service: turns an operator's allow / disallow / freeze / unfreeze request
 * into a `requested` compliance change and its outbox row, in ONE database transaction.
 *
 * Inside that transaction, in this order (the same discipline as `OperationService`):
 *
 * 1. The ACTIVE deployment of the bound chain, locked FOR SHARE until commit
 *    (`lockActiveDeployment`), which must be the bound token AND registry (ADR 0011, obligation
 *    17). A racing deactivation either waits for this request and is refused by the database (the
 *    change is in flight), or commits first and this request sees no active deployment.
 * 2. The user whose wallet is the address (`UnknownUserError` otherwise: a registry flag is only
 *    ever changed for an account the bridge can name).
 * 3. A transaction-scoped advisory lock on (requester, key), then idempotency: same key, same
 *    content (address, action, reason) returns the stored change and writes nothing; different
 *    content is `ComplianceIdempotencyConflictError` naming only the requester's own change. Two
 *    first-time copies serialise on the advisory lock; the unique index is the backstop (the race
 *    is retried and then answered as a replay).
 * 4. The change (`requested`, version 0, bound to the deployment, id = fresh UUID,
 *    `ref = referenceFromUuid(id)`: single use, ADR 0003), ONE outbox row for the `compliance`
 *    signer carrying the registry call (`setVerified` / `setFrozen` with that ref), and an audit
 *    row. All or nothing.
 *
 * The registry enforces nothing about the bridge's intent: the reconciler checks every registry
 * event against the changes recorded here (`knownComplianceChanges`), so a change made by anyone
 * else, or one that writes something else under a known reference, is a finding.
 */

import type { ContractCall } from '@bridge/chain';
import {
  bigintsToDecimal,
  type ComplianceAction,
  type ComplianceChange,
  type ComplianceChangeStatus,
  Prisma,
  type PrismaClient,
} from '@bridge/db';
import { auditEntryFor, flagChangeFor, referenceFromUuid } from '@bridge/domain';

import {
  ComplianceChangeNotFoundError,
  ComplianceIdempotencyConflictError,
  DeploymentMismatchError,
  InvalidRequestError,
  NoActiveDeploymentError,
  UnknownUserError,
} from './errors';
import { writeAudit } from './ledger-writes';
import { lockActiveDeployment } from './operation-service';
import type { Clock, IdSource } from './ports';
import type { DeploymentBinding } from './signer-binding';
import { runTransaction, type TransactionOptions } from './transaction';

/** What an operator asks for. `allow` / `disallow` set the registry's `verified` flag. */
export type ComplianceRequestKind = 'allow' | 'disallow' | 'freeze' | 'unfreeze';

/** The domain action each request makes. */
export const COMPLIANCE_ACTION_FOR: Readonly<Record<ComplianceRequestKind, ComplianceAction>> =
  Object.freeze({ allow: 'verify', disallow: 'unverify', freeze: 'freeze', unfreeze: 'unfreeze' });

/** One compliance request. */
export interface ComplianceRequest {
  /** The account whose flag changes (any case; normalised to lowercase). */
  readonly address: string;
  /** Why (shown in the audit trail; 1..500 characters; no PII). */
  readonly reason: string;
  /** The requester's idempotency key (1..255 characters). */
  readonly idempotencyKey: string;
  /** Who asks: an operator id (1..255 characters). The key is scoped to it. */
  readonly requestedBy: string;
}

/** A compliance change as the engine reports it. */
export interface ComplianceChangeRecord {
  /** The change id (a UUID; also the source of `ref`). */
  readonly id: string;
  /** The domain action. */
  readonly action: ComplianceAction;
  /** The account (lowercase). */
  readonly account: string;
  /** The user owning that account. */
  readonly userId: string;
  /** The single-use registry reference. */
  readonly ref: string;
  /** The current status. */
  readonly status: ComplianceChangeStatus;
  /** The optimistic-concurrency version. */
  readonly version: number;
  /** The block the registry applied it in, once confirmed. */
  readonly confirmedBlock: bigint | null;
  /** Who asked. */
  readonly requestedBy: string | null;
  /** Their key. */
  readonly idempotencyKey: string | null;
  /** Why. */
  readonly reason: string | null;
  /** The deployment it is bound to. */
  readonly deploymentId: string;
}

/** The result of a request. */
export interface ComplianceResult {
  /** The change (new, or the existing one on a replay). */
  readonly change: ComplianceChangeRecord;
  /** True when the key already existed and nothing was written. */
  readonly replayed: boolean;
  /** Transaction tries (1 unless a conflict was retried). */
  readonly attempts: number;
}

/** Construction options for `ComplianceService`. */
export interface ComplianceServiceOptions {
  /** The database. */
  readonly prisma: PrismaClient;
  /** The time source for every timestamp written. */
  readonly clock: Clock;
  /** The id source for new changes. */
  readonly ids: IdSource;
  /** The deployment this engine is bound to (the gateway's own, `bindingOf`). */
  readonly binding: DeploymentBinding;
  /** Isolation level, retry bound and timeouts. */
  readonly transactions?: TransactionOptions;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new InvalidRequestError(`${name} must be a string of 1..${max} characters`);
  }
  return value;
}

function isKeyRace(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(target)
    ? target.includes('idempotency_key')
    : String(target).includes('idempotency_key');
}

/** The registry call a change makes. */
export function registryCallFor(
  action: ComplianceAction,
  account: string,
  ref: string,
): ContractCall {
  const change = flagChangeFor(action);
  const a = account as `0x${string}`;
  const r = ref as `0x${string}`;
  return change.flag === 'verified'
    ? { kind: 'setVerified', account: a, verified: change.value, ref: r }
    : { kind: 'setFrozen', account: a, frozen: change.value, ref: r };
}

function toRecord(c: ComplianceChange, account: string): ComplianceChangeRecord {
  return {
    id: c.id,
    action: c.action,
    account,
    userId: c.userId,
    ref: c.ref,
    status: c.status,
    version: c.version,
    confirmedBlock: c.confirmedBlock,
    requestedBy: c.requestedBy,
    idempotencyKey: c.idempotencyKey,
    reason: c.reason,
    deploymentId: c.deploymentId,
  };
}

/** Creates compliance changes. See the file comment. */
export class ComplianceService {
  private readonly prisma: PrismaClient;
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly binding: DeploymentBinding;
  private readonly transactions: TransactionOptions;

  /** @param options Database, clock, ids, binding and transaction settings. */
  constructor(options: ComplianceServiceOptions) {
    this.prisma = options.prisma;
    this.clock = options.clock;
    this.ids = options.ids;
    this.binding = options.binding;
    this.transactions = options.transactions ?? {};
  }

  /** Sets `verified = true` for the address. See `request`. */
  requestAllow(req: ComplianceRequest): Promise<ComplianceResult> {
    return this.request('allow', req);
  }

  /** Sets `verified = false` for the address. See `request`. */
  requestDisallow(req: ComplianceRequest): Promise<ComplianceResult> {
    return this.request('disallow', req);
  }

  /** Sets `frozen = true` for the address. See `request`. */
  requestFreeze(req: ComplianceRequest): Promise<ComplianceResult> {
    return this.request('freeze', req);
  }

  /** Sets `frozen = false` for the address. See `request`. */
  requestUnfreeze(req: ComplianceRequest): Promise<ComplianceResult> {
    return this.request('unfreeze', req);
  }

  /**
   * Records a compliance change and enqueues its registry call, in one transaction (see the file
   * comment). Idempotent on (`requestedBy`, `idempotencyKey`). Throws `InvalidRequestError`,
   * `NoActiveDeploymentError`, `DeploymentMismatchError`, `UnknownUserError`,
   * `ComplianceIdempotencyConflictError`, `RetriesExhaustedError`.
   *
   * @param kind allow, disallow, freeze or unfreeze.
   * @param req The address, reason, key and requester.
   */
  async request(kind: ComplianceRequestKind, req: ComplianceRequest): Promise<ComplianceResult> {
    if (!Object.prototype.hasOwnProperty.call(COMPLIANCE_ACTION_FOR, kind)) {
      throw new InvalidRequestError(`unknown compliance request '${String(kind)}'`);
    }
    const action = COMPLIANCE_ACTION_FOR[kind];
    const address = typeof req.address === 'string' ? req.address.toLowerCase() : '';
    if (!ADDRESS.test(address)) throw new InvalidRequestError('address must be 0x + 40 hex');
    const reason = text(req.reason, 'reason', 500);
    const key = text(req.idempotencyKey, 'idempotencyKey', 255);
    const requestedBy = text(req.requestedBy, 'requestedBy', 255);
    const changeId = this.ids.uuid();
    const ref = referenceFromUuid(changeId);

    const { value, attempts } = await runTransaction(
      this.prisma,
      async (tx) => {
        const at = this.clock.now();
        // 1. The active deployment, held FOR SHARE until commit, must be the bound one.
        const deployment = await lockActiveDeployment(tx, this.binding.chainId);
        if (deployment === null) {
          throw new NoActiveDeploymentError(
            `no active deployment on chain ${this.binding.chainId}`,
          );
        }
        if (
          deployment.tokenAddress !== this.binding.tokenAddress ||
          deployment.registryAddress !== this.binding.registryAddress
        ) {
          throw new DeploymentMismatchError(
            `chain ${this.binding.chainId} has active ${deployment.tokenAddress} / ` +
              `${deployment.registryAddress}, this engine is bound to ` +
              `${this.binding.tokenAddress} / ${this.binding.registryAddress}`,
          );
        }
        // 2. The account's user.
        const user = await tx.user.findUnique({
          where: { walletAddress: address },
          select: { id: true },
        });
        if (user === null) throw new UnknownUserError(`no user has wallet ${address}`);
        // 3. Idempotency under a per-(requester, key) lock.
        const lockKey = `compliance:${requestedBy}:${key}`;
        // `void` cannot be deserialised: select a constant over the lock call (as the indexer does).
        await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))) AS l`;
        const existing = await tx.complianceChange.findUnique({
          where: { requestedBy_idempotencyKey: { requestedBy, idempotencyKey: key } },
          include: { user: { select: { walletAddress: true } } },
        });
        if (existing !== null) {
          if (
            existing.userId !== user.id ||
            existing.action !== action ||
            existing.reason !== reason
          ) {
            throw new ComplianceIdempotencyConflictError(existing.id);
          }
          return { change: toRecord(existing, existing.user.walletAddress), replayed: true };
        }
        // 4. Change, outbox row, audit row.
        const created = await tx.complianceChange.create({
          data: {
            id: changeId,
            deploymentId: deployment.id,
            userId: user.id,
            action,
            ref,
            status: 'requested',
            requestedBy,
            idempotencyKey: key,
            reason,
            createdAt: at,
            updatedAt: at,
          },
        });
        await tx.outboxMessage.create({
          data: {
            deploymentId: deployment.id,
            signer: 'compliance',
            call: bigintsToDecimal(registryCallFor(action, address, ref)) as Prisma.InputJsonObject,
            ref,
            complianceChangeId: changeId,
            availableAt: at,
            createdAt: at,
          },
        });
        await writeAudit(
          tx,
          auditEntryFor({
            entity: 'compliance_change',
            entityId: changeId,
            fromState: null,
            toState: 'requested',
            detail: `${kind} requested: ${reason}`,
            at,
          }),
          {
            action,
            account: address,
            ref,
            requestedBy,
            registryAddress: deployment.registryAddress,
            chainId: deployment.chainId.toString(),
          },
        );
        return { change: toRecord(created, address), replayed: false };
      },
      this.transactions,
      isKeyRace,
    );
    return { ...value, attempts };
  }

  /**
   * One compliance change, or `ComplianceChangeNotFoundError`.
   *
   * @param id The change id.
   */
  async get(id: string): Promise<ComplianceChangeRecord> {
    const c = await this.prisma.complianceChange.findUnique({
      where: { id },
      include: { user: { select: { walletAddress: true } } },
    });
    if (c === null) throw new ComplianceChangeNotFoundError(`no compliance change ${id}`);
    return toRecord(c, c.user.walletAddress);
  }
}
