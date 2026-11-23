/**
 * @file Path and query parameters: UUID ids and page limits, refused as validation problems
 * before any query runs (a malformed id never reaches Postgres, where it would be a 500).
 */

import { type ArgumentMetadata, ParseUUIDPipe, type PipeTransform } from '@nestjs/common';

import { ApiProblem } from './problem';

/** Validates a UUID path parameter and returns it in lowercase canonical form. */
export class UuidParamPipe implements PipeTransform<unknown, Promise<string>> {
  private readonly inner: ParseUUIDPipe;

  /** @param field The parameter name, for the validation problem. */
  constructor(private readonly field: string) {
    this.inner = new ParseUUIDPipe({
      exceptionFactory: () =>
        new ApiProblem('VALIDATION_FAILED', { errors: [{ field, message: 'must be a UUID' }] }),
    });
  }

  /** @inheritdoc */
  async transform(value: unknown, metadata: ArgumentMetadata): Promise<string> {
    const valid = (await this.inner.transform(value as string, metadata)) as string;
    // WHY lowercase: Postgres compares uuids case-insensitively, but the engine compares ids as
    // strings (idempotent replay content, self-transfer): an uppercase spelling of the same id
    // would be a false conflict, or a self transfer that slips past the check.
    return valid.toLowerCase();
  }
}

/**
 * A pipe for a UUID path parameter: anything else is `VALIDATION_FAILED` naming the parameter;
 * a valid one is lowercased.
 *
 * @param field The parameter name.
 */
export function uuidParam(field: string): UuidParamPipe {
  return new UuidParamPipe(field);
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
