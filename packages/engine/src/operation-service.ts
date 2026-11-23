/**
 * @file The operation service: turns a deposit, withdrawal or transfer request into a reserved
 * operation and its outbox row, in ONE database transaction.
 *
 * Inside that transaction, in this order (each step says which obligation it serves):
 *
 * 1. Find the ACTIVE deployment of the configured chain and check it is the configured token.
 *    No active deployment, or a different token, refuses the request (ADR 0011, ADR 0012 item 17).
 * 2. Load the parties' ledger accounts and wallets (unknown user: refused).
 * 3. Lock, with `lockRows` (ascending id order, so two requests cannot deadlock), every user
 *    account the reserve entry posts to. `fiat_clearing` is deliberately not locked: it is never
 *    checked for overdraft and locking it would serialise every deposit on the platform.
 * 4. Idempotency: if the key is taken, compare the stored operation with this request. Same
 *    content: return it and write nothing. Different content: `IdempotencyConflictError`. Checked
 *    AFTER the lock, so a concurrent duplicate waits for the first and then finds it.
 * 5. Read the available balance in the SAME transaction, under that lock (ADR 0012 item 18), and
 *    decide with the domain's `assertCanReserve`.
 * 6. Build the reserve entry with the domain's `buildEntry` and insert, together: the operation
 *    (status `ledger_reserved`, version 0, bound to the deployment), the entry and its postings,
 *    exactly one outbox row for the `settlement` signer carrying the contract call, and an audit
 *    row. All or nothing.
 *
 * The operation id is a fresh UUID and its on-chain reference is `referenceFromUuid(id)`: a
 * single-use bytes32 the contract consumes once (ADR 0003). The outbox row carries the same
 * reference, so re-sending it after a crash can never settle twice (ADR 0002).
 *
 * Serialization failures and deadlocks are retried a bounded number of times (`runTransaction`).
 */

import type { ContractCall } from '@bridge/chain';
import {
  bigintsToDecimal,
  lockRows,
  type Operation,
  type OperationStatus,
  Prisma,
  type PrismaClient,
  readBalances,
} from '@bridge/db';
import {
  assertCanReserve,
  assertPositiveAmount,
  auditEntryFor,
  buildEntry,
  type JournalEntry,
  type LedgerOperation,
  referenceFromUuid,
} from '@bridge/domain';

import {
  DeploymentMismatchError,
  fromDomainError,
  IdempotencyConflictError,
  InvalidRequestError,
  NoActiveDeploymentError,
  SelfTransferRequestError,
} from './errors';
import {
  accountIdFor,
  fiatClearingId,
  loadUserLedgers,
  type UserLedger,
  writeAudit,
  writeEntry,
} from './ledger-writes';
import { moveOperation, type MovedOperation, type MoveOperationInput } from './move-operation';
import type { Clock, IdSource } from './ports';
import { runTransaction, type TransactionOptions, type Tx } from './transaction';

/** A request to move money. Every request carries a caller-chosen idempotency key. */
export type OperationRequest =
  | {
      readonly type: 'deposit';
      readonly userId: string;
      readonly amount: bigint;
      readonly idempotencyKey: string;
    }
  | {
      readonly type: 'withdrawal';
      readonly userId: string;
      readonly amount: bigint;
      readonly idempotencyKey: string;
    }
  | {
      readonly type: 'transfer';
      readonly fromUserId: string;
      readonly toUserId: string;
      readonly amount: bigint;
      readonly idempotencyKey: string;
    };

/** An operation as the engine reports it, with the deployment it is bound to. */
export interface OperationRecord {
  /** The operation id (a UUID; also the source of `ref`). */
  readonly id: string;
  /** deposit, withdrawal or transfer. */
  readonly type: OperationRequest['type'];
  /** The current status. */
  readonly status: OperationStatus;
  /** The owner (deposit recipient, withdrawal owner, transfer sender). */
  readonly userId: string;
  /** The transfer recipient; null otherwise. */
  readonly counterpartyUserId: string | null;
  /** The amount in the token's smallest unit. */
  readonly amount: bigint;
  /** The single-use on-chain reference. */
  readonly ref: string;
  /** The caller's idempotency key. */
  readonly idempotencyKey: string | null;
  /** The optimistic-concurrency version (0 when created). */
  readonly version: number;
  /** The deployment the operation is bound to. */
  readonly deploymentId: string;
  /** That deployment's chain id. */
  readonly chainId: bigint;
  /** That deployment's token address. */
  readonly tokenAddress: string;
}

/** The result of a request. */
export interface OperationResult {
  /** The operation (new, or the existing one on a replay). */
  readonly operation: OperationRecord;
  /** True when the idempotency key already existed and nothing was written. */
  readonly replayed: boolean;
  /** How many transaction tries it took (1 unless a conflict was retried). */
  readonly attempts: number;
}

/** Construction options for `OperationService`. */
export interface OperationServiceOptions {
  /** The database. */
  readonly prisma: PrismaClient;
  /** The time source for every timestamp written. */
  readonly clock: Clock;
  /** The id source for new operations. */
  readonly ids: IdSource;
  /** The chain this engine settles on. */
  readonly chainId: bigint;
  /** The token address this engine expects to be active on that chain (lowercase hex). */
  readonly tokenAddress: string;
  /** Isolation level, retry bound and timeouts for each request. */
  readonly transactions?: TransactionOptions;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const MAX_KEY_LENGTH = 255;

/** Validates the request shape and returns the domain view of it (with the new operation id). */
function toLedgerOperation(req: OperationRequest, operationId: string): LedgerOperation {
  if (typeof req.idempotencyKey !== 'string' || req.idempotencyKey.length === 0) {
    throw new InvalidRequestError('idempotencyKey must be a non-empty string');
  }
  if (req.idempotencyKey.length > MAX_KEY_LENGTH) {
    throw new InvalidRequestError(`idempotencyKey must be at most ${MAX_KEY_LENGTH} characters`);
  }
  try {
    assertPositiveAmount(req.amount);
  } catch (err) {
    throw fromDomainError(err);
  }
  switch (req.type) {
    case 'deposit':
    case 'withdrawal':
      return { type: req.type, operationId, userId: req.userId, amount: req.amount };
    case 'transfer':
      if (req.fromUserId === req.toUserId) {
        throw new SelfTransferRequestError(`transfer from and to user ${req.fromUserId}`);
      }
      return {
        type: 'transfer',
        operationId,
        fromUserId: req.fromUserId,
        toUserId: req.toUserId,
        amount: req.amount,
      };
    default:
      throw new InvalidRequestError(
        `unknown operation type ${JSON.stringify(String((req as { type: unknown }).type))}`,
      );
  }
}

/** The user who owns the operation, and the recipient of a transfer. */
function partiesOfRequest(op: LedgerOperation): { owner: string; counterparty: string | null } {
  return op.type === 'transfer'
    ? { owner: op.fromUserId, counterparty: op.toUserId }
    : { owner: op.userId, counterparty: null };
}

/** The contract call that settles the operation on chain. */
function contractCallFor(
  op: LedgerOperation,
  users: ReadonlyMap<string, UserLedger>,
  ref: `0x${string}`,
): ContractCall {
  const wallet = (userId: string): `0x${string}` => {
    const u = users.get(userId);
    /* istanbul ignore next -- loadUserLedgers already refused a missing user. */
    if (u === undefined) throw new InvalidRequestError(`no wallet for user ${userId}`);
    return u.wallet;
  };
  switch (op.type) {
    case 'deposit':
      return { kind: 'mint', to: wallet(op.userId), amount: op.amount, ref };
    case 'withdrawal':
      return { kind: 'burn', from: wallet(op.userId), amount: op.amount, ref };
    case 'transfer':
      return {
        kind: 'settleTransfer',
        from: wallet(op.fromUserId),
        to: wallet(op.toUserId),
        amount: op.amount,
        ref,
      };
  }
}

/** The user accounts (never fiat_clearing) the entry posts to: exactly the rows to lock. */
function accountsToLock(
  entry: JournalEntry,
  users: ReadonlyMap<string, UserLedger>,
  fiatId: string,
): string[] {
  return entry.postings
    .filter((p) => p.account.kind !== 'fiat_clearing')
    .map((p) => accountIdFor(p.account, users, fiatId));
}

/** The deployment fields a request binds to. */
export interface BoundDeployment {
  /** The deployment id. */
  readonly id: string;
  /** Its chain id. */
  readonly chainId: bigint;
  /** Its token (lowercase hex). */
  readonly tokenAddress: string;
  /** Its compliance registry (lowercase hex). */
  readonly registryAddress: string;
}

/**
 * The active deployment of `chainId`, locked FOR SHARE until the transaction ends, or null.
 * A plain read is not enough: the foreign key from operation only takes FOR KEY SHARE, which does
 * not conflict with an UPDATE of `active`. Shared by every writer of new work (operations and
 * compliance changes), so a deactivation never commits alongside one (review M-1).
 *
 * @param tx The caller's transaction; the share lock is held until it ends.
 * @param chainId The chain.
 */
export async function lockActiveDeployment(
  tx: Tx,
  chainId: bigint,
): Promise<BoundDeployment | null> {
  const rows = await tx.$queryRaw<
    { id: string; chain_id: bigint; token_address: string; registry_address: string }[]
  >`
    SELECT id::text AS id, chain_id, token_address, registry_address
      FROM deployment
     WHERE chain_id = ${chainId} AND active
       FOR SHARE`;
  const row = rows[0];
  return row === undefined
    ? null
    : {
        id: row.id,
        chainId: BigInt(row.chain_id),
        tokenAddress: row.token_address,
        registryAddress: row.registry_address,
      };
}

/** Whether a stored operation is the same request as `op` (same type, parties and amount). */
function sameContent(stored: Operation, op: LedgerOperation): boolean {
  const { owner, counterparty } = partiesOfRequest(op);
  return (
    stored.type === op.type &&
    stored.userId === owner &&
    stored.counterpartyUserId === counterparty &&
    stored.amount === op.amount
  );
}

function isIdempotencyKeyRace(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(target)
    ? target.includes('idempotency_key')
    : String(target).includes('idempotency_key');
}

/**
 * Creates reserved operations (deposit, withdrawal, transfer) and moves existing ones. Framework
 * free: give it a Prisma client, a clock, an id source and the deployment it expects.
 */
export class OperationService {
  private readonly prisma: PrismaClient;
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly chainId: bigint;
  private readonly tokenAddress: string;
  private readonly transactions: TransactionOptions;

  /** @param options The database, clock, ids, expected deployment and transaction settings. */
  constructor(options: OperationServiceOptions) {
    if (typeof options.chainId !== 'bigint' || options.chainId <= 0n) {
      throw new InvalidRequestError('chainId must be a positive bigint');
    }
    if (!ADDRESS.test(options.tokenAddress)) {
      throw new InvalidRequestError('tokenAddress must be lowercase 0x + 40 hex');
    }
    this.prisma = options.prisma;
    this.clock = options.clock;
    this.ids = options.ids;
    this.chainId = options.chainId;
    this.tokenAddress = options.tokenAddress;
    this.transactions = options.transactions ?? {};
  }

  /** Requests a deposit (fiat received; mint on chain). See `request`. */
  requestDeposit(userId: string, amount: bigint, idempotencyKey: string): Promise<OperationResult> {
    return this.request({ type: 'deposit', userId, amount, idempotencyKey });
  }

  /** Requests a withdrawal (burn on chain; pay out fiat). See `request`. */
  requestWithdrawal(
    userId: string,
    amount: bigint,
    idempotencyKey: string,
  ): Promise<OperationResult> {
    return this.request({ type: 'withdrawal', userId, amount, idempotencyKey });
  }

  /** Requests a transfer between two users. See `request`. */
  requestTransfer(
    fromUserId: string,
    toUserId: string,
    amount: bigint,
    idempotencyKey: string,
  ): Promise<OperationResult> {
    return this.request({ type: 'transfer', fromUserId, toUserId, amount, idempotencyKey });
  }

  /**
   * Reserves funds for a request and enqueues its chain call, in one transaction (see the file
   * comment for the steps). Idempotent on (`owner`, `idempotencyKey`). Throws a typed `EngineError` for every
   * refusal: `InvalidRequestError`, `SelfTransferRequestError`, `UnknownUserError`,
   * `NoActiveDeploymentError`, `DeploymentMismatchError`, `IdempotencyConflictError`,
   * `InsufficientFundsError`, `RetriesExhaustedError`.
   *
   * @param req The request.
   */
  async request(req: OperationRequest): Promise<OperationResult> {
    const operationId = this.ids.uuid();
    const ledgerOp = toLedgerOperation(req, operationId);
    const ref = referenceFromUuid(operationId);
    const { owner, counterparty } = partiesOfRequest(ledgerOp);

    const { value, attempts } = await runTransaction(
      this.prisma,
      async (tx) => {
        const at = this.clock.now();
        // 1. The active deployment of the configured chain, and it must be the configured token.
        //    FOR SHARE holds the row until commit: a concurrent deactivation waits for us (and is
        //    then refused by the database because our operation is not final), or, if it got
        //    there first, we wait and then see the row as inactive. Never both commit (review M-1).
        const deployment = await lockActiveDeployment(tx, this.chainId);
        if (deployment === null) {
          throw new NoActiveDeploymentError(`no active deployment on chain ${this.chainId}`);
        }
        if (deployment.tokenAddress !== this.tokenAddress) {
          throw new DeploymentMismatchError(
            `chain ${this.chainId} has active token ${deployment.tokenAddress}, ` +
              `but this engine is configured for ${this.tokenAddress}`,
          );
        }

        // 2. Parties' accounts.
        const users = await loadUserLedgers(
          tx,
          counterparty === null ? [owner] : [owner, counterparty],
        );
        const fiatId = await fiatClearingId(tx);
        let entry: JournalEntry;
        try {
          entry = buildEntry(ledgerOp, 'reserve');
        } catch (err) {
          throw fromDomainError(err);
        }

        // 3. Lock the user accounts the entry posts to, in a stable order.
        await lockRows(tx, 'account', accountsToLock(entry, users, fiatId));

        // 4. Idempotency, after the lock: a concurrent duplicate has committed by now.
        const existing = await tx.operation.findUnique({
          // Scoped to the owner: another user's key never matches (and is never revealed).
          where: { userId_idempotencyKey: { userId: owner, idempotencyKey: req.idempotencyKey } },
          include: { deployment: true },
        });
        if (existing !== null) {
          if (!sameContent(existing, ledgerOp)) {
            throw new IdempotencyConflictError(existing.id);
          }
          return { operation: toRecord(existing, existing.deployment), replayed: true };
        }

        // 5. The balance, read in this transaction under the lock, and the domain's decision.
        const ownerLedger = users.get(owner);
        /* istanbul ignore next -- loadUserLedgers already refused a missing user. */
        if (ownerLedger === undefined) throw new InvalidRequestError(`no ledger for ${owner}`);
        const [row] = await readBalances(tx, { accountIds: [ownerLedger.available] });
        const available = row?.balance ?? 0n;
        try {
          assertCanReserve(available, ledgerOp.amount, ledgerOp.type);
        } catch (err) {
          throw fromDomainError(err);
        }

        // 6. Operation, entry, postings, outbox row, audit row.
        const created = await tx.operation.create({
          data: {
            id: operationId,
            deploymentId: deployment.id,
            type: ledgerOp.type,
            status: 'ledger_reserved',
            userId: owner,
            counterpartyUserId: counterparty,
            amount: ledgerOp.amount,
            ref,
            idempotencyKey: req.idempotencyKey,
            createdAt: at,
            updatedAt: at,
          },
        });
        await writeEntry(tx, entry, users, fiatId, at);
        const call = contractCallFor(ledgerOp, users, ref);
        await tx.outboxMessage.create({
          data: {
            deploymentId: deployment.id,
            signer: 'settlement',
            call: bigintsToDecimal(call) as Prisma.InputJsonObject,
            ref,
            operationId,
            availableAt: at,
            createdAt: at,
          },
        });
        await writeAudit(
          tx,
          auditEntryFor({
            entity: 'operation',
            entityId: operationId,
            fromState: null,
            toState: 'ledger_reserved',
            detail: `${ledgerOp.type} requested and reserved`,
            at,
          }),
          {
            type: ledgerOp.type,
            amount: ledgerOp.amount.toString(),
            ref,
            chainId: deployment.chainId.toString(),
            tokenAddress: deployment.tokenAddress,
            idempotencyKey: req.idempotencyKey,
          },
        );
        return { operation: toRecord(created, deployment), replayed: false };
      },
      this.transactions,
      // Two first-time requests with one key but different users lock different rows; the loser
      // hits the unique key at INSERT. The next try sees the winner and answers replay or conflict.
      isIdempotencyKeyRace,
    );
    return { ...value, attempts };
  }

  /**
   * Applies one status move (see `moveOperation`) in its own transaction, with the same retry
   * policy as requests. For callers that write nothing else alongside the move.
   *
   * @param input The operation, what the caller read, and the move.
   */
  async move(input: MoveOperationInput): Promise<MovedOperation> {
    const { value } = await runTransaction(
      this.prisma,
      (tx) => moveOperation(tx, input),
      this.transactions,
    );
    return value;
  }

  /**
   * Reads one operation with its deployment, or null.
   *
   * @param id The operation id.
   */
  async get(id: string): Promise<OperationRecord | null> {
    const op = await this.prisma.operation.findUnique({
      where: { id },
      include: { deployment: true },
    });
    return op === null ? null : toRecord(op, op.deployment);
  }
}

/** An operation row and its deployment as an `OperationRecord`. */
function toRecord(
  op: Operation,
  deployment: { id: string; chainId: bigint; tokenAddress: string },
): OperationRecord {
  return {
    id: op.id,
    type: op.type,
    status: op.status,
    userId: op.userId,
    counterpartyUserId: op.counterpartyUserId,
    amount: op.amount,
    ref: op.ref,
    idempotencyKey: op.idempotencyKey,
    version: op.version,
    deploymentId: deployment.id,
    chainId: deployment.chainId,
    tokenAddress: deployment.tokenAddress,
  };
}
