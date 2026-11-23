/**
 * @file Who may transact, the lifecycle of a compliance change, and what to do with an in-flight
 * operation when a party becomes frozen or unverified while it is running.
 *
 * The chain's registry is the enforcer: the token refuses to move funds for an address that is not
 * verified or is frozen. These checks exist so the bridge refuses EARLY (before reserving funds or
 * spending gas) and so it agrees with the chain about why something failed. Missing state is
 * treated as "not allowed": a check that cannot see its input must fail closed.
 */

import { type Finality, isFinal } from './confirmation';
import {
  type ComplianceParty,
  ComplianceRejectedError,
  type ComplianceViolation,
  InvalidInputError,
  InvalidTransitionError,
} from './errors';
import type { FailureReason, OperationParties, OperationStatus } from './operation';
import type { Address } from './primitives';

/** An address's standing in the registry. */
export interface ComplianceState {
  /** Passed identity checks. */
  readonly verified: boolean;
  /** Blocked by an operator, regardless of verification. */
  readonly frozen: boolean;
}

/** Where to look up an address's current standing. A missing entry means "unknown". */
export type ComplianceLookup = ReadonlyMap<Address, ComplianceState>;

/** Whether an address in this state may send or receive the token: verified and not frozen. */
export function canTransact(state: ComplianceState): boolean {
  return state.verified && !state.frozen;
}

/** Each party of an operation with its role, in a fixed order: the paying side first. */
function partiesOf(
  parties: OperationParties,
): ReadonlyArray<{ party: ComplianceParty; address: Address }> {
  switch (parties.type) {
    case 'deposit':
      return [{ party: 'recipient', address: parties.to }];
    case 'withdrawal':
      return [{ party: 'owner', address: parties.from }];
    case 'transfer':
      return [
        { party: 'sender', address: parties.from },
        { party: 'recipient', address: parties.to },
      ];
  }
}

/** Every party of the operation that may not transact right now, in a fixed order. */
export function complianceViolations(
  parties: OperationParties,
  states: ComplianceLookup,
): readonly ComplianceViolation[] {
  const violations: ComplianceViolation[] = [];
  for (const { party, address } of partiesOf(parties)) {
    const state = states.get(address);
    if (state === undefined) {
      violations.push({ party, address, reason: 'unknown' });
    } else if (state.frozen) {
      violations.push({ party, address, reason: 'frozen' });
    } else if (!state.verified) {
      violations.push({ party, address, reason: 'not_verified' });
    }
  }
  return violations;
}

/**
 * Throws `ComplianceRejectedError`, naming every failing party, unless all parties may transact:
 * a deposit's recipient, a withdrawal's owner, or both sides of a transfer. Run before RESERVE.
 */
export function assertCanStart(parties: OperationParties, states: ComplianceLookup): void {
  const violations = complianceViolations(parties, states);
  if (violations.length > 0) {
    throw new ComplianceRejectedError(violations);
  }
}

/** The statuses of an operation that has reserved funds but not finished. */
export type InFlightStatus = Extract<OperationStatus, 'ledger_reserved' | 'submitted'>;

/** What to do with an in-flight operation given the parties' current standing. */
export type InFlightComplianceVerdict =
  | { readonly action: 'proceed' }
  /** Not yet sent: FAIL it now with `compliance_rejected` rather than spend gas on a sure revert. */
  | {
      readonly action: 'abandon';
      readonly event: 'FAIL';
      readonly reason: Extract<FailureReason, 'compliance_rejected'>;
      readonly violations: readonly ComplianceViolation[];
    }
  /**
   * Already sent: it cannot be recalled. Keep driving the existing attempt to a receipt (its nonce
   * must still be consumed); the chain will revert it with `NotAllowed` unless it was mined before
   * the change, and `resolveRevert` turns that revert into FAIL `compliance_rejected`. Do not send
   * fee bumps for it beyond what is needed to clear the nonce.
   */
  | { readonly action: 'chain_will_reject'; readonly violations: readonly ComplianceViolation[] };

/**
 * The "frozen address mid-operation" rule. Given an in-flight operation and the parties' current
 * standing, say whether it may proceed, must be abandoned before sending, or is already out and
 * will be rejected by the chain. Throws `InvalidInputError` for a status that is not in flight.
 */
export function inFlightComplianceCheck(
  status: InFlightStatus,
  parties: OperationParties,
  states: ComplianceLookup,
): InFlightComplianceVerdict {
  if (status !== 'ledger_reserved' && status !== 'submitted') {
    throw new InvalidInputError(`operation in status '${String(status)}' is not in flight`);
  }
  const violations = complianceViolations(parties, states);
  if (violations.length === 0) return { action: 'proceed' };
  if (status === 'ledger_reserved') {
    return { action: 'abandon', event: 'FAIL', reason: 'compliance_rejected', violations };
  }
  return { action: 'chain_will_reject', violations };
}

/** An operator's request to change an address's standing. */
export type ComplianceAction = 'verify' | 'unverify' | 'freeze' | 'unfreeze';

/** The on-chain flag change an action makes: which registry setter, and the value it writes. */
export interface ComplianceFlagChange {
  /** `verified` maps to `setVerified`, `frozen` to `setFrozen`. */
  readonly flag: 'verified' | 'frozen';
  /** The value written. */
  readonly value: boolean;
}

/** The flag change each action makes. */
export const COMPLIANCE_FLAG_CHANGES: Readonly<Record<ComplianceAction, ComplianceFlagChange>> =
  Object.freeze({
    verify: Object.freeze({ flag: 'verified', value: true }),
    unverify: Object.freeze({ flag: 'verified', value: false }),
    freeze: Object.freeze({ flag: 'frozen', value: true }),
    unfreeze: Object.freeze({ flag: 'frozen', value: false }),
  });

/** The on-chain flag change for an action. Throws `InvalidInputError` for an unknown action. */
export function flagChangeFor(action: ComplianceAction): ComplianceFlagChange {
  if (!Object.prototype.hasOwnProperty.call(COMPLIANCE_FLAG_CHANGES, action)) {
    throw new InvalidInputError(`unknown compliance action '${String(action)}'`);
  }
  return COMPLIANCE_FLAG_CHANGES[action];
}

/** The standing after an action is applied; used to compute expected flags for reconciliation. */
export function applyComplianceAction(
  state: ComplianceState,
  action: ComplianceAction,
): ComplianceState {
  const change = flagChangeFor(action);
  return change.flag === 'verified'
    ? { verified: change.value, frozen: state.frozen }
    : { verified: state.verified, frozen: change.value };
}

/** Where a compliance change is in its lifecycle. */
export type ComplianceChangeStatus = 'requested' | 'submitted' | 'confirmed' | 'failed';

/** The events that move a compliance change. */
export type ComplianceChangeEvent = 'SUBMIT' | 'CONFIRM' | 'FAIL';

/**
 * The only legal edges of a compliance change, keyed `status:event`.
 *
 *   requested --SUBMIT--> submitted --CONFIRM--> confirmed (terminal)
 *       |                  |  ^                      ^
 *       |                  +--+ SUBMIT (re-attempt)  | CONFIRM (late, gated)
 *       +------FAIL------> failed -------------------+
 *                  submitted --FAIL--^
 *
 * `requested:FAIL` covers a change refused before it is ever sent. `failed:CONFIRM` covers an
 * attempt that landed after the engine gave up; it is GATED: apply it only when
 * `judgeComplianceEvent` returns `confirm` (a final event whose content matches the change).
 */
export const COMPLIANCE_CHANGE_TRANSITIONS: ReadonlyMap<string, ComplianceChangeStatus> = new Map<
  string,
  ComplianceChangeStatus
>([
  ['requested:SUBMIT', 'submitted'],
  ['requested:FAIL', 'failed'],
  // Another attempt: a fee-bump replacement or a resubmission after a drop.
  ['submitted:SUBMIT', 'submitted'],
  ['submitted:CONFIRM', 'confirmed'],
  ['submitted:FAIL', 'failed'],
  // Late confirmation of a failed change. Gated: only on judgeComplianceEvent(...) === confirm.
  ['failed:CONFIRM', 'confirmed'],
]);

/** The status after applying `event`. Throws `InvalidTransitionError` for an edge not in the table. */
export function transitionComplianceChange(
  status: ComplianceChangeStatus,
  event: ComplianceChangeEvent,
): ComplianceChangeStatus {
  const next = COMPLIANCE_CHANGE_TRANSITIONS.get(`${status}:${event}`);
  if (next === undefined) {
    throw new InvalidTransitionError(status, event, 'compliance_change');
  }
  return next;
}

/**
 * What a compliance change writes on chain: which account, which flag, which value. This is also
 * what the bridge remembers per reference, so reconciliation can check every registry event.
 */
export interface ComplianceChangeContent {
  /** The account whose flag changes. */
  readonly account: Address;
  /** Which registry flag. */
  readonly flag: ComplianceFlagChange['flag'];
  /** The value written. */
  readonly value: boolean;
}

/** The fields of a registry event that are compared with a change. Matches the chain's events. */
export type ComplianceEventLike = { readonly blockNumber: bigint } & (
  | { readonly kind: 'VerificationSet'; readonly account: Address; readonly verified: boolean }
  | { readonly kind: 'FrozenSet'; readonly account: Address; readonly frozen: boolean }
);

/** The change a registry event records: `VerificationSet` sets `verified`, `FrozenSet` sets `frozen`. */
export function complianceEventContent(event: ComplianceEventLike): ComplianceChangeContent {
  return event.kind === 'VerificationSet'
    ? { account: event.account, flag: 'verified', value: event.verified }
    : { account: event.account, flag: 'frozen', value: event.frozen };
}

/**
 * Whether a registry event is exactly the given change: the event kind's flag, the account and the
 * value all match. A known reference used for another account (a front-run) does not match.
 */
export function complianceEventMatches(
  change: ComplianceChangeContent,
  event: ComplianceEventLike,
): boolean {
  const observed = complianceEventContent(event);
  return (
    observed.flag === change.flag &&
    observed.account === change.account &&
    observed.value === change.value
  );
}

/** The verdict on a registry event for a compliance change. */
export type ComplianceEventJudgement =
  | { readonly verdict: 'confirm'; readonly event: 'CONFIRM' }
  | { readonly verdict: 'wait' }
  | { readonly verdict: 'conflict' };

/**
 * Judges a registry event carrying a change's reference: `wait` until it is final, then `confirm`
 * if it matches the change exactly, else `conflict` (a person decides). The only evidence on which
 * the engine may apply `submitted:CONFIRM` or the gated `failed:CONFIRM`.
 */
export function judgeComplianceEvent(
  change: ComplianceChangeContent,
  event: ComplianceEventLike,
  finality: Finality,
): ComplianceEventJudgement {
  if (!isFinal(event.blockNumber, finality)) return { verdict: 'wait' };
  return complianceEventMatches(change, event)
    ? { verdict: 'confirm', event: 'CONFIRM' }
    : { verdict: 'conflict' };
}
