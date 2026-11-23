/**
 * @file Amounts on the wire: decimal strings of the token's smallest unit, never JSON numbers.
 *
 * Why strings: a JSON number is a double in every mainstream parser, exact only up to 2^53, and
 * `1e6`, `1000000.0` and `0.1` are all valid JSON numbers. An amount that a parser silently rounds
 * is money created or destroyed, so the API accepts exactly one spelling per value: a non-empty
 * run of digits with no sign, no leading zero, no decimal point and no exponent. The token has 6
 * decimals, so "1500000" is 1.5 tokens. ADR 0010.
 */

import { ApiProblem } from './problem';

/** The token's decimals: amounts are in units of 10^-6 token. */
export const TOKEN_DECIMALS = 6;

/** The one accepted spelling: digits, no leading zero, at most 19 digits (a 64-bit column). */
export const AMOUNT_PATTERN = /^[1-9][0-9]{0,18}$/;

/** Why an amount was refused, as shown in a validation problem's `errors`. */
export const AMOUNT_RULE =
  'must be a decimal string of the smallest unit (6 decimals): digits only, no sign, no leading zero, no decimal point, no exponent, greater than zero';

/**
 * The amount as a bigint, or an `ApiProblem` (`VALIDATION_FAILED` for a bad spelling or type,
 * `AMOUNT_ABOVE_LIMIT` above `max`).
 *
 * @param value The JSON value received (anything: it is checked here).
 * @param max The largest amount one request may move.
 * @param field The field name for the error.
 */
export function parseAmount(value: unknown, max: bigint, field = 'amount'): bigint {
  if (typeof value !== 'string' || !AMOUNT_PATTERN.test(value)) {
    throw new ApiProblem('VALIDATION_FAILED', { errors: [{ field, message: AMOUNT_RULE }] });
  }
  const amount = BigInt(value);
  if (amount > max) {
    throw new ApiProblem('AMOUNT_ABOVE_LIMIT', { limit: max.toString() });
  }
  return amount;
}

/**
 * An amount for a response: the decimal string of the smallest unit.
 *
 * @param amount The amount.
 */
export function formatAmount(amount: bigint): string {
  return amount.toString();
}
