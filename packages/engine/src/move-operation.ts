/**
 * @file The one way an existing operation changes status: `moveOperation`.
 *
 * Every status move in the engine goes through this function, so four rules hold everywhere:
 *
 * 1. The edge comes from the domain table (`transition`), or for the gated late settlement of a
 *    failed operation from `confirmLate` with a `confirm` judgement. An illegal edge is refused
 *    BEFORE any query runs: the caller passes the status and version it read, so the decision is
 *    pure and the database is only asked to apply it.
 * 2. The UPDATE writes `version = <read version> + 1` as a literal and matches on the read version
 *    and status. A writer working from a stale read changes nothing and gets `VersionConflictError`
 *    (and the database's own version guard refuses it even if this WHERE were wrong).
 * 3. The journal entry the event writes (`journalKindFor`: settle on CONFIRM, reverse on REVERSE)
 *    is built by the domain's `buildEntry` and written in the same transaction, after the status,
 *    because the database only accepts a settle entry once the operation is confirmed.
 * 4. An audit row is written in the same transaction.
 *
 * RESERVE is refused here: a reservation must read the balance under a row lock first, which only
 * `OperationService` does (ADR 0012 item 18).
 *
 * The function takes a transaction client and never opens its own transaction: the caller (piece B,
 * the submitter and the confirmer) adds its own writes, such as a chain attempt, to the same
 * transaction. `OperationService.move` wraps it for callers that need nothing else.
 */

import type { FailureReason as DbFailureReason } from '@bridge/db';
import {
  auditEntryFor,
  buildEntry,
  confirmLate,
  type FailureReason,
  journalKindFor,
  type JournalKind,
  type OperationStatus,
  type SettlementJudgement,
  transition,
  type TxHash,
} from '@bridge/domain';

import {
  fromDomainError,
  IllegalTransitionError,
  InvalidRequestError,
  OperationNotFoundError,
  VersionConflictError,
} from './errors';
import {
  fiatClearingId,
  ledgerOperationOf,
  loadUserLedgers,
  partiesOf,
  writeAudit,
  writeEntry,
} from './ledger-writes';
import type { Tx } from './transaction';

/** The status change to apply, with the evidence each kind of move needs. */
export type OperationMove =
  /** A chain attempt was sent (first send, fee bump or resubmission). */
  | { readonly event: 'SUBMIT' }
  /** The settling event is final; writes the settle entry. */
  | { readonly event: 'CONFIRM'; readonly confirmedBlock: bigint }
  /** The operation failed; funds stay held until a gated REVERSE. */
  | { readonly event: 'FAIL'; readonly reason: FailureReason }
  /** Release held funds; writes the reverse entry. The caller must have checked `mayReverse`. */
  | { readonly event: 'REVERSE' }
  /** Late settlement of a failed operation, only with a `confirm` judgement from `lateConfirmation`. */
  | {
      readonly event: 'CONFIRM_LATE';
      readonly judgement: SettlementJudgement;
      readonly confirmedBlock: bigint;
    };

/** What `moveOperation` needs: which operation, what the caller read, and what to apply. */
export interface MoveOperationInput {
  /** The operation id. */
  readonly operationId: string;
  /** The status the caller read. */
  readonly from: OperationStatus;
  /** The version the caller read. */
  readonly version: number;
  /** The move to apply. */
  readonly move: OperationMove;
  /** When it happened (from the injected clock). */
  readonly at: Date;
  /** The transaction involved, when there is one (goes to the audit row). */
  readonly txHash?: TxHash;
  /** A short human-readable note for the audit row (no secrets, no PII). */
  readonly note: string;
}

/** The operation after the move. */
export interface MovedOperation {
  /** The operation id. */
  readonly id: string;
  /** The new status. */
  readonly status: OperationStatus;
  /** The new version (`version + 1`). */
  readonly version: number;
  /** The journal entry written, if the move wrote one. */
  readonly entryKind: JournalKind | null;
}

/**
 * The status after `move` from `from`, decided by the domain alone. Throws
 * `IllegalTransitionError` for an edge the domain refuses (including a late confirmation without a
 * `confirm` judgement) and `InvalidRequestError` for a malformed move.
 *
 * @param from The current status.
 * @param move The move.
 */
export function nextStatus(from: OperationStatus, move: OperationMove): OperationStatus {
  const event: string = move.event;
  if (event === 'RESERVE') {
    throw new IllegalTransitionError(
      'RESERVE is not applied by moveOperation: reservations go through OperationService',
    );
  }
  if (move.event === 'CONFIRM' || move.event === 'CONFIRM_LATE') {
    if (typeof move.confirmedBlock !== 'bigint' || move.confirmedBlock < 0n) {
      throw new InvalidRequestError('confirmedBlock must be a non-negative bigint');
    }
  }
  if (move.event === 'FAIL' && (typeof move.reason !== 'string' || move.reason.length === 0)) {
    throw new InvalidRequestError('FAIL needs a failure reason');
  }
  try {
    if (move.event === 'CONFIRM_LATE') return confirmLate(from, move.judgement);
    return transition(from, move.event);
  } catch (err) {
    throw fromDomainError(err);
  }
}

function entryKindOf(move: OperationMove): JournalKind | null {
  return move.event === 'CONFIRM_LATE' ? 'settle' : journalKindFor(move.event);
}

/**
 * Applies one status move to one operation inside the caller's transaction. See the file comment
 * for the four rules it enforces. Throws `IllegalTransitionError` before touching the database for
 * an illegal edge, `VersionConflictError` when the operation is no longer at (`from`, `version`),
 * and `OperationNotFoundError` when it does not exist.
 *
 * @param tx The caller's transaction client.
 * @param input The operation, what the caller read, and the move.
 */
export async function moveOperation(tx: Tx, input: MoveOperationInput): Promise<MovedOperation> {
  if (!Number.isInteger(input.version) || input.version < 0) {
    throw new InvalidRequestError('version must be a non-negative integer');
  }
  const next = nextStatus(input.from, input.move);
  const newVersion = input.version + 1;
  const updated = await tx.operation.updateMany({
    where: { id: input.operationId, version: input.version, status: input.from },
    data: {
      status: next,
      // A literal computed from the caller's read, never `version + 1` in SQL (README of @bridge/db).
      version: newVersion,
      updatedAt: input.at,
      ...(input.move.event === 'FAIL'
        ? { failureReason: input.move.reason satisfies DbFailureReason }
        : {}),
      ...(next === 'confirmed' && 'confirmedBlock' in input.move
        ? { confirmedBlock: input.move.confirmedBlock }
        : {}),
    },
  });
  if (updated.count !== 1) {
    const exists = await tx.operation.findUnique({
      where: { id: input.operationId },
      select: { id: true },
    });
    if (exists === null) throw new OperationNotFoundError(`no operation ${input.operationId}`);
    throw new VersionConflictError(input.operationId, input.version);
  }

  const entryKind = entryKindOf(input.move);
  if (entryKind !== null) {
    const op = await tx.operation.findUniqueOrThrow({ where: { id: input.operationId } });
    const users = await loadUserLedgers(tx, partiesOf(op));
    const fiat = await fiatClearingId(tx);
    let entry;
    try {
      entry = buildEntry(ledgerOperationOf(op), entryKind);
    } catch (err) {
      throw fromDomainError(err);
    }
    await writeEntry(tx, entry, users, fiat, input.at);
  }

  const audit = auditEntryFor({
    entity: 'operation',
    entityId: input.operationId,
    fromState: input.from,
    toState: next,
    ...(input.txHash !== undefined ? { txHash: input.txHash } : {}),
    detail: input.note,
    at: input.at,
  });
  await writeAudit(tx, audit, {
    event: input.move.event,
    version: newVersion,
    failureReason: input.move.event === 'FAIL' ? input.move.reason : null,
  });
  return { id: input.operationId, status: next, version: newVersion, entryKind };
}
