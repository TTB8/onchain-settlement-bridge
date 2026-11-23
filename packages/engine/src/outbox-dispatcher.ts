/**
 * @file The outbox dispatcher: claims due outbox rows, hands each to a handler (piece B: the
 * submitter), and records the outcome, without ever holding a database transaction or a row lock
 * across the handler call (ADR 0002).
 *
 * The cycle (`runOnce`):
 *
 * 1. Reap: a row stuck in `processing` whose lock is older than `lockTimeoutMs` belongs to a worker
 *    that crashed (or hung). If it already used up its attempts it becomes `dead` (with an audit
 *    row); otherwise it is eligible to be claimed again in step 2.
 * 2. Claim, in ONE autocommit statement: `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP
 *    LOCKED LIMIT n)`. Due `pending` rows and stale `processing` rows are set to `processing` with
 *    `locked_at`, a unique `locked_by` lease token and `attempts_count + 1`. SKIP LOCKED means two
 *    dispatchers never wait on, or both take, the same row. The statement commits before the
 *    handler runs, so other connections can see who holds the row.
 * 3. Handle, outside any transaction. The handler answers `done`, `{ retryAt }` (a deliberate wait,
 *    for example for confirmations) or `{ failed }`. A thrown error is an UNKNOWN outcome, never a
 *    failure (ADR 0009): the row is retried with exponential backoff.
 * 4. Finish, in one statement fenced by the lease token: only the worker that still holds the
 *    row's lease can finish it. A worker whose lease was taken over (it was too slow and its lock
 *    went stale) changes nothing, so a row's outcome is recorded once.
 *
 * Attempts: `attempts_count` goes up on every claim. A deliberate `{ retryAt }` gives the attempt
 * back (it was not a failure); a thrown error, or a crash that leaves the lock to go stale, keeps
 * it. When a failing row reaches `maxAttempts`, it becomes `dead` and a person must look.
 *
 * Every time is taken from the injected clock and passed to SQL as a parameter.
 */

import { type OutboxMessage, type PrismaClient } from '@bridge/db';
import { auditEntryFor } from '@bridge/domain';

import { InvalidRequestError } from './errors';
import { writeAudit } from './ledger-writes';
import type { Clock, IdSource } from './ports';
import type { Tx } from './transaction';

/** What the handler decided for one row. */
export type OutboxOutcome = 'done' | { readonly retryAt: Date } | { readonly failed: string };

/** Processes one outbox row (piece B implements it). Must be safe to call twice for one row. */
export interface OutboxHandler {
  /**
   * Handles one claimed row. Called outside any database transaction.
   *
   * @param row The claimed row (status `processing`, with this dispatcher's lease).
   */
  handle(row: OutboxMessage): Promise<OutboxOutcome>;
}

/** Exponential backoff for rows whose handler threw. */
export interface BackoffPolicy {
  /** Delay after the first failed attempt, in ms. */
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
  /** A `processing` lock older than this is stale (its worker is presumed dead). Default 5 min. */
  readonly lockTimeoutMs?: number;
  /** Backoff for thrown handler errors. Default 1 s doubling to 10 min, 10 attempts. */
  readonly backoff?: BackoffPolicy;
}

/** What one `runOnce` did. */
export interface DispatchSummary {
  /** Rows claimed this cycle. */
  readonly claimed: number;
  /** Rows the handler finished. */
  readonly done: number;
  /** Rows scheduled to run again (handler wait or thrown error). */
  readonly retried: number;
  /** Rows dead-lettered (handler failure, or attempts exhausted). */
  readonly dead: number;
  /** Rows whose lease another worker took over before this one finished. */
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

/** Claims outbox rows and hands them to a handler. See the file comment. */
export class OutboxDispatcher {
  private readonly prisma: PrismaClient;
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly workerId: string;
  private readonly handler: OutboxHandler;
  private readonly batchSize: number;
  private readonly lockTimeoutMs: number;
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
    const backoff = options.backoff ?? DEFAULT_BACKOFF;
    validatePolicy(backoff);
    this.prisma = options.prisma;
    this.clock = options.clock;
    this.ids = options.ids;
    this.workerId = options.workerId;
    this.handler = options.handler;
    this.batchSize = batchSize;
    this.lockTimeoutMs = lockTimeoutMs;
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
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<OutboxIdRow[]>`
        UPDATE outbox_message
           SET status = 'dead', locked_at = NULL, locked_by = NULL, processed_at = ${now}
         WHERE id IN (
           SELECT id FROM outbox_message
            WHERE status = 'processing' AND locked_at <= ${staleBefore}
              AND attempts_count >= ${this.backoff.maxAttempts}
            ORDER BY id
              FOR UPDATE SKIP LOCKED)
        RETURNING id::text AS id, operation_id::text AS operation_id,
                  compliance_change_id::text AS compliance_change_id, attempts_count`;
      for (const r of rows) {
        await this.auditDead(tx, r, now, 'lock went stale with no attempts left (worker crashed)');
      }
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

  /** Runs the handler for one row (no transaction open) and records the outcome. */
  private async process(row: OutboxMessage): Promise<'done' | 'retry' | 'dead' | 'lost'> {
    let outcome: OutboxOutcome | { thrown: unknown };
    try {
      outcome = await this.handler.handle(row);
    } catch (err) {
      // Unknown outcome (ADR 0009): never a failure, always a retry.
      outcome = { thrown: err };
    }
    const now = this.clock.now();
    if (outcome === 'done') {
      return (await this.finish(row, { status: 'done', processedAt: now })) ? 'done' : 'lost';
    }
    if ('failed' in outcome) {
      return (await this.deadLetter(row, now, `handler failed: ${outcome.failed}`))
        ? 'dead'
        : 'lost';
    }
    if ('retryAt' in outcome) {
      // A deliberate wait is not a failed attempt: give the claim back.
      const ok = await this.finish(row, {
        status: 'pending',
        availableAt: outcome.retryAt,
        attemptsCount: row.attemptsCount - 1,
      });
      return ok ? 'retry' : 'lost';
    }
    if (row.attemptsCount >= this.backoff.maxAttempts) {
      return (await this.deadLetter(row, now, `attempts exhausted (${row.attemptsCount})`))
        ? 'dead'
        : 'lost';
    }
    const delay = backoffDelayMs(this.backoff, row.attemptsCount);
    const ok = await this.finish(row, {
      status: 'pending',
      availableAt: new Date(now.getTime() + delay),
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
    },
    tx: Tx | PrismaClient = this.prisma,
  ): Promise<boolean> {
    const r = await tx.outboxMessage.updateMany({
      where: { id: row.id, status: 'processing', lockedBy: row.lockedBy },
      data: { ...data, lockedAt: null, lockedBy: null },
    });
    return r.count === 1;
  }

  /** Marks a held row dead and writes the audit row, in one transaction. */
  private async deadLetter(row: OutboxMessage, now: Date, why: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const ok = await this.finish(row, { status: 'dead', processedAt: now }, tx);
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
