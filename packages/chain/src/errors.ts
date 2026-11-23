/**
 * @file The ways talking to a chain can fail, sorted by what the caller should do about each.
 * A transaction that was accepted and then reverted is not an error here: it is a receipt with
 * status `reverted`. These are failures to submit or to reach the node.
 */

import type { TxHash } from './types';

/** Base class for every failure to talk to the chain. */
export class ChainError extends Error {
  /**
   * @param message What went wrong, safe to log.
   * @param cause The underlying error, kept for logs (standard `Error.cause`) and never shown to API callers.
   */
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
  }
}

/**
 * The signer's nonce was already used on chain. It may have been used by an EARLIER attempt of
 * this same operation (a submit that timed out, or one that was replaced). Before re-signing,
 * look up your earlier attempts for this nonce by hash and check the operation's reference with
 * `readReferenceUsed`; only when neither shows the operation, re-read the nonce and try again.
 */
export class NonceTooLowError extends ChainError {}

/**
 * A transaction with this signer and nonce is already waiting, and the new one does not pay enough
 * more to replace it. Bump both fee fields further and try again.
 */
export class ReplacementUnderpricedError extends ChainError {}

/** The node already holds exactly this transaction. Treat the submission as having succeeded. */
export class AlreadyKnownError extends ChainError {
  constructor(
    message: string,
    /** The hash of the transaction the node already holds, when the node reports it. */
    readonly txHash?: TxHash,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

/** The signer cannot pay for the transaction. Needs a person; retrying will not help. */
export class InsufficientFundsError extends ChainError {}

/**
 * The node did not answer, or answered with a transport error. The outcome is UNKNOWN: the
 * transaction may or may not have been accepted. Check by hash before sending anything again.
 */
export class ChainUnavailableError extends ChainError {}

/** The node refused the transaction for a reason that retrying will not fix. */
export class SubmissionRejectedError extends ChainError {}
