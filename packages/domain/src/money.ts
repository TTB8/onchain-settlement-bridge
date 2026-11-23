/**
 * @file Money arithmetic for the ledger. Amounts are `bigint` in the token's smallest unit.
 *
 * Why bigint and why a cap: floats lose cents, and JavaScript numbers lose precision above 2^53.
 * The ledger stores amounts in a Postgres `bigint` (signed 64-bit), so any amount or running total
 * above 2^63 - 1 would fail at the database, or worse, be truncated by a driver. Checking here
 * turns that into a typed refusal before any write happens.
 */

import { AmountOverflowError, AmountUnderflowError, InvalidAmountError } from './errors';

/** The largest amount (and the largest running total) the ledger can store: 2^63 - 1. */
export const MAX_LEDGER_AMOUNT: bigint = 2n ** 63n - 1n;

/**
 * Throws `InvalidAmountError` unless `n` is a bigint with 0 < n <= MAX_LEDGER_AMOUNT.
 * The runtime type check matters: values arrive from JSON and SQL, where a `number` or a string
 * can slip past the type system.
 */
export function assertPositiveAmount(n: unknown): asserts n is bigint {
  if (typeof n !== 'bigint') {
    throw new InvalidAmountError(n, `amount must be a bigint, got ${typeof n}`);
  }
  if (n <= 0n) {
    throw new InvalidAmountError(n, `amount must be positive, got ${n}`);
  }
  if (n > MAX_LEDGER_AMOUNT) {
    throw new InvalidAmountError(n, `amount ${n} exceeds the ledger cap ${MAX_LEDGER_AMOUNT}`);
  }
}

function assertNonNegativeOperand(n: bigint, label: string): void {
  if (typeof n !== 'bigint' || n < 0n || n > MAX_LEDGER_AMOUNT) {
    throw new InvalidAmountError(n, `${label} must be a bigint in [0, ${MAX_LEDGER_AMOUNT}]`);
  }
}

/**
 * `a + b`, refusing a result above MAX_LEDGER_AMOUNT. Both operands must be non-negative and in
 * range: ledger totals and balances are never negative.
 */
export function checkedAdd(a: bigint, b: bigint): bigint {
  assertNonNegativeOperand(a, 'left operand');
  assertNonNegativeOperand(b, 'right operand');
  const sum = a + b;
  if (sum > MAX_LEDGER_AMOUNT) {
    throw new AmountOverflowError(`${a} + ${b} exceeds the ledger cap ${MAX_LEDGER_AMOUNT}`);
  }
  return sum;
}

/** `a - b`, refusing a negative result. Both operands must be non-negative and in range. */
export function checkedSub(a: bigint, b: bigint): bigint {
  assertNonNegativeOperand(a, 'left operand');
  assertNonNegativeOperand(b, 'right operand');
  if (b > a) {
    throw new AmountUnderflowError(`${a} - ${b} would be negative`);
  }
  return a - b;
}
