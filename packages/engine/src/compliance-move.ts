/**
 * @file The single way a compliance change changes status: `moveComplianceChange(tx, input)`.
 * The compliance twin of `moveOperation`, with the domain's compliance table in charge.
 *
 * Before any query, the domain decides: `transitionComplianceChange` for SUBMIT / CONFIRM / FAIL,
 * and, for a change that already FAILED, only `confirmComplianceChangeLate` (obligation 8). A
 * CONFIRM or CONFIRM_LATE must carry a `confirm` judgement from `judgeComplianceEvent` (a FINAL
 * registry event on a canonical block that matches the change exactly, its reference included);
 * anything else is `EvidenceRefusedError`. There is no reversal: a compliance change moves no
 * funds, and the domain table has no edge out of `confirmed` (a later change is a new request).
 *
 * The update is fenced on what the caller read (`WHERE id AND version AND status`, plus the
 * resubmission counter for a counted resubmit) and writes `version + 1` as a literal; zero rows is
 * `ComplianceVersionConflictError`. A FAIL from `requested` (nothing was ever signed) also kills
 * the change's live outbox row in the same transaction, so nothing is signed afterwards. Every
 * move appends an audit row.
 */

import type { TxHash } from '@bridge/chain';
import type { ComplianceChangeStatus, FailureReason } from '@bridge/db';
import {
  auditEntryFor,
  type ComplianceEventJudgement,
  confirmComplianceChangeLate,
  InvalidTransitionError,
  transitionComplianceChange,
} from '@bridge/domain';

import {
  ComplianceVersionConflictError,
  EvidenceRefusedError,
  IllegalTransitionError,
} from './errors';
import { writeAudit } from './ledger-writes';
import type { Tx } from './transaction';

/** A compliance move and the evidence it needs. */
export type ComplianceMove =
  /** The first attempt was recorded (from `requested`). */
  | { readonly event: 'SUBMIT'; readonly kind: 'first' }
  /** A fee-bump replacement with the same nonce (from `submitted`). */
  | { readonly event: 'SUBMIT'; readonly kind: 'bump' }
  /** A counted rebroadcast or new-nonce resubmission (from `submitted`), fenced on the counter. */
  | { readonly event: 'SUBMIT'; readonly kind: 'resubmit'; readonly resubmitsSoFar: number }
  /** Applied on chain: the judgement of `judgeComplianceEvent`, and the EVENT's block. */
  | {
      readonly event: 'CONFIRM';
      readonly judgement: ComplianceEventJudgement;
      readonly confirmedBlock: bigint;
    }
  /** A failed change that landed after all, through the gated late path only. */
  | {
      readonly event: 'CONFIRM_LATE';
      readonly judgement: ComplianceEventJudgement;
      readonly confirmedBlock: bigint;
    }
  /** Refused or given up, with why. */
  | { readonly event: 'FAIL'; readonly reason: FailureReason };

/** What `moveComplianceChange` needs. */
export interface MoveComplianceInput {
  /** The compliance change. */
  readonly changeId: string;
  /** The status the caller read. */
  readonly from: ComplianceChangeStatus;
  /** The version the caller read. */
  readonly version: number;
  /** The move. */
  readonly move: ComplianceMove;
  /** When (from the injected clock). */
  readonly at: Date;
  /** Why, for the audit row (no secrets, no PII). */
  readonly note: string;
  /** The transaction concerned, when there is one. */
  readonly txHash?: TxHash;
}

/** The change after a move. */
export interface MovedComplianceChange {
  /** The change. */
  readonly id: string;
  /** Its new status. */
  readonly status: ComplianceChangeStatus;
  /** Its new version. */
  readonly version: number;
}

function requireConfirm(judgement: ComplianceEventJudgement): void {
  if (judgement.verdict !== 'confirm') {
    throw new EvidenceRefusedError(
      `a compliance confirmation needs a 'confirm' judgement, got '${judgement.verdict}'`,
    );
  }
}

/** The domain's verdict on the move, before any query. Throws typed engine errors. */
function nextStatus(from: ComplianceChangeStatus, move: ComplianceMove): ComplianceChangeStatus {
  try {
    switch (move.event) {
      case 'SUBMIT':
        if ((move.kind === 'first') !== (from === 'requested')) {
          throw new IllegalTransitionError(
            `SUBMIT ${move.kind} is not legal from compliance status ${from}`,
          );
        }
        return transitionComplianceChange(from, 'SUBMIT');
      case 'CONFIRM':
        requireConfirm(move.judgement);
        return transitionComplianceChange(from, 'CONFIRM');
      case 'CONFIRM_LATE':
        requireConfirm(move.judgement);
        return confirmComplianceChangeLate(from, move.judgement);
      case 'FAIL':
        return transitionComplianceChange(from, 'FAIL');
    }
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      throw new IllegalTransitionError(err.message, { cause: err });
    }
    throw err;
  }
}

/**
 * Applies one compliance move in the caller's transaction (see the file comment). Throws
 * `IllegalTransitionError`, `EvidenceRefusedError` (both before any query) or
 * `ComplianceVersionConflictError`.
 *
 * @param tx The caller's transaction (an attempt may be inserted in the same commit).
 * @param input What the caller read, the move and its evidence.
 */
export async function moveComplianceChange(
  tx: Tx,
  input: MoveComplianceInput,
): Promise<MovedComplianceChange> {
  const { move } = input;
  const status = nextStatus(input.from, move);
  const counted = move.event === 'SUBMIT' && move.kind === 'resubmit';
  const r = await tx.complianceChange.updateMany({
    where: {
      id: input.changeId,
      version: input.version,
      status: input.from,
      ...(counted ? { resubmitsSoFar: move.resubmitsSoFar } : {}),
    },
    data: {
      status,
      version: input.version + 1,
      updatedAt: input.at,
      ...(counted ? { resubmitsSoFar: move.resubmitsSoFar + 1 } : {}),
      ...(move.event === 'CONFIRM' || move.event === 'CONFIRM_LATE'
        ? { confirmedBlock: move.confirmedBlock }
        : {}),
      ...(move.event === 'FAIL' ? { failureReason: move.reason } : {}),
    },
  });
  if (r.count !== 1) throw new ComplianceVersionConflictError(input.changeId, input.version);
  if (move.event === 'FAIL' && input.from === 'requested') {
    // Nothing was ever signed for it: nothing may be signed afterwards either.
    await tx.outboxMessage.updateMany({
      where: { complianceChangeId: input.changeId, status: { in: ['pending', 'processing'] } },
      data: {
        status: 'dead',
        lockedAt: null,
        lockedBy: null,
        processedAt: input.at,
        lastError: `cancelled: compliance change failed (${move.reason}) before anything was signed`,
        lastErrorAt: input.at,
      },
    });
  }
  await writeAudit(
    tx,
    auditEntryFor({
      entity: 'compliance_change',
      entityId: input.changeId,
      fromState: input.from,
      toState: status,
      ...(input.txHash !== undefined ? { txHash: input.txHash } : {}),
      detail: input.note,
      at: input.at,
    }),
    {
      event: move.event,
      ...(move.event === 'SUBMIT' ? { kind: move.kind } : {}),
      ...(move.event === 'FAIL' ? { failureReason: move.reason } : {}),
      ...(move.event === 'CONFIRM' || move.event === 'CONFIRM_LATE'
        ? { confirmedBlock: move.confirmedBlock.toString() }
        : {}),
    },
  );
  return { id: input.changeId, status, version: input.version + 1 };
}
