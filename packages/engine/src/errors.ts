/**
 * @file Every way the engine can refuse a request or a state change, as typed errors.
 *
 * Why typed: the API maps each refusal to a different response (409 for an idempotency conflict,
 * 422 for insufficient funds, 503 for "no active deployment"), and an operator alerts on some of
 * them. Branching on message text would break the first time someone rewords one. Domain errors
 * are translated here so callers of the engine never need to import `@bridge/domain` to react.
 */

import {
  DomainError,
  InsufficientFundsError as DomainInsufficientFunds,
  InvalidTransitionError,
  SelfTransferError,
} from '@bridge/domain';

/** Stable, machine-readable identifiers for each engine refusal. */
export type EngineErrorCode =
  | 'INVALID_REQUEST'
  | 'INSUFFICIENT_FUNDS'
  | 'SELF_TRANSFER'
  | 'UNKNOWN_USER'
  | 'NO_ACTIVE_DEPLOYMENT'
  | 'DEPLOYMENT_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT'
  | 'OPERATION_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'ILLEGAL_TRANSITION'
  | 'EVIDENCE_REFUSED'
  | 'HANDLER_TIMEOUT'
  | 'RETRIES_EXHAUSTED'
  | 'LEDGER_SETUP'
  | 'LEASE_LOST'
  | 'SIGNED_HASH_MISMATCH'
  | 'SIGNER_MISMATCH';

/** Base class of every error the engine throws on purpose. */
export abstract class EngineError extends Error {
  /** Stable identifier; safe to expose to API callers and to alert on. */
  abstract readonly code: EngineErrorCode;

  /**
   * @param message What was refused and why (no secrets, no PII beyond ids).
   * @param options `cause`: the underlying error, kept for logs.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The request is malformed (bad amount, empty idempotency key, unknown type...). */
export class InvalidRequestError extends EngineError {
  readonly code = 'INVALID_REQUEST' as const;
}

/** A withdrawal or transfer asked for more than the user's available balance, read under lock. */
export class InsufficientFundsError extends EngineError {
  readonly code = 'INSUFFICIENT_FUNDS' as const;

  /**
   * @param available The available balance read under the row lock.
   * @param requested The amount asked for.
   */
  constructor(
    readonly available: bigint,
    readonly requested: bigint,
  ) {
    super(`insufficient funds: available ${available}, requested ${requested}`);
  }
}

/** A transfer names the same user on both sides. */
export class SelfTransferRequestError extends EngineError {
  readonly code = 'SELF_TRANSFER' as const;
}

/** A user, or one of their ledger accounts, does not exist. */
export class UnknownUserError extends EngineError {
  readonly code = 'UNKNOWN_USER' as const;
}

/**
 * The configured chain has no active deployment. Fail closed: new work is never bound to a guess
 * (ADR 0011). Usually means a redeploy is in progress.
 */
export class NoActiveDeploymentError extends EngineError {
  readonly code = 'NO_ACTIVE_DEPLOYMENT' as const;
}

/**
 * The chain's active deployment is not the token this engine was configured for. Switching
 * deployment is a migration procedure, never something the engine follows silently (ADR 0011).
 */
export class DeploymentMismatchError extends EngineError {
  readonly code = 'DEPLOYMENT_MISMATCH' as const;
}

/**
 * The caller's idempotency key was already used, BY THE SAME USER, for a request with different
 * content. Keys are scoped per user (unique on (user_id, idempotency_key)), so the operation named
 * here always belongs to the requesting user; the key itself is not echoed (it is the caller's
 * input and may be logged by the API layer).
 */
export class IdempotencyConflictError extends EngineError {
  readonly code = 'IDEMPOTENCY_CONFLICT' as const;

  /** @param existingOperationId The requesting user's operation that already owns the key. */
  constructor(readonly existingOperationId: string) {
    super(
      `the idempotency key was already used for operation ${existingOperationId} with different content`,
    );
  }
}

/** No operation has the given id. */
export class OperationNotFoundError extends EngineError {
  readonly code = 'OPERATION_NOT_FOUND' as const;
}

/**
 * The operation is not at the version (or status) the caller read: someone else moved it first.
 * The caller must re-read and decide again; retrying blindly would act on stale evidence.
 */
export class VersionConflictError extends EngineError {
  readonly code = 'VERSION_CONFLICT' as const;

  /**
   * @param operationId The operation.
   * @param expectedVersion The version the caller read.
   */
  constructor(
    readonly operationId: string,
    readonly expectedVersion: number,
  ) {
    super(`operation ${operationId} is no longer at version ${expectedVersion}`);
  }
}

/** The state machine has no such edge (checked before any database write). */
export class IllegalTransitionError extends EngineError {
  readonly code = 'ILLEGAL_TRANSITION' as const;
}

/**
 * The evidence handed to a money move does not allow it: a confirmation without a `confirm`
 * judgement, a reversal `mayReverse` refuses, or reversal evidence gathered for a different
 * failure reason than the one stored. Never retried blindly: a person or a fresh evidence pass
 * decides.
 */
export class EvidenceRefusedError extends EngineError {
  readonly code = 'EVIDENCE_REFUSED' as const;
}

/**
 * An outbox handler did not answer within its time limit. Its outcome is UNKNOWN (it may still be
 * running, or have sent a transaction): the row is retried, never failed (ADR 0009).
 */
export class HandlerTimeoutError extends EngineError {
  readonly code = 'HANDLER_TIMEOUT' as const;
}

/** A transaction kept failing with a serialization failure or deadlock after every retry. */
export class RetriesExhaustedError extends EngineError {
  readonly code = 'RETRIES_EXHAUSTED' as const;

  /**
   * @param attempts How many times the transaction was tried.
   * @param cause The last retryable error.
   */
  constructor(
    readonly attempts: number,
    cause: unknown,
  ) {
    super(`transaction still conflicting after ${attempts} attempt(s)`, { cause });
  }
}

/** The ledger is not set up (no `fiat_clearing` account): run the seed. */
export class LedgerSetupError extends EngineError {
  readonly code = 'LEDGER_SETUP' as const;
}

/**
 * The outbox row's lease is no longer ours (another worker took it, it was cancelled, or the
 * handler's time limit fired). Nothing may be committed or broadcast for the row by this worker:
 * the outcome is unknown to the dispatcher (a retry), never a failure.
 */
export class LeaseLostError extends EngineError {
  readonly code = 'LEASE_LOST' as const;
}

/**
 * A broadcast reported a different transaction hash than the one recorded when the attempt was
 * signed. The bytes on the wire are not the bytes in `chain_attempt`, so the outcome is UNKNOWN
 * (ADR 0009): retried, never treated as a rejection, and worth an alarm.
 */
export class SignedHashMismatchError extends EngineError {
  readonly code = 'SIGNED_HASH_MISMATCH' as const;
}

/**
 * The gateway signs with another address than the one recorded for the deployment in
 * `signer_state` (a rotated or misconfigured key). Nonces and evidence belong to an address, so
 * nothing is read, signed or decided until a person fixes the configuration (review M-1).
 */
export class SignerMismatchError extends EngineError {
  readonly code = 'SIGNER_MISMATCH' as const;
}

/**
 * Translates a domain refusal into the matching engine error, and returns anything else as it is.
 * Unknown domain errors become `InvalidRequestError`: every domain refusal is about its input.
 *
 * @param err Whatever was thrown.
 */
export function fromDomainError(err: unknown): unknown {
  if (!(err instanceof DomainError)) return err;
  if (err instanceof DomainInsufficientFunds) {
    return new InsufficientFundsError(err.available, err.requested);
  }
  if (err instanceof SelfTransferError) {
    return new SelfTransferRequestError(err.message, { cause: err });
  }
  if (err instanceof InvalidTransitionError) {
    return new IllegalTransitionError(err.message, { cause: err });
  }
  return new InvalidRequestError(err.message, { cause: err });
}
