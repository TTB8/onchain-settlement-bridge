/**
 * @file Every error response of the API as an RFC 9457 problem (`application/problem+json`), and
 * the pure mapping from anything thrown to one.
 *
 * Why a closed catalog: a client branches on `type` / `code`, so both are stable identifiers that
 * never change once published, and the `detail` of each is a FIXED sentence chosen here, never an
 * error message passed through. Engine messages carry other users' ids, wallet addresses or
 * balances, Prisma messages carry SQL, chain errors carry RPC URLs: none of that may reach a
 * response. The only variable parts are the fields listed per problem (`errors` for validation,
 * `existingOperationId` for an idempotency conflict, which names the requester's OWN operation).
 *
 * Anything not recognised is a 500 `internal` problem with no detail beyond "see the request id";
 * the error itself goes to the log, redacted.
 */

import { HttpException } from '@nestjs/common';
import { Prisma } from '@bridge/db';
import { EngineError } from '@bridge/engine';

/** The stable problem codes (also the last segment of each `type`). */
export type ProblemCode =
  | 'VALIDATION_FAILED'
  | 'MALFORMED_JSON'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'BAD_REQUEST_BODY'
  | 'IDEMPOTENCY_KEY_MISSING'
  | 'IDEMPOTENCY_KEY_INVALID'
  | 'AMOUNT_ABOVE_LIMIT'
  | 'SELF_TRANSFER'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'USER_NOT_FOUND'
  | 'OPERATION_NOT_FOUND'
  | 'COMPLIANCE_CHANGE_NOT_FOUND'
  | 'WALLET_ALREADY_REGISTERED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INSUFFICIENT_FUNDS'
  | 'NO_ACTIVE_DEPLOYMENT'
  | 'DEPLOYMENT_MISMATCH'
  | 'DEPLOYMENT_NOT_REGISTERED'
  | 'BUSY'
  | 'NOT_READY'
  | 'INTERNAL';

/** One entry of the catalog. */
export interface ProblemSpec {
  /** HTTP status. */
  readonly status: number;
  /** Short, human summary (constant per code). */
  readonly title: string;
  /** The fixed explanation. */
  readonly detail: string;
  /** Seconds a client should wait before retrying (sent as `Retry-After`), for 503s. */
  readonly retryAfterSeconds?: number;
}

/** The prefix of every problem `type`: a URN, stable and not pretending to be a web page. */
export const PROBLEM_TYPE_PREFIX = 'urn:bridge:problem:';

/** The catalog. */
export const PROBLEMS: Readonly<Record<ProblemCode, ProblemSpec>> = Object.freeze({
  VALIDATION_FAILED: {
    status: 400,
    title: 'Validation failed',
    detail: 'The request does not match the documented schema; see errors.',
  },
  MALFORMED_JSON: {
    status: 400,
    title: 'Malformed JSON',
    detail: 'The request body is not valid JSON.',
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    title: 'Payload too large',
    detail: 'The request body exceeds the size limit.',
  },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    title: 'Unsupported media type',
    detail: 'The request body uses a character set or content encoding this API does not accept.',
  },
  BAD_REQUEST_BODY: {
    status: 400,
    title: 'Bad request body',
    detail: 'The request body could not be read (aborted, truncated or of an invalid size).',
  },
  IDEMPOTENCY_KEY_MISSING: {
    status: 400,
    title: 'Idempotency-Key required',
    detail: 'This request changes state and must carry an Idempotency-Key header.',
  },
  IDEMPOTENCY_KEY_INVALID: {
    status: 400,
    title: 'Invalid Idempotency-Key',
    detail: 'The Idempotency-Key header must be 1 to 255 visible ASCII characters, no spaces.',
  },
  AMOUNT_ABOVE_LIMIT: {
    status: 400,
    title: 'Amount above limit',
    detail: 'The amount is above the largest amount one request may move.',
  },
  SELF_TRANSFER: {
    status: 400,
    title: 'Self transfer',
    detail: 'A transfer must name two different users.',
  },
  UNAUTHENTICATED: {
    status: 401,
    title: 'Unauthenticated',
    detail: 'A valid bearer token is required.',
  },
  FORBIDDEN: {
    status: 403,
    title: 'Forbidden',
    detail: 'The presented credential is not allowed to use this route.',
  },
  NOT_FOUND: { status: 404, title: 'Not found', detail: 'No such route.' },
  USER_NOT_FOUND: {
    status: 404,
    title: 'User not found',
    detail: 'A user named in the request does not exist.',
  },
  OPERATION_NOT_FOUND: {
    status: 404,
    title: 'Operation not found',
    detail: 'No operation has this id.',
  },
  COMPLIANCE_CHANGE_NOT_FOUND: {
    status: 404,
    title: 'Compliance change not found',
    detail: 'No compliance change has this id.',
  },
  WALLET_ALREADY_REGISTERED: {
    status: 409,
    title: 'Wallet already registered',
    detail: 'This wallet address already belongs to a user.',
  },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    title: 'Idempotency key reused',
    detail:
      'This Idempotency-Key was already used for a different request; use a new key for a new request.',
  },
  INSUFFICIENT_FUNDS: {
    status: 422,
    title: 'Insufficient funds',
    detail: 'The available balance does not cover the amount.',
  },
  NO_ACTIVE_DEPLOYMENT: {
    status: 503,
    title: 'No active deployment',
    detail:
      'No contract deployment is active right now (usually a switch in progress). Nothing was written; retry with the same Idempotency-Key.',
    retryAfterSeconds: 5,
  },
  DEPLOYMENT_MISMATCH: {
    status: 503,
    title: 'Deployment mismatch',
    detail:
      'The active contract deployment is not the one this service is configured for. Nothing was written; retry later with the same Idempotency-Key.',
    retryAfterSeconds: 30,
  },
  DEPLOYMENT_NOT_REGISTERED: {
    status: 503,
    title: 'Deployment not registered',
    detail: 'The configured contract deployment has no record in the database yet.',
    retryAfterSeconds: 30,
  },
  BUSY: {
    status: 503,
    title: 'Busy',
    detail: 'The request kept conflicting with concurrent requests. Nothing was written; retry.',
    retryAfterSeconds: 1,
  },
  NOT_READY: {
    status: 503,
    title: 'Not ready',
    detail:
      'A dependency (the database or the node) is not available right now. Nothing was written; retry later.',
    retryAfterSeconds: 5,
  },
  INTERNAL: {
    status: 500,
    title: 'Internal error',
    detail: 'The request failed unexpectedly. Quote the request id when reporting it.',
  },
});

/** One field-level validation error. */
export interface FieldError {
  /** The field (a body property, `Idempotency-Key`, a path or query parameter). */
  readonly field: string;
  /** What is wrong (a fixed sentence or the validator's constraint message). */
  readonly message: string;
}

/** The problem+json body. */
export interface ProblemBody {
  /** Stable URN, `urn:bridge:problem:<code>`. */
  readonly type: string;
  /** Constant per code. */
  readonly title: string;
  /** HTTP status. */
  readonly status: number;
  /** The fixed explanation. */
  readonly detail: string;
  /** The stable code. */
  readonly code: ProblemCode;
  /** This request: `urn:request:<request id>` (also the `X-Request-Id` header). */
  readonly instance?: string;
  /** Field errors (validation problems only). */
  readonly errors?: readonly FieldError[];
  /** Further safe fields (listed per problem). */
  readonly [extension: string]: unknown;
}

/** A problem the API raises itself (validation, auth, not found, conflicts it detects). */
export class ApiProblem extends Error {
  /**
   * @param code The catalog code.
   * @param extensions Safe extra fields for the body (`errors`, ids the caller owns).
   */
  constructor(
    readonly code: ProblemCode,
    readonly extensions: Readonly<Record<string, unknown>> = {},
  ) {
    super(PROBLEMS[code].title);
    this.name = 'ApiProblem';
  }
}

/** The result of mapping a thrown value. */
export interface MappedProblem {
  /** The response body. */
  readonly body: ProblemBody;
  /** Extra response headers (`Retry-After`, `WWW-Authenticate`). */
  readonly headers: Readonly<Record<string, string>>;
  /** True when the error was not recognised (the caller logs it). */
  readonly unexpected: boolean;
}

/** Engine error codes and the problem each becomes. Codes not listed are internal errors. */
const ENGINE_TO_PROBLEM: Readonly<Partial<Record<EngineError['code'], ProblemCode>>> = {
  INVALID_REQUEST: 'VALIDATION_FAILED',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  SELF_TRANSFER: 'SELF_TRANSFER',
  UNKNOWN_USER: 'USER_NOT_FOUND',
  NO_ACTIVE_DEPLOYMENT: 'NO_ACTIVE_DEPLOYMENT',
  DEPLOYMENT_MISMATCH: 'DEPLOYMENT_MISMATCH',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  OPERATION_NOT_FOUND: 'OPERATION_NOT_FOUND',
  COMPLIANCE_CHANGE_NOT_FOUND: 'COMPLIANCE_CHANGE_NOT_FOUND',
  RETRIES_EXHAUSTED: 'BUSY',
};

/** The id of the requester's own operation or change named by an idempotency conflict. */
function conflictExtensions(err: EngineError): Record<string, unknown> {
  const existing = err as { existingOperationId?: unknown; existingChangeId?: unknown };
  if (typeof existing.existingOperationId === 'string') {
    return { existingOperationId: existing.existingOperationId };
  }
  if (typeof existing.existingChangeId === 'string') {
    return { existingComplianceChangeId: existing.existingChangeId };
  }
  return {};
}

/**
 * Prisma's "the database is unreachable" codes: P1001 can't reach the server, P1002 timed out
 * reaching it, P1017 the server closed the connection. A request that meets one wrote nothing
 * (the transaction never committed), so it is a retryable 503, not an internal error.
 *
 * At query time Prisma reports an unreachable server as a `PrismaClientInitializationError`
 * WITHOUT an `errorCode` (observed with 6.19), so every initialization error counts: the client
 * never connected, nothing ran (an authentication failure lands here too; it is 503 as well,
 * and the warn log line says why).
 */
export const DATABASE_UNAVAILABLE_CODES: ReadonlySet<string> = new Set(['P1001', 'P1002', 'P1017']);

/** Whether `err` is Prisma reporting the database as unreachable. */
export function isDatabaseUnavailable(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return DATABASE_UNAVAILABLE_CODES.has(err.code);
  }
  return false;
}

/**
 * Body-parser (raw-body) errors carry a `type` string and an HTTP `status`. Every one with a 4xx
 * status is the client's fault and maps to a catalog problem (never a 500): parse failures,
 * too-large bodies, unsupported charsets and encodings, aborted or mis-sized bodies. A 5xx one
 * (for example `stream.encoding.set`, a server bug) stays an internal error.
 */
function bodyParserProblem(err: unknown): ProblemCode | null {
  const e = err as { type?: unknown; status?: unknown; statusCode?: unknown } | null;
  const type = e?.type;
  const status = typeof e?.status === 'number' ? e.status : e?.statusCode;
  if (typeof type !== 'string' || typeof status !== 'number' || status < 400 || status >= 500) {
    return null;
  }
  switch (type) {
    case 'entity.parse.failed':
      return 'MALFORMED_JSON';
    case 'entity.too.large':
      return 'PAYLOAD_TOO_LARGE';
    case 'charset.unsupported':
    case 'encoding.unsupported':
      return 'UNSUPPORTED_MEDIA_TYPE';
    default:
      return 'BAD_REQUEST_BODY';
  }
}

/** The Nest `HttpException`s the framework itself raises, by status. */
function httpProblem(status: number): ProblemCode | null {
  switch (status) {
    case 400:
      return 'VALIDATION_FAILED';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    default:
      return null;
  }
}

/**
 * Builds a problem body for `code`.
 *
 * @param code The catalog code.
 * @param requestId The request id, for `instance`.
 * @param extensions Safe extra fields.
 */
export function problemBody(
  code: ProblemCode,
  requestId: string | undefined,
  extensions: Readonly<Record<string, unknown>> = {},
): ProblemBody {
  const spec = PROBLEMS[code];
  return {
    ...extensions,
    type: `${PROBLEM_TYPE_PREFIX}${code.toLowerCase().replace(/_/g, '-')}`,
    title: spec.title,
    status: spec.status,
    detail: spec.detail,
    code,
    ...(requestId !== undefined ? { instance: `urn:request:${requestId}` } : {}),
  };
}

/** The headers a problem carries. */
function headersFor(code: ProblemCode): Record<string, string> {
  const spec = PROBLEMS[code];
  const headers: Record<string, string> = {};
  if (spec.retryAfterSeconds !== undefined) headers['Retry-After'] = String(spec.retryAfterSeconds);
  if (code === 'UNAUTHENTICATED') headers['WWW-Authenticate'] = 'Bearer';
  return headers;
}

/**
 * Maps anything thrown to a problem. Pure: no logging, no I/O.
 *
 * @param err Whatever was thrown.
 * @param requestId The request id, for `instance`.
 */
export function toProblem(err: unknown, requestId?: string): MappedProblem {
  let code: ProblemCode | null = null;
  let extensions: Readonly<Record<string, unknown>> = {};
  if (err instanceof ApiProblem) {
    code = err.code;
    extensions = err.extensions;
  } else if (err instanceof EngineError) {
    code = ENGINE_TO_PROBLEM[err.code] ?? null;
    if (code === 'IDEMPOTENCY_CONFLICT') extensions = conflictExtensions(err);
  } else if (err instanceof HttpException) {
    code = httpProblem(err.getStatus());
  } else if (isDatabaseUnavailable(err)) {
    code = 'NOT_READY';
  } else {
    code = bodyParserProblem(err);
  }
  const unexpected = code === null;
  const final = code ?? 'INTERNAL';
  return {
    body: problemBody(final, requestId, extensions),
    headers: headersFor(final),
    unexpected,
  };
}
