/**
 * @file The outbox dispatcher: claims due outbox rows, hands each to a handler (piece B: the
 * submitter), and records the outcome, without ever holding a database transaction or a row lock
 * across the handler call (ADR 0002).
 *
 * The cycle (`runOnce`):
 *
 * 1. Reap: a `processing` row whose lease is older than `lockTimeoutMs` has an expired lease (its
 *    worker crashed, hung, or was too slow). If it already used up its attempts it becomes `dead`
 *    (with an audit row); otherwise it is eligible to be claimed again in step 2.
 * 2. Claim, in ONE autocommit statement: `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP
 *    LOCKED LIMIT n)`. Due `pending` rows and stale `processing` rows are set to `processing` with
 *    `locked_at`, a unique `locked_by` lease token and `attempts_count + 1`. SKIP LOCKED means two
 *    dispatchers never wait on, or both take, the same row. The statement commits before any
 *    handler runs, so other connections can see who holds the row.
 * 3. For each row, in order:
 *    a. Renew the lease (`locked_at = now`, fenced by the token). A row that waited behind slower
 *       rows of the same batch may have gone stale and been taken by another worker: then the
 *       renewal changes nothing and the row is SKIPPED, its handler never called (review M-2).
 *    b. Handle, outside any transaction, with a hard time limit `handlerTimeoutMs` (strictly below
 *       `lockTimeoutMs`) and a context offering `stillHolds()` (re-check the lease right before an
 *       irreversible step such as a broadcast) and an `AbortSignal` that fires at the time limit.
 *       Because every row is renewed just before its handler runs, a lease covers at most one
 *       handler call, so the batch size does not have to fit inside the lock timeout.
 *    c. Outcomes: `done`; `{ retryAt }` (a deliberate wait: the attempt is given back, the date is
 *       clamped to at least `now + baseMs`, and a row older than `maxWaitAgeMs` is dead-lettered
 *       with an audit row instead); `{ failed: code, detail? }` (dead + audit row). A thrown error,
 *       a timeout or a malformed outcome is an UNKNOWN outcome, never a failure (ADR 0009): the row
 *       is retried with exponential backoff, and dead at `maxAttempts`.
 * 4. Finish, in one statement fenced by the lease token: only the worker that still holds the
 *    lease can record the outcome, so a row's outcome is recorded once.
 *
 * Every error text written (`last_error`, audit notes) goes through `describeError` /
 * `sanitizeText`: class name, URLs redacted, at most 1000 characters.
 *
 * Every time is taken from the injected clock and passed to SQL as a parameter. The handler time
 * limit is wall-clock (a timer), which is what bounds a real handler.
 */

import { type OutboxMessage, type PrismaClient } from '@bridge/db';
import { auditEntryFor } from '@bridge/domain';

import { HandlerTimeoutError, InvalidRequestError } from './errors';
import { writeAudit } from './ledger-writes';
import type { Clock, IdSource } from './ports';
import { describeError, sanitizeText } from './redact';
import type { Tx } from './transaction';

/** What the handler decided for one row. */
export type OutboxOutcome =
  'done' | { readonly retryAt: Date } | { readonly failed: string; readonly detail?: string };

/** What the dispatcher gives the handler besides the row. */
export interface HandlerContext {
  /**
   * Whether this dispatcher still holds the row's lease (same token, still processing, not
   * stale). Call it right before an irreversible step (a broadcast); if it is false, stop.
   */
  stillHolds(): Promise<boolean>;
  /** Aborted when the handler's time limit is reached. */
  readonly signal: AbortSignal;
}

/** Processes one outbox row (piece B implements it). Must be safe to call twice for one row. */
export interface OutboxHandler {
  /**
   * Handles one claimed row. Called outside any database transaction, with a time limit.
   *
   * @param row The claimed row (status `processing`, with this dispatcher's lease).
   * @param context The lease check and the abort signal.
   */
  handle(row: OutboxMessage, context: HandlerContext): Promise<OutboxOutcome>;
}

/** Exponential backoff for rows whose handler threw. */
export interface BackoffPolicy {
  /** Delay after the first failed attempt, in ms; also the shortest deliberate wait. */
  readonly baseMs: number;
  /** Ceiling for any delay, in ms. */
  readonly maxMs: number;
  /** Claims a failing row may use before it is dead-lettered (>= 1). */
  readonly maxAttempts: number;
}

/** Construction options for `OutboxDispatcher`. */
export interface OutboxDispatcherOptions {
  /** The database. */
  readonly prisma: PrismaClient;
  /** The time source. */
  readonly clock: Clock;
  /** The source of lease tokens. */
  readonly ids: IdSource;
  /** This worker's name (goes into `locked_by`, with a per-claim token). */
  readonly workerId: string;
  /** The row processor. */
  readonly handler: OutboxHandler;
  /** Rows per claim. Default 10. */
  readonly batchSize?: number;
  /** A `processing` lease older than this is stale (its worker is presumed gone). Default 5 min. */
  readonly lockTimeoutMs?: number;
  /** Hard limit on one handler call; must be below `lockTimeoutMs`. Default min(60 s, lock/2). */
  readonly handlerTimeoutMs?: number;
  /** A row that keeps waiting past this age (since it was created) is dead-lettered. Default 24 h. */
  readonly maxWaitAgeMs?: number;
  /** Backoff for thrown handler errors. Default 1 s doubling to 10 min, 10 attempts. */
  readonly backoff?: BackoffPolicy;
}

/** What one `runOnce` did. */
export interface DispatchSummary {
  /** Rows claimed this cycle. */
  readonly claimed: number;
  /** Rows the handler finished. */
  readonly done: number;
  /** Rows scheduled to run again (handler wait, thrown error or timeout). */
  readonly retried: number;
  /** Rows dead-lettered (handler failure, attempts exhausted, waited too long). */
  readonly dead: number;
  /** Rows whose lease another worker took before this one renewed or finished it. */
  readonly lostLease: number;
  /** Stale rows dead-lettered in the reap step (their attempts were already used up). */
  readonly reaped: number;
}

/** The default backoff: 1 s, 2 s, 4 s ... capped at 10 min; 10 attempts. */
export const DEFAULT_BACKOFF: BackoffPolicy = Object.freeze({
  baseMs: 1_000,
  maxMs: 600_000,
  maxAttempts: 10,
});

/**
 * The delay before retrying a row that has used `attempts` claims: `baseMs * 2^(attempts - 1)`,
 * capped at `maxMs`. Pure, so the schedule is testable on its own.
 *
 * @param policy The backoff policy.
 * @param attempts Claims used so far (>= 1).
 */
export function backoffDelayMs(policy: BackoffPolicy, attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  // 2^31 ms is already ~25 days; stop doubling well before floating point gets inexact.
  const factor = 2 ** Math.min(exponent, 30);
  return Math.min(policy.maxMs, policy.baseMs * factor);
}

function validatePolicy(p: BackoffPolicy): void {
  if (!(p.baseMs > 0) || !(p.maxMs >= p.baseMs)) {
    throw new InvalidRequestError('backoff needs 0 < baseMs <= maxMs');
  }
  if (!Number.isInteger(p.maxAttempts) || p.maxAttempts < 1) {
    throw new InvalidRequestError('backoff.maxAttempts must be an integer >= 1');
  }
}

type Handled = OutboxOutcome | { readonly thrown: unknown };

/** Claims outbox rows and hands them to a handler. See the file comment. */
export class OutboxDispatcher {
  private readonly prisma: PrismaClient;
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly workerId: string;
  private readonly handler: OutboxHandler;
  private readonly batchSize: number;
  private readonly lockTimeoutMs: number;
  private readonly handlerTimeoutMs: number;
  private readonly maxWaitAgeMs: number;
  private readonly backoff: BackoffPolicy;

  /** @param options Database, clock, ids, worker name, handler and policies. */
  constructor(options: OutboxDispatcherOptions) {
    if (typeof options.workerId !== 'string' || options.workerId.length === 0) {
      throw new InvalidRequestError('workerId must be a non-empty string');
    }
    const batchSize = options.batchSize ?? 10;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new InvalidRequestError('batchSize must be an integer >= 1');
    }
    const lockTimeoutMs = options.lockTimeoutMs ?? 300_000;
    if (!(lockTimeoutMs > 0)) throw new InvalidRequestError('lockTimeoutMs must be > 0');
    const handlerTimeoutMs =
      options.handlerTimeoutMs ?? Math.min(60_000, Math.floor(lockTimeoutMs / 2));
    // Strictly below the lock timeout: a handler still running when its lease goes stale could
    // run concurrently with the worker that takes the row over. The batch size does not enter
    // this bound because every row's lease is renewed right before its own handler call.
    if (!(handlerTimeoutMs > 0) || !(handlerTimeoutMs < lockTimeoutMs)) {
      throw new InvalidRequestError('handlerTimeoutMs must be > 0 and below lockTimeoutMs');
    }
    const maxWaitAgeMs = options.maxWaitAgeMs ?? 86_400_000;
    if (!(maxWaitAgeMs > 0)) throw new InvalidRequestError('maxWaitAgeMs must be > 0');
    const backoff = options.backoff ?? DEFAULT_BACKOFF;
    validatePolicy(backoff);
    this.prisma = options.prisma;
    this.clock = options.clock;
    this.ids = options.ids;
    this.workerId = options.workerId;
    this.handler = options.handler;
    this.batchSize = batchSize;
    this.lockTimeoutMs = lockTimeoutMs;
    this.handlerTimeoutMs = handlerTimeoutMs;
    this.maxWaitAgeMs = maxWaitAgeMs;
    this.backoff = backoff;
  }

  /** One reap-claim-handle-finish cycle. Rows are handled one after another, in claim order. */
  async runOnce(): Promise<DispatchSummary> {
    const reaped = await this.reapExhausted();
    const rows = await this.claim();
    let done = 0;
    let retried = 0;
    let dead = 0;
    let lostLease = 0;
    for (const row of rows) {
      const result = await this.process(row);
      if (result === 'lost') lostLease += 1;
      else if (result === 'done') done += 1;
      else if (result === 'retry') retried += 1;
      else dead += 1;
    }
    return { claimed: rows.length, done, retried, dead, lostLease, reaped };
  }

  /** Dead-letters stale `processing` rows that have no attempts left. */
  private async reapExhausted(): Promise<number> {
    const now = this.clock.now();
    const staleBefore = new Date(now.getTime() - this.lockTimeoutMs);
    const why = 'lease expired with no attempts left (worker crashed, hung or was too slow)';
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<OutboxIdRow[]>`
        UPDATE outbox_message
           SET status = 'dead', locked_at = NULL, locked_by = NULL, processed_at = ${now},
               last_error = ${why}, last_error_at = ${now}
         WHERE id IN (
           SELECT id FROM outbox_message
            WHERE status = 'processing' AND locked_at <= ${staleBefore}
              AND attempts_count >= ${this.backoff.maxAttempts}
            ORDER BY id
              FOR UPDATE SKIP LOCKED)
        RETURNING id::text AS id, operation_id::text AS operation_id,
                  compliance_change_id::text AS compliance_change_id, attempts_count`;
      for (const r of rows) await this.auditDead(tx, r, now, why);
      return rows.length;
    });
  }

  /** Claims due and stale rows in one statement (see step 2 in the file comment). */
  private async claim(): Promise<OutboxMessage[]> {
    const now = this.clock.now();
    const staleBefore = new Date(now.getTime() - this.lockTimeoutMs);
    const lease = `${this.workerId}/${this.ids.uuid()}`;
    const claimed = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE outbox_message
         SET status = 'processing', locked_at = ${now}, locked_by = ${lease},
             attempts_count = attempts_count + 1
       WHERE id IN (
         SELECT id FROM outbox_message
          WHERE ((status = 'pending' AND available_at <= ${now})
             OR (status = 'processing' AND locked_at <= ${staleBefore}))
            AND attempts_count < ${this.backoff.maxAttempts}
          ORDER BY available_at, id
          LIMIT ${this.batchSize}
            FOR UPDATE SKIP LOCKED)
      RETURNING id::text AS id`;
    if (claimed.length === 0) return [];
    // Read through Prisma for typed rows; the lease token makes sure they are the ones we hold.
    return this.prisma.outboxMessage.findMany({
      where: { id: { in: claimed.map((c) => c.id) }, lockedBy: lease },
      orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** Renews the lease of a row about to be handled. False when another worker took it. */
  private async renew(row: OutboxMessage): Promise<boolean> {
    const r = await this.prisma.outboxMessage.updateMany({
      where: { id: row.id, status: 'processing', lockedBy: row.lockedBy },
      data: { lockedAt: this.clock.now() },
    });
    return r.count === 1;
  }

  /** Whether this worker still holds a fresh lease on the row. */
  private async holds(row: OutboxMessage): Promise<boolean> {
    const staleBefore = new Date(this.clock.now().getTime() - this.lockTimeoutMs);
    const n = await this.prisma.outboxMessage.count({
      where: {
        id: row.id,
        status: 'processing',
        lockedBy: row.lockedBy,
        lockedAt: { gt: staleBefore },
      },
    });
    return n === 1;
  }

  /** Runs the handler under its time limit; any throw or timeout becomes `{ thrown }`. */
  private async runHandler(row: OutboxMessage): Promise<Handled> {
    const controller = new AbortController();
    const context: HandlerContext = {
      stillHolds: () => this.holds(row),
      signal: controller.signal,
    };
    const work = Promise.resolve().then(() => this.handler.handle(row, context));
    // If the timeout wins, a later rejection of `work` must not become an unhandled rejection.
    work.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new HandlerTimeoutError(`handler did not answer within ${this.handlerTimeoutMs} ms`),
        );
      }, this.handlerTimeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } catch (err) {
      // Unknown outcome (ADR 0009): never a failure, always a retry.
      return { thrown: err };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Renews, runs the handler (no transaction open) and records the outcome. */
  private async process(row: OutboxMessage): Promise<'done' | 'retry' | 'dead' | 'lost'> {
    if (!(await this.renew(row))) return 'lost';
    const outcome = await this.runHandler(row);
    const now = this.clock.now();
    if (outcome === 'done') {
      return (await this.finish(row, { status: 'done', processedAt: now })) ? 'done' : 'lost';
    }
    if (typeof outcome === 'object' && outcome !== null && 'failed' in outcome) {
      const code = sanitizeText(String(outcome.failed), 100);
      const detail =
        outcome.detail === undefined ? '' : `: ${sanitizeText(String(outcome.detail))}`;
      return (await this.deadLetter(row, now, sanitizeText(`failed:${code}${detail}`)))
        ? 'dead'
        : 'lost';
    }
    if (typeof outcome === 'object' && outcome !== null && 'retryAt' in outcome) {
      const at = outcome.retryAt;
      if (at instanceof Date && !Number.isNaN(at.getTime())) {
        if (now.getTime() - row.createdAt.getTime() >= this.maxWaitAgeMs) {
          return (await this.deadLetter(
            row,
            now,
            `still waiting after ${this.maxWaitAgeMs} ms since it was created`,
          ))
            ? 'dead'
            : 'lost';
        }
        // A deliberate wait is not a failed attempt: give the claim back. Never sooner than baseMs.
        const earliest = now.getTime() + this.backoff.baseMs;
        const ok = await this.finish(row, {
          status: 'pending',
          availableAt: new Date(Math.max(at.getTime(), earliest)),
          attemptsCount: row.attemptsCount - 1,
        });
        return ok ? 'retry' : 'lost';
      }
      return this.retryOrDie(row, now, 'InvalidOutcome: retryAt is not a valid Date');
    }
    if (typeof outcome === 'object' && outcome !== null && 'thrown' in outcome) {
      return this.retryOrDie(row, now, describeError(outcome.thrown));
    }
    return this.retryOrDie(row, now, 'InvalidOutcome: the handler returned an unknown outcome');
  }

  /** An unknown outcome: back off, or dead-letter once the attempts are used up. */
  private async retryOrDie(
    row: OutboxMessage,
    now: Date,
    error: string,
  ): Promise<'retry' | 'dead' | 'lost'> {
    if (row.attemptsCount >= this.backoff.maxAttempts) {
      const why = sanitizeText(`attempts exhausted (${row.attemptsCount}); last: ${error}`);
      return (await this.deadLetter(row, now, why)) ? 'dead' : 'lost';
    }
    const delay = backoffDelayMs(this.backoff, row.attemptsCount);
    const ok = await this.finish(row, {
      status: 'pending',
      availableAt: new Date(now.getTime() + delay),
      lastError: error,
      lastErrorAt: now,
    });
    return ok ? 'retry' : 'lost';
  }

  /**
   * Updates the row only if this worker still holds its lease (same token, still processing).
   * Releases the lock columns. Returns false when the lease was lost.
   */
  private async finish(
    row: OutboxMessage,
    data: {
      status: 'done' | 'pending' | 'dead';
      processedAt?: Date;
      availableAt?: Date;
      attemptsCount?: number;
      lastError?: string;
      lastErrorAt?: Date;
    },
    tx: Tx | PrismaClient = this.prisma,
  ): Promise<boolean> {
    const r = await tx.outboxMessage.updateMany({
      where: { id: row.id, status: 'processing', lockedBy: row.lockedBy },
      data: { ...data, lockedAt: null, lockedBy: null },
    });
    return r.count === 1;
  }

  /** Marks a held row dead (recording why) and writes the audit row, in one transaction. */
  private async deadLetter(row: OutboxMessage, now: Date, why: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const ok = await this.finish(
        row,
        { status: 'dead', processedAt: now, lastError: why, lastErrorAt: now },
        tx,
      );
      if (ok) {
        await this.auditDead(
          tx,
          {
            id: row.id,
            operation_id: row.operationId,
            compliance_change_id: row.complianceChangeId,
            attempts_count: row.attemptsCount,
          },
          now,
          why,
        );
      }
      return ok;
    });
  }

  private async auditDead(tx: Tx, r: OutboxIdRow, at: Date, why: string): Promise<void> {
    const isOperation = r.operation_id !== null;
    const entityId = r.operation_id ?? r.compliance_change_id ?? r.id;
    await writeAudit(
      tx,
      auditEntryFor({
        // The domain's AuditEntity has no 'outbox'; the row is audited under its subject.
        entity: isOperation ? 'operation' : 'compliance_change',
        entityId,
        fromState: 'outbox:processing',
        toState: 'outbox:dead',
        detail: why,
        at,
      }),
      { outboxId: r.id, attempts: r.attempts_count, worker: this.workerId },
    );
  }
}

interface OutboxIdRow {
  id: string;
  operation_id: string | null;
  compliance_change_id: string | null;
  attempts_count: number;
}
