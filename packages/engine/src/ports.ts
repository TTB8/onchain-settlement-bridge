/**
 * @file The two things the engine needs from the outside world besides the database: the time and
 * fresh ids. Both are injected so that logic never calls `Date.now()` or `randomUUID()` itself.
 *
 * Why: a backoff schedule, a stale-lock timeout or an audit timestamp that reads the wall clock
 * cannot be tested without sleeping, and a test that sleeps is a test that flakes. Every
 * timestamp the engine writes comes from `Clock.now()` and is passed to SQL as a parameter
 * (never `now()` in SQL), so a test can move time forward deterministically.
 */

import { randomUUID } from 'node:crypto';

/** The source of the current time (UTC). */
export interface Clock {
  /** The current instant. Must return a new `Date` each call. */
  now(): Date;
}

/** The source of fresh UUIDs (operation ids, which become on-chain references, and lock tokens). */
export interface IdSource {
  /** A new random v4 UUID, lowercase canonical form. */
  uuid(): string;
}

/** The real clock. Use in production wiring only; logic takes a `Clock`. */
export const systemClock: Clock = Object.freeze({ now: () => new Date() });

/** Cryptographically random v4 UUIDs. Use in production wiring only; logic takes an `IdSource`. */
export const randomIds: IdSource = Object.freeze({ uuid: () => randomUUID() });
