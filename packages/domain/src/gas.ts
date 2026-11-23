/**
 * @file EIP-1559 fee rules: the fees for a first attempt and the fees for a replacement.
 *
 * Why the replacement rule is strict: a node only replaces a pending transaction (same signer, same
 * nonce) if BOTH fee fields rise by at least its minimum bump, commonly 12.5% for EIP-1559 pools.
 * A replacement that is exactly at, or a wei under, the threshold is refused as "underpriced", and
 * the stuck transaction stays stuck. So every bump here is strictly above 12.5% and rounds UP; at
 * tiny values (1 wei, or a 0 priority fee) it still rises by at least 1 wei.
 */

import { FeeCapExceededError, InvalidInputError } from './errors';

/** EIP-1559 fee fields, in wei. Structurally identical to the chain package's `Fees`. */
export interface Fees {
  /** The most the signer pays per gas, base fee included. */
  readonly maxFeePerGas: bigint;
  /** The tip per gas offered to the block producer. */
  readonly maxPriorityFeePerGas: bigint;
}

/** Basis points in one whole: 10_000 bps = 100%. */
export const BPS = 10_000n;

/** The minimum replacement increase nodes enforce, in basis points (12.5%). */
export const MIN_REPLACEMENT_BUMP_BPS = 1250;

function assertBps(bps: number, label: string, min: number): bigint {
  if (!Number.isSafeInteger(bps) || bps < min) {
    throw new InvalidInputError(`${label} must be an integer >= ${min} basis points, got ${bps}`);
  }
  return BigInt(bps);
}

function assertFees(fees: Fees, label: string): void {
  if (
    typeof fees.maxFeePerGas !== 'bigint' ||
    typeof fees.maxPriorityFeePerGas !== 'bigint' ||
    fees.maxFeePerGas < 0n ||
    fees.maxPriorityFeePerGas < 0n
  ) {
    throw new InvalidInputError(`${label} fees must be non-negative bigints`);
  }
  if (fees.maxPriorityFeePerGas > fees.maxFeePerGas) {
    throw new InvalidInputError(`${label} priority fee exceeds max fee`);
  }
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * One fee field raised for a replacement: `value * (1 + bps)` rounded up, and never less than the
 * smallest integer strictly above `value * 1.125`.
 */
export function bumpValue(value: bigint, bumpBps: bigint): bigint {
  const bumped = ceilDiv(value * (BPS + bumpBps), BPS);
  const strictlyAboveMinimum = (value * (BPS + BigInt(MIN_REPLACEMENT_BUMP_BPS))) / BPS + 1n;
  return bumped > strictlyAboveMinimum ? bumped : strictlyAboveMinimum;
}

/** Options for `bumpFees`. */
export interface BumpOptions {
  /** The raise in basis points; at least 1250 (12.5%). Defaults to 1250. */
  readonly bumpBps?: number;
  /** The highest `maxFeePerGas` the signer may pay. Above it, a person decides. */
  readonly cap: bigint;
}

/**
 * The fees for a replacement of a pending transaction: both fields raised strictly above the
 * minimum replacement increase, rounded up. Throws `FeeCapExceededError` if the new max fee would
 * pass `cap`, and `InvalidInputError` for a bump under 12.5% (it could never replace anything).
 */
export function bumpFees(previous: Fees, options: BumpOptions): Fees {
  assertFees(previous, 'previous');
  // Fail closed: a missing cap at runtime would make every comparison below false (no limit).
  if (typeof options.cap !== 'bigint' || options.cap < 0n) {
    throw new InvalidInputError('bumpFees needs a non-negative bigint cap');
  }
  const bps = assertBps(
    options.bumpBps ?? MIN_REPLACEMENT_BUMP_BPS,
    'bumpBps',
    MIN_REPLACEMENT_BUMP_BPS,
  );
  const maxFeePerGas = bumpValue(previous.maxFeePerGas, bps);
  const maxPriorityFeePerGas = bumpValue(previous.maxPriorityFeePerGas, bps);
  if (maxFeePerGas > options.cap) {
    throw new FeeCapExceededError(maxFeePerGas, options.cap);
  }
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/** Options for `initialFees`. */
export interface InitialFeeOptions {
  /** Headroom added to the max fee, in basis points, so a rising base fee does not strand the tx. */
  readonly marginBps: number;
  /** Optional ceiling on `maxFeePerGas`; when given, exceeding it throws `FeeCapExceededError`. */
  readonly cap?: bigint;
}

/**
 * The fees for a first attempt: the node's estimate with `marginBps` added to the max fee (rounded
 * up). The priority fee is kept as estimated: the margin is for base-fee drift, not a bigger tip.
 */
export function initialFees(estimate: Fees, options: InitialFeeOptions): Fees {
  assertFees(estimate, 'estimate');
  const margin = assertBps(options.marginBps, 'marginBps', 0);
  if (options.cap !== undefined && (typeof options.cap !== 'bigint' || options.cap < 0n)) {
    throw new InvalidInputError('initialFees cap, when given, must be a non-negative bigint');
  }
  const maxFeePerGas = ceilDiv(estimate.maxFeePerGas * (BPS + margin), BPS);
  if (options.cap !== undefined && maxFeePerGas > options.cap) {
    throw new FeeCapExceededError(maxFeePerGas, options.cap);
  }
  return { maxFeePerGas, maxPriorityFeePerGas: estimate.maxPriorityFeePerGas };
}
