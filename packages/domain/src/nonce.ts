/**
 * @file Choosing the nonce for a new transaction from a signer.
 *
 * Why the bridge owns nonces instead of asking the node each time: two workers asking the node at
 * the same moment get the same "pending" count and send two transactions with one nonce; one of
 * them silently replaces the other. The engine therefore reserves nonces in its database, and this
 * rule picks the next one from the chain's count and the local reservations.
 */

import { InvalidInputError } from './errors';

/** Inputs to `nextNonce`. */
export interface NonceInputs {
  /** The signer's pending transaction count as the node reports it (mined plus in the pool). */
  readonly chainPending: number;
  /** Nonces this bridge has reserved and not released, in any order, possibly with gaps. */
  readonly reservedLocally: readonly number[];
}

function assertNonce(n: number, label: string): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new InvalidInputError(`${label} must be a non-negative integer, got ${n}`);
  }
}

/**
 * The lowest nonce that is at least `chainPending` and not reserved locally.
 *
 * - Never below `chainPending`: those nonces are already used (or waiting) on chain.
 * - Never a reserved one: it belongs to an attempt that may still be in flight.
 * - A gap in the reservations is filled first. A gap means a nonce that was reserved and then
 *   released without being sent; every later transaction is stuck behind it until it is used.
 */
export function nextNonce(inputs: NonceInputs): number {
  assertNonce(inputs.chainPending, 'chainPending');
  const reserved = new Set<number>();
  for (const n of inputs.reservedLocally) {
    assertNonce(n, 'reserved nonce');
    reserved.add(n);
  }
  let candidate = inputs.chainPending;
  while (reserved.has(candidate)) candidate += 1;
  return candidate;
}
