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
 * The moves that can pay someone twice carry their evidence, and this function checks it itself
 * rather than trusting the caller to have done so (review M-3):
 * - CONFIRM and CONFIRM_LATE need a `SettlementJudgement` whose verdict is `confirm` (from the
 *   domain's `lateConfirmation` / `resolveRevert`); any other verdict is `EvidenceRefusedError`.
 * - REVERSE needs `ReversalEvidence`; the domain's `mayReverse` must accept it, and its
 *   `failureReason` must equal the reason stored on the row (matched in the UPDATE itself, so it
 *   is compared in this transaction).
 * - SUBMIT says what it is: `first` (ledger_reserved -> submitted), `bump` or `resubmit`
 *   (submitted -> submitted). A resubmit writes `resubmits_so_far = <read> + 1` as a literal,
 *   fenced like the version; nothing else in the engine touches that counter.
 *
 * Cancelling: a FAIL from `ledger_reserved` (nothing was ever sent) and every REVERSE kill the
 * operation's live outbox rows (pending or processing -> dead) in the same transaction, so no
 * worker can sign a new transaction for an operation whose funds are being released.
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
  mayReverse,
  type OperationStatus,
  type ReversalEvidence,
  type RevertResolution,
  type SettlementJudgement,
  transition,
  type TxHash,
} from '@bridge/domain';

import {
  EvidenceRefusedError,
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
import { sanitizeText } from './redact';
import type { Tx } from './transaction';

/** What kind of send a SUBMIT records. */
export type SubmitKind = 'first' | 'bump' | 'resubmit';

/** The status change to apply, with the evidence each kind of move needs. */
export type OperationMove =
  /** The first attempt was committed: ledger_reserved -> submitted. */
  | { readonly event: 'SUBMIT'; readonly kind: 'first' }
  /** A fee-bump replacement (same nonce): submitted -> submitted. */
  | { readonly event: 'SUBMIT'; readonly kind: 'bump' }
  /**
   * A resubmission after a drop (new nonce): submitted -> submitted, and
   * `resubmits_so_far = resubmitsSoFar + 1`. `resubmitsSoFar` is the value the caller read.
   */
  | { readonly event: 'SUBMIT'; readonly kind: 'resubmit'; readonly resubmitsSoFar: number }
  /** The settling event is final and matches: writes the settle entry. */
  | {
      readonly event: 'CONFIRM';
      readonly judgement: SettlementJudgement | RevertResolution;
      readonly confirmedBlock: bigint;
    }
  /** The operation failed; funds stay held until a REVERSE with evidence. */
  | { readonly event: 'FAIL'; readonly reason: FailureReason }
  /** Release held funds (writes the reverse entry), only if `mayReverse(evidence)`. */
  | { readonly event: 'REVERSE'; readonly evidence: ReversalEvidence }
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
  /** A short human-readable note for the audit row; sanitized (URLs, hosts) before it is written. */
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
  /** How many live outbox rows the move cancelled (FAIL from ledger_reserved, REVERSE). */
  readonly cancelledOutbox: number;
}

const SUBMIT_FROM: Readonly<Record<SubmitKind, OperationStatus>> = {
  first: 'ledger_reserved',
  bump: 'submitted',
  resubmit: 'submitted',
};

function assertConfirmJudgement(judgement: unknown): void {
  const j = judgement as { verdict?: unknown; event?: unknown } | null;
  if (typeof j !== 'object' || j === null || j.verdict !== 'confirm' || j.event !== 'CONFIRM') {
    throw new EvidenceRefusedError(
      `a confirmation needs a 'confirm' judgement, got ${JSON.stringify(j?.verdict ?? null)}`,
    );
  }
}

function assertReversalEvidence(e: unknown): asserts e is ReversalEvidence {
  const v = e as Partial<Record<keyof ReversalEvidence, unknown>> | null;
  if (
    typeof v !== 'object' ||
    v === null ||
    typeof v.failureReason !== 'string' ||
    typeof v.anAttemptCanStillMine !== 'boolean' ||
    typeof v.chainHasEventForRef !== 'boolean' ||
    typeof v.referenceConsumedOnChain !== 'boolean'
  ) {
    throw new InvalidRequestError('REVERSE needs complete ReversalEvidence');
  }
}

/**
 * The status after `move` from `from`, decided by the domain alone, with the move's evidence
 * checked. Pure: runs before any query. Throws `IllegalTransitionError` for an edge the domain
 * refuses, `EvidenceRefusedError` when the evidence does not allow the move, and
 * `InvalidRequestError` for a malformed move.
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
  switch (move.event) {
    case 'SUBMIT': {
      const expected = SUBMIT_FROM[move.kind];
      if (expected === undefined) {
        throw new InvalidRequestError(`unknown SUBMIT kind ${JSON.stringify(String(move.kind))}`);
      }
      if (move.kind === 'resubmit') {
        if (!Number.isInteger(move.resubmitsSoFar) || move.resubmitsSoFar < 0) {
          throw new InvalidRequestError('resubmitsSoFar must be a non-negative integer');
        }
      }
      if (from !== expected) {
        throw new IllegalTransitionError(
          `a '${move.kind}' SUBMIT is only legal from ${expected}, not ${from}`,
        );
      }
      break;
    }
    case 'CONFIRM':
    case 'CONFIRM_LATE':
      if (typeof move.confirmedBlock !== 'bigint' || move.confirmedBlock < 0n) {
        throw new InvalidRequestError('confirmedBlock must be a non-negative bigint');
      }
      break;
    case 'FAIL':
      if (typeof move.reason !== 'string' || move.reason.length === 0) {
        throw new InvalidRequestError('FAIL needs a failure reason');
      }
      break;
    case 'REVERSE':
      assertReversalEvidence(move.evidence);
      break;
  }
  let next: OperationStatus;
  try {
    next =
      move.event === 'CONFIRM_LATE'
        ? confirmLate(from, { verdict: 'confirm', event: 'CONFIRM' })
        : transition(from, move.event);
  } catch (err) {
    throw fromDomainError(err);
  }
  // Evidence is checked once the edge itself is known to exist.
  if (move.event === 'CONFIRM' || move.event === 'CONFIRM_LATE') {
    assertConfirmJudgement(move.judgement);
    if (move.event === 'CONFIRM_LATE') {
      // The domain's own gate, on the caller's actual judgement.
      try {
        confirmLate(from, move.judgement);
      } catch (err) {
        throw fromDomainError(err);
      }
    }
  }
  if (move.event === 'REVERSE' && !mayReverse(move.evidence)) {
    throw new EvidenceRefusedError(
      `mayReverse refused: reason ${move.evidence.failureReason}, ` +
        `attempt can still mine ${move.evidence.anAttemptCanStillMine}, ` +
        `event for ref ${move.evidence.chainHasEventForRef}, ` +
        `reference consumed ${move.evidence.referenceConsumedOnChain}`,
    );
  }
  return next;
}

function entryKindOf(move: OperationMove): JournalKind | null {
  return move.event === 'CONFIRM_LATE' ? 'settle' : journalKindFor(move.event);
}

/** Whether the move must kill the operation's live outbox rows. */
function cancelsOutbox(from: OperationStatus, next: OperationStatus): boolean {
  return (from === 'ledger_reserved' && next === 'failed') || next === 'reversed';
}

/**
 * Applies one status move to one operation inside the caller's transaction. See the file comment
 * for the rules it enforces. Throws `IllegalTransitionError` / `EvidenceRefusedError` /
 * `InvalidRequestError` before touching the database; `VersionConflictError` when the operation is
 * no longer at (`from`, `version`) (or, for a resubmit, at the read `resubmitsSoFar`);
 * `EvidenceRefusedError` when a REVERSE's `failureReason` is not the stored one; and
 * `OperationNotFoundError` when the operation does not exist.
 *
 * @param tx The caller's transaction client.
 * @param input The operation, what the caller read, and the move.
 */
export async function moveOperation(tx: Tx, input: MoveOperationInput): Promise<MovedOperation> {
  if (!Number.isInteger(input.version) || input.version < 0) {
    throw new InvalidRequestError('version must be a non-negative integer');
  }
  const { move } = input;
  const next = nextStatus(input.from, move);
  const newVersion = input.version + 1;
  const updated = await tx.operation.updateMany({
    where: {
      id: input.operationId,
      version: input.version,
      status: input.from,
      // The stored reason must be the one the evidence was gathered for.
      ...(move.event === 'REVERSE'
        ? { failureReason: move.evidence.failureReason satisfies DbFailureReason }
        : {}),
      ...(move.event === 'SUBMIT' && move.kind === 'resubmit'
        ? { resubmitsSoFar: move.resubmitsSoFar }
        : {}),
    },
    data: {
      status: next,
      // A literal computed from the caller's read, never `version + 1` in SQL (README of @bridge/db).
      version: newVersion,
      updatedAt: input.at,
      ...(move.event === 'FAIL' ? { failureReason: move.reason satisfies DbFailureReason } : {}),
      ...(next === 'confirmed' && 'confirmedBlock' in move
        ? { confirmedBlock: move.confirmedBlock }
        : {}),
      ...(move.event === 'SUBMIT' && move.kind === 'resubmit'
        ? { resubmitsSoFar: move.resubmitsSoFar + 1 }
        : {}),
    },
  });
  if (updated.count !== 1) {
    const row = await tx.operation.findUnique({
      where: { id: input.operationId },
      select: { version: true, status: true, failureReason: true },
    });
    if (row === null) throw new OperationNotFoundError(`no operation ${input.operationId}`);
    if (
      move.event === 'REVERSE' &&
      row.version === input.version &&
      row.status === input.from &&
      row.failureReason !== move.evidence.failureReason
    ) {
      throw new EvidenceRefusedError(
        `the evidence is for failure reason ${move.evidence.failureReason}, ` +
          `but the operation failed with ${String(row.failureReason)}`,
      );
    }
    throw new VersionConflictError(input.operationId, input.version);
  }

  const entryKind = entryKindOf(move);
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

  let cancelledOutbox = 0;
  if (cancelsOutbox(input.from, next)) {
    const cancelled = await tx.outboxMessage.updateMany({
      where: { operationId: input.operationId, status: { in: ['pending', 'processing'] } },
      data: {
        status: 'dead',
        lockedAt: null,
        lockedBy: null,
        processedAt: input.at,
        lastError: `cancelled: operation moved ${input.from} -> ${next}`,
        lastErrorAt: input.at,
      },
    });
    cancelledOutbox = cancelled.count;
  }

  const audit = auditEntryFor({
    entity: 'operation',
    entityId: input.operationId,
    fromState: input.from,
    toState: next,
    ...(input.txHash !== undefined ? { txHash: input.txHash } : {}),
    // The caller's note is free text: it may quote an error that carries a URL or a key.
    detail: sanitizeText(input.note),
    at: input.at,
  });
  await writeAudit(tx, audit, {
    event: move.event,
    version: newVersion,
    submitKind: move.event === 'SUBMIT' ? move.kind : null,
    failureReason: move.event === 'FAIL' ? move.reason : null,
    cancelledOutbox,
  });
  return { id: input.operationId, status: next, version: newVersion, entryKind, cancelledOutbox };
}
