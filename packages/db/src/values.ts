/**
 * @file Small, strict converters for the two value types that cross the database boundary most:
 * `bigint` (amounts, block numbers, fees: Postgres `bigint`, signed 64-bit) and UUIDs (every id).
 *
 * Strict on purpose: a number, a float string or a padded string is refused rather than coerced,
 * because a silently "fixed" amount is worse than an error.
 */

/** The largest value a Postgres `bigint` column holds: 2^63 - 1. */
export const MAX_DB_BIGINT: bigint = 2n ** 63n - 1n;

/** The smallest value a Postgres `bigint` column holds: -2^63. */
export const MIN_DB_BIGINT: bigint = -(2n ** 63n);

const DECIMAL = /^-?(0|[1-9][0-9]*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Thrown when a value cannot be stored or read as the type the column needs. */
export class DbValueError extends Error {
  /** @param message What was wrong with the value. */
  constructor(message: string) {
    super(message);
    this.name = 'DbValueError';
  }
}

/** Throws `DbValueError` unless `n` is a bigint that fits a Postgres `bigint` column. */
export function assertDbBigint(n: unknown): asserts n is bigint {
  if (typeof n !== 'bigint') {
    throw new DbValueError(`expected a bigint, got ${typeof n}`);
  }
  if (n > MAX_DB_BIGINT || n < MIN_DB_BIGINT) {
    throw new DbValueError(`${n} does not fit a Postgres bigint`);
  }
}

/**
 * Parses a canonical decimal string (no sign other than a leading `-`, no leading zeros, no
 * spaces, no exponent) into a bigint that fits a Postgres `bigint`. This is the format bigint
 * amounts use inside JSON columns (for example the outbox `call`).
 */
export function bigintFromDecimal(text: string): bigint {
  if (typeof text !== 'string' || !DECIMAL.test(text) || text === '-0') {
    throw new DbValueError(`not a canonical decimal integer: ${JSON.stringify(text)}`);
  }
  const n = BigInt(text);
  assertDbBigint(n);
  return n;
}

/**
 * Returns a JSON-safe deep copy of `value` with every bigint replaced by its decimal string.
 * Use it to build a JSON column (such as the outbox `call`) from typed values: `JSON.stringify`
 * throws on a bigint, and a `number` would lose precision above 2^53.
 */
export function bigintsToDecimal(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(bigintsToDecimal);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = bigintsToDecimal(v);
    return out;
  }
  return value;
}

/** Whether `value` is a lowercase canonical UUID string (the form Postgres returns). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * Returns `value` lowercased if it is a UUID in canonical 8-4-4-4-12 form (any case); throws
 * `DbValueError` otherwise. Normalising before comparing matters: Postgres returns lowercase.
 */
export function toUuid(value: unknown): string {
  const lower = typeof value === 'string' ? value.toLowerCase() : value;
  if (!isUuid(lower)) {
    throw new DbValueError(`not a UUID: ${JSON.stringify(value)}`);
  }
  return lower;
}

/** `toUuid` over a list, sorted and de-duplicated (a stable order for locking). */
export function toSortedUniqueUuids(values: readonly unknown[]): string[] {
  return [...new Set(values.map(toUuid))].sort();
}
