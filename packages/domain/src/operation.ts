/**
 * @file The lifecycle of an operation (deposit, withdrawal, transfer) as an explicit state machine,
 * plus the rule that decides what a reverted transaction means.
 *
 * Why a table and not ad-hoc `if`s: every money bug in a bridge like this is an operation reaching
 * a state it should not (settled twice, refunded after it settled). A single table of legal edges
 * is easy to review line by line, and everything not listed is refused with a typed error.
 *
 *   requested --RESERVE--> ledger_reserved --SUBMIT--> submitted --CONFIRM--> confirmed (terminal)
 *                               |                        |  ^
 *                               |                        +--+ SUBMIT (gas bump / resubmission)
 *                               +--------FAIL------------+--FAIL--> failed --REVERSE--> reversed (terminal)
 */

import { InvalidInputError, InvalidTransitionError } from './errors';
import type { Address } from './primitives';

/** What an operation does with money. */
export type OperationType = 'deposit' | 'withdrawal' | 'transfer';

/** Where an operation is in its lifecycle. */
export type OperationStatus =
  'requested' | 'ledger_reserved' | 'submitted' | 'confirmed' | 'failed' | 'reversed';

/** The events that move an operation between statuses. */
export type OperationEvent = 'RESERVE' | 'SUBMIT' | 'CONFIRM' | 'FAIL' | 'REVERSE';

/** The kind of journal entry an event writes. */
export type JournalKind = 'reserve' | 'settle' | 'reverse';

/**
 * Why an operation failed. Recorded on FAIL so a person can see at a glance what happened.
 * - `reverted`: mined and reverted for a reason other than the ones below.
 * - `dropped`: the node forgot the transaction and it could not be resubmitted.
 * - `compliance_rejected`: a party was not allowed (caught before sending or by the chain).
 * - `duplicate_reference`: the chain says the reference is used, but our index shows no event for
 *   it. On the token only a successful settlement consumes a reference, and it always emits an
 *   event, so this means our index is incomplete and the money most likely already moved.
 *   Decision: an escalation to a person, never reversed automatically (`mayReverse` refuses).
 * - `reference_conflict`: the chain shows a settling event for the reference that does NOT match
 *   the operation (kind, party or amount). Decision: the engine FAILs the operation with this
 *   reason so it is visible, and never reverses it (`mayReverse` refuses): a person decides.
 * - `retries_exhausted`: fee bumps or resubmissions ran out.
 * - `rejected`: refused before it was ever mined (by our own checks or by the node).
 */
export type FailureReason =
  | 'reverted'
  | 'dropped'
  | 'compliance_rejected'
  | 'duplicate_reference'
  | 'reference_conflict'
  | 'retries_exhausted'
  | 'rejected';

/**
 * The on-chain addresses an operation touches. A deposit mints to `to`; a withdrawal burns from
 * `from`; a transfer moves from `from` to `to`.
 */
export type OperationParties =
  | { readonly type: 'deposit'; readonly to: Address }
  | { readonly type: 'withdrawal'; readonly from: Address }
  | { readonly type: 'transfer'; readonly from: Address; readonly to: Address };

/** The only legal edges, keyed `status:event`. Anything absent is an invalid transition. */
export const OPERATION_TRANSITIONS: ReadonlyMap<string, OperationStatus> = new Map<
  string,
  OperationStatus
>([
  ['requested:RESERVE', 'ledger_reserved'],
  ['ledger_reserved:SUBMIT', 'submitted'],
  // Another attempt for the same operation: a fee-bump replacement or a resubmission after a drop.
  ['submitted:SUBMIT', 'submitted'],
  ['submitted:CONFIRM', 'confirmed'],
  // Refused before sending (e.g. compliance), or reverted / given up on after sending.
  ['ledger_reserved:FAIL', 'failed'],
  ['submitted:FAIL', 'failed'],
  ['failed:REVERSE', 'reversed'],
]);

/** Whether `event` is legal from `status`. */
export function canTransition(status: OperationStatus, event: OperationEvent): boolean {
  return OPERATION_TRANSITIONS.has(`${status}:${event}`);
}

/** The status after applying `event`. Throws `InvalidTransitionError` for an edge not in the table. */
export function transition(status: OperationStatus, event: OperationEvent): OperationStatus {
  const next = OPERATION_TRANSITIONS.get(`${status}:${event}`);
  if (next === undefined) {
    throw new InvalidTransitionError(status, event, 'operation');
  }
  return next;
}

/** Whether no event can move the operation any further (`confirmed`, `reversed`). */
export function isTerminal(status: OperationStatus): boolean {
  return status === 'confirmed' || status === 'reversed';
}

/**
 * The journal entry an event writes, or `null` for events that only change status.
 * Exactly three events touch the ledger: RESERVE locks funds, CONFIRM settles them, REVERSE
 * releases them. SUBMIT and FAIL write nothing, which is why a failed operation still holds its
 * funds until it is explicitly reversed.
 */
export function journalKindFor(event: OperationEvent): JournalKind | null {
  switch (event) {
    case 'RESERVE':
      return 'reserve';
    case 'CONFIRM':
      return 'settle';
    case 'REVERSE':
      return 'reverse';
    default:
      return null;
  }
}

/** The event that settles each operation type on chain. */
export const SETTLING_EVENT: Readonly<Record<OperationType, SettlingEventKind>> = Object.freeze({
  deposit: 'Minted',
  withdrawal: 'Burned',
  transfer: 'SettledTransfer',
});

/** The token events that settle an operation. */
export type SettlingEventKind = 'Minted' | 'Burned' | 'SettledTransfer';

/**
 * The fields of a settling event that are compared with an operation. Structurally a subset of the
 * chain package's `Minted` / `Burned` / `SettledTransfer` events, so those can be passed as they are.
 */
export type SettlingEventLike =
  | { readonly kind: 'Minted'; readonly to: Address; readonly amount: bigint }
  | { readonly kind: 'Burned'; readonly from: Address; readonly amount: bigint }
  | {
      readonly kind: 'SettledTransfer';
      readonly from: Address;
      readonly to: Address;
      readonly amount: bigint;
    };

/** The parts of an operation that its settling event must reproduce exactly. */
export interface SettlementExpectation {
  /** The operation type; decides which event kind settles it. */
  readonly type: OperationType;
  /** The amount in the token's smallest unit. */
  readonly amount: bigint;
  /** The on-chain parties; must agree with `type`. */
  readonly parties: OperationParties;
}

/** One field in which an observed settling event differs from its operation. */
export type SettlementDifference =
  | {
      readonly field: 'kind';
      readonly expected: SettlingEventKind;
      readonly observed: SettlingEventKind;
    }
  | { readonly field: 'amount'; readonly expected: bigint; readonly observed: bigint }
  | { readonly field: 'from' | 'to'; readonly expected: Address; readonly observed: Address };

/**
 * Throws `InvalidInputError` when an operation's `type` and `parties.type` disagree. Such an
 * operation has no well-defined settling event: comparing a deposit's type with a transfer's
 * parties could silently skip the `from` check and confirm the wrong event.
 */
function assertConsistentExpectation(op: SettlementExpectation): void {
  if (op.type !== op.parties.type) {
    throw new InvalidInputError(
      `operation type '${op.type}' disagrees with its parties type '${op.parties.type}'`,
    );
  }
}

/**
 * Every way `event` fails to settle `op`: wrong kind, wrong amount, wrong sender or recipient.
 * Empty means the event is exactly the settlement of this operation. A wrong kind is reported
 * alone: comparing the fields of a different kind of event would be meaningless.
 * Throws `InvalidInputError` when `op.type` and `op.parties.type` disagree.
 */
export function settlementDifferences(
  op: SettlementExpectation,
  event: SettlingEventLike,
): readonly SettlementDifference[] {
  assertConsistentExpectation(op);
  const expectedKind = SETTLING_EVENT[op.type];
  if (event.kind !== expectedKind) {
    return [{ field: 'kind', expected: expectedKind, observed: event.kind }];
  }
  const out: SettlementDifference[] = [];
  if (event.amount !== op.amount) {
    out.push({ field: 'amount', expected: op.amount, observed: event.amount });
  }
  const expected: { from?: Address; to?: Address } = op.parties;
  const observed: { from?: Address; to?: Address } = event;
  for (const field of ['from', 'to'] as const) {
    const exp = expected[field];
    const obs = observed[field];
    if (exp !== undefined && obs !== undefined && exp !== obs) {
      out.push({ field, expected: exp, observed: obs });
    }
  }
  return out;
}

/** What a reverted attempt means for its operation. Exactly one verdict. */
export type RevertResolution =
  /** The chain shows this operation's exact settlement: apply CONFIRM. */
  | { readonly verdict: 'confirm'; readonly event: 'CONFIRM' }
  /** A real failure: apply FAIL with `reason`. Reversal is still gated by `mayReverse`. */
  | { readonly verdict: 'failed'; readonly event: 'FAIL'; readonly reason: FailureReason }
  /**
   * The reference was consumed by an event that is NOT this operation's settlement. Never CONFIRM.
   * Decision: the engine applies FAIL with reason `reference_conflict` (so the operation is visibly
   * failed), never applies REVERSE (`mayReverse` refuses this reason), and escalates to a person.
   */
  | {
      readonly verdict: 'reference_conflict';
      readonly reason: 'reference_conflict';
      readonly differences: readonly SettlementDifference[];
    };

/** The contract error the token raises when a reference was already consumed. */
export const REFERENCE_ALREADY_USED = 'ReferenceAlreadyUsed';

/** The contract error the token raises when a party is not allowed by the registry. */
export const NOT_ALLOWED = 'NotAllowed';

/**
 * Decides what a reverted (and sufficiently confirmed) attempt means. The duplicate-submission rule.
 *
 * Every operation carries a single-use reference that the contract consumes. When two attempts for
 * the same operation both reach the chain (a resubmission after a "dropped" transaction that was in
 * fact mined, a replacement racing the original), the second reverts with `ReferenceAlreadyUsed`.
 * That revert is not a failure: the first attempt won and the operation settled. If we recorded it
 * as FAIL and then REVERSEd, the ledger would refund money that already moved on chain.
 *
 * But the contract stores only THAT a reference was used, not what for. So "some event carries this
 * reference" is not proof of settlement. The rule:
 *
 * - the event for the reference matches the operation exactly (kind for its type, every party, the
 *   amount): `confirm`, whatever this attempt reverted with. Decision: the chain is the record, so
 *   an exact settlement confirms even when this attempt failed for some other reason (e.g. it
 *   arrived after the first attempt settled and the sender had since been frozen);
 * - an event exists but differs in any of those: `reference_conflict`, never auto-resolved;
 * - no event: a real failure, classified by the revert reason (`ReferenceAlreadyUsed` without an
 *   event is `duplicate_reference`, `NotAllowed` is `compliance_rejected`, anything else `reverted`).
 *
 * Throws `InvalidInputError` when `op.type` and `op.parties.type` disagree, whichever branch runs.
 *
 * @param op The operation the attempt was for.
 * @param reason The decoded contract error name, or undefined when it could not be decoded.
 * @param observedEvent The settling-kind event on chain carrying this operation's reference, or null.
 */
export function resolveRevert(
  op: SettlementExpectation,
  reason: string | undefined,
  observedEvent: SettlingEventLike | null,
): RevertResolution {
  assertConsistentExpectation(op);
  if (observedEvent !== null) {
    const differences = settlementDifferences(op, observedEvent);
    if (differences.length === 0) {
      return { verdict: 'confirm', event: 'CONFIRM' };
    }
    return { verdict: 'reference_conflict', reason: 'reference_conflict', differences };
  }
  if (reason === REFERENCE_ALREADY_USED) {
    // The reference is consumed but by nothing we can see: never treat that as settled.
    return { verdict: 'failed', event: 'FAIL', reason: 'duplicate_reference' };
  }
  if (reason === NOT_ALLOWED) {
    return { verdict: 'failed', event: 'FAIL', reason: 'compliance_rejected' };
  }
  return { verdict: 'failed', event: 'FAIL', reason: 'reverted' };
}

/** Failure reasons that are escalations to a person and are never reversed automatically. */
export const ESCALATION_REASONS: ReadonlySet<FailureReason> = new Set<FailureReason>([
  'duplicate_reference',
  'reference_conflict',
]);

/**
 * Evidence needed before a failed operation may be reversed (its funds released). Each field is an
 * obligation on the engine, which must gather it from FINAL chain state, not from the head.
 */
export interface ReversalEvidence {
  /** Why the operation failed. Escalation reasons (see `ESCALATION_REASONS`) are never reversed. */
  readonly failureReason: FailureReason;
  /**
   * Whether any attempt for this operation could still be mined. The engine must compute it as
   * `attempts.some(a => attemptCanStillMine(a, observation, depth))` over EVERY signed attempt it
   * holds for the operation (see `confirmation.ts`). A transaction in some node's pool, or one whose
   * nonce use is not yet final, can still land.
   */
  readonly anAttemptCanStillMine: boolean;
  /** Whether the bridge's index shows any settling event carrying the operation's reference. */
  readonly chainHasEventForRef: boolean;
  /**
   * The contract's own `referenceUsed(ref)` flag, read at a FINAL block (`head - depth + 1`). This
   * is authoritative where the index may be incomplete: if it is true, something settled with this
   * reference, whatever the index shows.
   */
  readonly referenceConsumedOnChain: boolean;
}

/**
 * Whether REVERSE is safe. Reversing releases held funds back to the user; if the chain later (or
 * already) settles the same operation, the user is paid twice. So reversal requires ALL of:
 *
 * - the failure is not an escalation (`duplicate_reference`, `reference_conflict`): those mean the
 *   reference may already have settled, and a person must decide;
 * - no attempt can still land (each attempt's nonce use is final, or it has a final receipt);
 * - the index shows no settling event for the reference;
 * - the contract says, at a final block, that the reference was NOT consumed. Only a successful
 *   settlement consumes a reference, so a consumed one means the money moved even if the index
 *   missed the event.
 */
export function mayReverse(evidence: ReversalEvidence): boolean {
  return (
    !ESCALATION_REASONS.has(evidence.failureReason) &&
    !evidence.anAttemptCanStillMine &&
    !evidence.chainHasEventForRef &&
    !evidence.referenceConsumedOnChain
  );
}
