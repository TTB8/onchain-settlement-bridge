/**
 * @file Path and query parameters: UUID ids and page limits, refused as validation problems
 * before any query runs (a malformed id never reaches Postgres, where it would be a 500).
 */

import { ParseUUIDPipe } from '@nestjs/common';

import { ApiProblem } from './problem';

/**
 * A pipe for a UUID path parameter; anything else is `VALIDATION_FAILED` naming the parameter.
 *
 * @param field The parameter name.
 */
export function uuidParam(field: string): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () =>
      new ApiProblem('VALIDATION_FAILED', { errors: [{ field, message: 'must be a UUID' }] }),
  });
}

/**
 * A page limit from a query string: absent gives `fallback`, otherwise an integer 1..`max`.
 *
 * @param value The raw query value.
 * @param fallback The default.
 * @param max The largest accepted.
 */
export function parseLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const n = typeof value === 'string' && /^[1-9][0-9]{0,3}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n > max) {
    throw new ApiProblem('VALIDATION_FAILED', {
      errors: [{ field: 'limit', message: `must be an integer from 1 to ${max}` }],
    });
  }
  return n;
}
