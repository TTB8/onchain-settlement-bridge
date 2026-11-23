/**
 * @file When a mined transaction counts as final, and what to do next with one submission attempt.
 *
 * Why depth matters: a transaction in block N with fewer than `depth` confirmations can still be
 * removed by a reorganisation. Treating it as settled would let the ledger settle an operation the
 * chain later forgets. So nothing here reports `confirmed` (or a final `reverted`) before depth.
 *
 * `assessAttempt` is a pure classifier: the engine gathers observations (receipt, mempool, nonce,
 * head, clock) and this function returns exactly one verdict. Keeping it pure means every awkward
 * case (a receipt that vanishes in a reorg, a nonce consumed by another transaction) is a table row
 * in a unit test instead of a timing-dependent integration test.
 *
 * Engine obligations (the classifier is only as sound as its inputs):
 * - Keep an attempt record for EVERY transaction that was signed, from the moment it is signed until
 *   its nonce use is final. A submission whose outcome is unknown (a timeout, a transport error) is
 *   NOT a rejection: the node may have accepted it, so it stays an attempt that can still land.
 * - `finalNonce` is the signer's transaction count at the block `head - depth + 1` (the newest block
 *   with `depth` confirmations), read with the chain package's `getNonce(signer, blockNumber)`. The
 *   head's count alone is not final: a one-block reorg can un-consume a nonce.
 * - `ReversalEvidence.anAttemptCanStillMine` must be computed with `attemptCanStillMine` over every
 *   attempt of the operation.
 */

import { FeeCapExceededError, InvalidInputError } from './errors';
import { bumpFees, type Fees } from './gas';

function assertDepth(depth: number): bigint {
  if (!Number.isSafeInteger(depth) || depth < 1) {
    throw new InvalidInputError(`confirmation depth must be an integer >= 1, got ${depth}`);
  }
  return BigInt(depth);
}

/**
 * How many confirmations a transaction mined in `txBlock` has when the head is `head`: the block
 * itself counts as one, so `head - txBlock + 1`. Zero when not mined (`null`) or when the head is
 * behind the block (a lagging node, or a reorg that shortened the chain).
 */
export function confirmationsOf(txBlock: bigint | null, head: bigint): bigint {
  if (txBlock === null || head < txBlock) return 0n;
  return head - txBlock + 1n;
}

/** Whether a transaction mined in `txBlock` has at least `depth` (>= 1) confirmations at `head`. */
export function isConfirmed(txBlock: bigint | null, head: bigint, depth: number): boolean {
  return confirmationsOf(txBlock, head) >= assertDepth(depth);
}

/** The chain position against which "final" is judged: the head and the confirmations required. */
export interface Finality {
  /** The newest block number. */
  readonly head: bigint;
  /** Confirmations required before something counts (>= 1). */
  readonly depth: number;
}

/** Whether something in block `blockNumber` is final under `finality`. */
export function isFinal(blockNumber: bigint, finality: Finality): boolean {
  return isConfirmed(blockNumber, finality.head, finality.depth);
}

/** The fields of a receipt the classifier reads. Structurally compatible with the chain's `Receipt`. */
export interface ObservedReceipt {
  /** `reverted` means mined, gas spent, nothing changed. */
  readonly status: 'success' | 'reverted';
  /** The block it was mined in. */
  readonly blockNumber: bigint;
  /** The decoded contract error for a revert, when known. */
  readonly revertReason?: string;
}

/** One submission attempt as the engine recorded it. */
export interface AttemptRecord {
  /** The nonce it was sent with. */
  readonly nonce: number;
  /** The fees it was sent with. */
  readonly fees: Fees;
  /** When it was handed to the node (UTC). */
  readonly submittedAt: Date;
  /**
   * How many fee-bump replacements have already been sent for this operation's nonce. Part of the
   * record (not counted here) because the classifier is pure: the engine owns the history.
   */
  readonly bumpsSoFar: number;
  /** How many times this operation has already been resubmitted after a `dropped` verdict. */
  readonly resubmitsSoFar: number;
}

/** What the engine saw just now, from the node. */
export interface AttemptObservation {
  /** The attempt's receipt, or `null` when the node reports none (not mined, or reorged away). */
  readonly receipt: ObservedReceipt | null;
  /** Whether the node still knows the transaction (in its pool or mined). */
  readonly nodeKnowsTx: boolean;
  /** The signer's transaction count at the HEAD: every nonce below it is used by a mined tx. */
  readonly confirmedNonce: number;
  /**
   * The signer's transaction count at the newest FINAL block (`head - depth + 1`). Never above
   * `confirmedNonce`. Only a nonce below this count is used for good.
   */
  readonly finalNonce: number;
  /** The newest block number. */
  readonly head: bigint;
}

/** How patient to be and how far to go. */
export interface AttemptPolicy {
  /** Confirmations required before a receipt counts (>= 1). */
  readonly confirmations: number;
  /** How long a known, unmined attempt may wait before it is replaced with higher fees. */
  readonly stuckAfterSeconds: number;
  /** How many fee-bump replacements to send before giving up. */
  readonly maxBumps: number;
  /**
   * How many resubmissions after a drop to send before giving up. Without a limit, a transaction
   * that every node keeps rejecting from its pool would be resent forever.
   */
  readonly maxResubmits: number;
  /** The fee raise per bump, in basis points (>= 1250). */
  readonly bumpFeeBps: number;
  /** The highest `maxFeePerGas` a bump may reach. */
  readonly feeCap: bigint;
}

/** The single verdict for one attempt. */
export type AttemptVerdict =
  /**
   * Check again later: known to the node, not mined, not yet stuck; or the nonce was used by a
   * transaction mined at the head but that use is not final yet (a reorg could undo it).
   */
  | { readonly verdict: 'wait' }
  /** Mined but not deep enough to trust; a reorg could still remove it. */
  | {
      readonly verdict: 'mined_unconfirmed';
      readonly confirmations: bigint;
      readonly status: 'success' | 'reverted';
    }
  /** Mined successfully and at least `confirmations` deep: settle the operation. */
  | { readonly verdict: 'confirmed'; readonly blockNumber: bigint }
  /** Mined, reverted and deep enough: pass `reason` to `resolveRevert`. */
  | {
      readonly verdict: 'reverted';
      readonly blockNumber: bigint;
      readonly reason: string | undefined;
    }
  /** Pending too long: send a replacement with the SAME nonce and these fees. */
  | { readonly verdict: 'stuck_bump'; readonly nonce: number; readonly fees: Fees }
  /** The node forgot it and its nonce is still free: resubmit it (same nonce, same reference). */
  | { readonly verdict: 'dropped' }
  /**
   * The signer's nonce was consumed, FINALLY, but not by this attempt. Another attempt of ours
   * (check those first) or a foreign transaction took it. Look for the operation's reference on
   * chain before deciding anything: it may have settled through another attempt.
   */
  | { readonly verdict: 'replaced_or_lost' }
  /**
   * Stop retrying and escalate: bumps ran out (`max_bumps`), the next bump would pass the fee cap
   * (`fee_cap`), or a dropped transaction has been resubmitted `maxResubmits` times
   * (`max_resubmits`). The attempt may STILL be mined (a node that forgot it is not every node),
   * so this is not a FAIL-and-REVERSE signal on its own (see `mayReverse`).
   */
  | { readonly verdict: 'give_up'; readonly why: 'max_bumps' | 'fee_cap' | 'max_resubmits' };

function assertNonNegativeInt(n: number, label: string): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new InvalidInputError(`${label} must be a non-negative integer, got ${n}`);
  }
}

function assertNonce(observation: AttemptObservation): void {
  assertNonNegativeInt(observation.confirmedNonce, 'observation.confirmedNonce');
  assertNonNegativeInt(observation.finalNonce, 'observation.finalNonce');
  if (observation.finalNonce > observation.confirmedNonce) {
    // An older block cannot have used more nonces than the head: the reads are inconsistent.
    throw new InvalidInputError('observation.finalNonce cannot exceed observation.confirmedNonce');
  }
}

function assertValidDate(d: Date, label: string): void {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new InvalidInputError(`${label} must be a valid Date`);
  }
}

/**
 * Classifies one submission attempt. The checks run in an order that matters:
 *
 * 1. A receipt wins over everything, but only counts once it is `confirmations` deep.
 * 2. No receipt and the signer's FINAL nonce is past ours: a different transaction used it for good.
 *    If only the head's nonce is past ours, the use is not final yet: `wait`. (Both checked before
 *    "dropped", because a node that forgot a replaced transaction would otherwise look like a drop,
 *    and resubmitting would just fail with "nonce too low".)
 * 3. No receipt and the node does not know it: dropped, resubmit, or give up once
 *    `resubmitsSoFar` has reached `maxResubmits`.
 * 4. Known and pending: wait, or bump once it has been pending for `stuckAfterSeconds`, or give up.
 *
 * These choices (`bumpsSoFar` and `resubmitsSoFar` in the record, the `give_up.why` reasons, and
 * step 2 before step 3) were reviewed and accepted by the team lead.
 *
 * A receipt that vanishes (a reorg removed its block) simply reaches step 2, 3 or 4 on the next call.
 *
 * @param attempt The attempt as recorded.
 * @param observation What the node reports now.
 * @param now The current time (UTC), passed in so the classifier is deterministic.
 * @param policy Depth, patience and fee limits.
 */
export function assessAttempt(
  attempt: AttemptRecord,
  observation: AttemptObservation,
  now: Date,
  policy: AttemptPolicy,
): AttemptVerdict {
  const depth = assertDepth(policy.confirmations);
  assertNonNegativeInt(attempt.nonce, 'attempt.nonce');
  assertNonNegativeInt(attempt.bumpsSoFar, 'attempt.bumpsSoFar');
  assertNonce(observation);
  assertNonNegativeInt(attempt.resubmitsSoFar, 'attempt.resubmitsSoFar');
  assertNonNegativeInt(policy.maxBumps, 'policy.maxBumps');
  assertNonNegativeInt(policy.maxResubmits, 'policy.maxResubmits');
  if (!Number.isFinite(policy.stuckAfterSeconds) || policy.stuckAfterSeconds < 0) {
    throw new InvalidInputError('policy.stuckAfterSeconds must be a non-negative number');
  }
  assertValidDate(attempt.submittedAt, 'attempt.submittedAt');
  assertValidDate(now, 'now');

  const { receipt } = observation;
  if (receipt !== null) {
    const confirmations = confirmationsOf(receipt.blockNumber, observation.head);
    if (confirmations < depth) {
      return { verdict: 'mined_unconfirmed', confirmations, status: receipt.status };
    }
    return receipt.status === 'success'
      ? { verdict: 'confirmed', blockNumber: receipt.blockNumber }
      : { verdict: 'reverted', blockNumber: receipt.blockNumber, reason: receipt.revertReason };
  }

  if (observation.finalNonce > attempt.nonce) {
    return { verdict: 'replaced_or_lost' };
  }
  if (observation.confirmedNonce > attempt.nonce) {
    // Used at the head, not yet final: a reorg could bring this attempt (or the other one) back.
    return { verdict: 'wait' };
  }

  if (!observation.nodeKnowsTx) {
    if (attempt.resubmitsSoFar >= policy.maxResubmits) {
      return { verdict: 'give_up', why: 'max_resubmits' };
    }
    return { verdict: 'dropped' };
  }

  const pendingMs = now.getTime() - attempt.submittedAt.getTime();
  if (pendingMs < policy.stuckAfterSeconds * 1000) {
    return { verdict: 'wait' };
  }
  if (attempt.bumpsSoFar >= policy.maxBumps) {
    return { verdict: 'give_up', why: 'max_bumps' };
  }
  try {
    const fees = bumpFees(attempt.fees, { bumpBps: policy.bumpFeeBps, cap: policy.feeCap });
    return { verdict: 'stuck_bump', nonce: attempt.nonce, fees };
  } catch (err) {
    if (err instanceof FeeCapExceededError) {
      return { verdict: 'give_up', why: 'fee_cap' };
    }
    throw err;
  }
}

/**
 * Whether this attempt could still be mined (and so settle its operation). False only when that is
 * settled for good: the attempt has a receipt at least `depth` deep (it landed, success or revert),
 * or the signer's nonce use at the final block is past the attempt's nonce (something else took it).
 * Everything else, including a nonce used only at the head, means it can still land.
 *
 * `ReversalEvidence.anAttemptCanStillMine` must be the OR of this over every attempt the engine
 * holds for the operation.
 *
 * @param attempt The attempt as recorded.
 * @param observation What the node reports now (receipt, nonces, head).
 * @param depth Confirmations required for finality (>= 1).
 */
export function attemptCanStillMine(
  attempt: Pick<AttemptRecord, 'nonce'>,
  observation: AttemptObservation,
  depth: number,
): boolean {
  const required = assertDepth(depth);
  assertNonNegativeInt(attempt.nonce, 'attempt.nonce');
  assertNonce(observation);
  const { receipt } = observation;
  if (receipt !== null && confirmationsOf(receipt.blockNumber, observation.head) >= required) {
    return false;
  }
  return observation.finalNonce <= attempt.nonce;
}
