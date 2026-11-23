/**
 * @file The `Idempotency-Key` request header: REQUIRED on every route that creates something.
 *
 * Why required and not optional: a client that retries a timed-out POST without a key creates a
 * second deposit; making the key optional makes that the default. The engine scopes keys per user
 * (operations) or per requester (compliance changes): the same key with the same body returns
 * the stored result, the same key with another body is a 409.
 */

import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { ApiProblem } from './problem';

/** The header name (case-insensitive on the wire). */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/** 1..255 visible ASCII characters, no spaces (the engine's column holds 255). */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

/**
 * The validated key from a header value, or an `ApiProblem` (`IDEMPOTENCY_KEY_MISSING`,
 * `IDEMPOTENCY_KEY_INVALID`).
 *
 * @param value The raw header value(s).
 */
export function parseIdempotencyKey(value: string | string[] | undefined): string {
  if (value === undefined || value === '') throw new ApiProblem('IDEMPOTENCY_KEY_MISSING');
  // Two headers would make "which one counts" a guess; refuse.
  if (Array.isArray(value) || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new ApiProblem('IDEMPOTENCY_KEY_INVALID');
  }
  return value;
}

/** Parameter decorator: the request's validated `Idempotency-Key`. */
export const IdempotencyKey = createParamDecorator((_data: unknown, ctx: ExecutionContext) =>
  parseIdempotencyKey(ctx.switchToHttp().getRequest<Request>().headers['idempotency-key']),
);
