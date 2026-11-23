/**
 * @file Running one unit of work in one interactive database transaction, retried a bounded number
 * of times when Postgres reports a serialization failure (40001) or a deadlock (40P01).
 *
 * Why retry at all: under SERIALIZABLE or REPEATABLE READ, two transactions spending the same
 * account cannot both commit; the loser gets 40001 and the correct reaction is to run the whole
 * transaction again from the first read (never to resume halfway). Why bounded: an unbounded loop
 * under sustained contention is an outage that looks like latency. Beyond the bound the caller
 * gets a typed `RetriesExhaustedError` and decides.
 *
 * The callback must be safe to run more than once: it must read everything it decides on inside
 * the transaction and must not cause side effects outside the database (no chain calls, ADR 0002).
 */

import { Prisma, type PrismaClient } from '@bridge/db';

import { RetriesExhaustedError } from './errors';

/** Isolation levels the engine may run at. READ COMMITTED + row locks is the default. */
export type IsolationLevel = 'ReadCommitted' | 'RepeatableRead' | 'Serializable';

/** How transactions are run. */
export interface TransactionOptions {
  /** Isolation level. Default `ReadCommitted` (correct here because every read is under a row lock). */
  readonly isolationLevel?: IsolationLevel;
  /** Total tries including the first (>= 1). Default 3. */
  readonly maxAttempts?: number;
  /** Milliseconds to wait for a pooled connection. Default 10 000. */
  readonly maxWaitMs?: number;
  /** Milliseconds the transaction may stay open before Prisma rolls it back. Default 15 000. */
  readonly timeoutMs?: number;
}

/** What a transaction returned, and how many tries it took. */
export interface TransactionOutcome<T> {
  /** The callback's result from the try that committed. */
  readonly value: T;
  /** 1 when the first try committed. */
  readonly attempts: number;
}

/** The transaction client handed to the callback. */
export type Tx = Prisma.TransactionClient;

const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);

function sqlStateOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const meta = (err as { meta?: unknown }).meta;
  if (typeof meta === 'object' && meta !== null) {
    const code = (meta as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Whether `err` means "run the whole transaction again": Prisma's P2034 (write conflict or
 * deadlock), or a raw-query failure (P2010) whose SQLSTATE is 40001 / 40P01. Every other error,
 * including the guards' `check_violation`s, is final.
 *
 * @param err Whatever the transaction threw.
 */
export function isRetryableTransactionError(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code === 'P2034') return true;
  const state = sqlStateOf(err);
  if (state !== undefined && RETRYABLE_SQLSTATES.has(state)) return true;
  // A raw query reports the SQLSTATE only in its message ("Code: `40001`").
  return err.code === 'P2010' && /Code: `(40001|40P01)`/.test(err.message);
}

/**
 * Runs `fn` in one interactive transaction, retrying the whole of it on a retryable conflict
 * (see `isRetryableTransactionError`) up to `maxAttempts` tries in total, and on any error for
 * which `alsoRetry` returns true. Throws `RetriesExhaustedError` (with the last error as `cause`)
 * when every try conflicted, and rethrows any other error at once.
 *
 * @param prisma The client that opens the transaction.
 * @param fn The unit of work; receives the transaction client and the 1-based try number.
 * @param options Isolation, retry bound and timeouts.
 * @param alsoRetry Extra retryable errors (for example a unique-key race the next try resolves).
 */
export async function runTransaction<T>(
  prisma: PrismaClient,
  fn: (tx: Tx, attempt: number) => Promise<T>,
  options: TransactionOptions = {},
  alsoRetry: (err: unknown) => boolean = () => false,
): Promise<TransactionOutcome<T>> {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be an integer >= 1, got ${maxAttempts}`);
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const value = await prisma.$transaction((tx) => fn(tx, attempt), {
        isolationLevel: options.isolationLevel ?? 'ReadCommitted',
        maxWait: options.maxWaitMs ?? 10_000,
        timeout: options.timeoutMs ?? 15_000,
      });
      return { value, attempts: attempt };
    } catch (err) {
      if (!isRetryableTransactionError(err) && !alsoRetry(err)) throw err;
      lastError = err;
    }
  }
  throw new RetriesExhaustedError(maxAttempts, lastError);
}
