/**
 * @file Every way a domain rule can refuse an input. Callers branch on the class (or on `code`),
 * never on message text, so each rule that can fail has its own subclass.
 *
 * Why typed errors instead of `Error`: the engine maps each refusal to a different action (reject
 * the API request, fail the operation, page a person). A bare `Error` would make that mapping a
 * string match, which silently breaks when someone rewords a message.
 */

/** Stable, machine-readable identifiers for each domain refusal. */
export type DomainErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_AMOUNT'
  | 'AMOUNT_OVERFLOW'
  | 'AMOUNT_UNDERFLOW'
  | 'UNBALANCED_ENTRY'
  | 'INSUFFICIENT_FUNDS'
  | 'SELF_TRANSFER'
  | 'INVALID_TRANSITION'
  | 'INVALID_REFERENCE'
  | 'COMPLIANCE_REJECTED'
  | 'FEE_CAP_EXCEEDED';

/** Base class of every error this package throws. Never thrown directly. */
export abstract class DomainError extends Error {
  /** Stable identifier for the refusal; safe to expose to API callers and to alert on. */
  abstract readonly code: DomainErrorCode;

  /** @param message What was refused and why, safe to log (contains no secrets). */
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A value had the wrong shape or broke a precondition that is not covered by a more specific error. */
export class InvalidInputError extends DomainError {
  readonly code = 'INVALID_INPUT' as const;
}

/** An amount was not a positive bigint within the ledger's storage cap. */
export class InvalidAmountError extends DomainError {
  readonly code = 'INVALID_AMOUNT' as const;

  /**
   * @param amount The rejected value, kept for logs.
   * @param message Why it was rejected.
   */
  constructor(
    readonly amount: unknown,
    message: string,
  ) {
    super(message);
  }
}

/** An addition would leave the range the ledger can store (Postgres `bigint`). */
export class AmountOverflowError extends DomainError {
  readonly code = 'AMOUNT_OVERFLOW' as const;
}

/** A subtraction would go below zero, which no balance or amount in the ledger may do. */
export class AmountUnderflowError extends DomainError {
  readonly code = 'AMOUNT_UNDERFLOW' as const;
}

/** A journal entry is not a valid double entry: too few postings or debits differ from credits. */
export class UnbalancedEntryError extends DomainError {
  readonly code = 'UNBALANCED_ENTRY' as const;

  /**
   * @param operationId The operation the entry belongs to.
   * @param totalDebits Sum of debit postings (0n when the entry was rejected before summing).
   * @param totalCredits Sum of credit postings (0n when the entry was rejected before summing).
   * @param message Why it was rejected.
   */
  constructor(
    readonly operationId: string,
    readonly totalDebits: bigint,
    readonly totalCredits: bigint,
    message: string,
  ) {
    super(message);
  }
}

/** A withdrawal or transfer asked for more than the user's available balance. */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS' as const;

  /**
   * @param available The available balance at the time of the check.
   * @param requested The amount asked for.
   */
  constructor(
    readonly available: bigint,
    readonly requested: bigint,
  ) {
    super(`insufficient funds: available ${available}, requested ${requested}`);
  }
}

/** A transfer named the same user (or the same address) on both sides. */
export class SelfTransferError extends DomainError {
  readonly code = 'SELF_TRANSFER' as const;
}

/** An operation or compliance change was asked to move along an edge its state machine lacks. */
export class InvalidTransitionError extends DomainError {
  readonly code = 'INVALID_TRANSITION' as const;

  /**
   * @param from The current state.
   * @param event The event that was applied.
   * @param machine Which state machine refused (for logs).
   */
  constructor(
    readonly from: string,
    readonly event: string,
    readonly machine: string,
  ) {
    super(`${machine}: no transition from '${from}' on '${event}'`);
  }
}

/** A value meant to be a 32-byte on-chain reference (or the UUID behind one) was malformed. */
export class InvalidReferenceError extends DomainError {
  readonly code = 'INVALID_REFERENCE' as const;
}

/** Which side of an operation a compliance check is about. */
export type ComplianceParty = 'recipient' | 'owner' | 'sender';

/** Why an address may not transact right now. `unknown` means no state was supplied for it. */
export type ComplianceViolationReason = 'not_verified' | 'frozen' | 'unknown';

/** One party that failed a compliance check. */
export interface ComplianceViolation {
  /** The role the address plays in the operation. */
  party: ComplianceParty;
  /** The address that failed. */
  address: string;
  /** Why it failed. */
  reason: ComplianceViolationReason;
}

/** At least one party of an operation is not allowed to transact. Lists every failing party. */
export class ComplianceRejectedError extends DomainError {
  readonly code = 'COMPLIANCE_REJECTED' as const;

  /** @param violations Every failing party, in a fixed order (sender/owner before recipient). */
  constructor(readonly violations: readonly ComplianceViolation[]) {
    super(
      `compliance rejected: ${violations.map((v) => `${v.party} ${v.address} (${v.reason})`).join(', ')}`,
    );
  }
}

/** A fee computation would exceed the configured ceiling, so a person has to decide. */
export class FeeCapExceededError extends DomainError {
  readonly code = 'FEE_CAP_EXCEEDED' as const;

  /**
   * @param required The fee the rule needs to pay.
   * @param cap The configured ceiling.
   */
  constructor(
    readonly required: bigint,
    readonly cap: bigint,
  ) {
    super(`fee ${required} exceeds cap ${cap}`);
  }
}
