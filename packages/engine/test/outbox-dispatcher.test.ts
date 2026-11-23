/**
 * OutboxDispatcher on real Postgres: claiming (due rows only, SKIP LOCKED, visible before the
 * handler runs), outcomes (done, deliberate wait, failure, thrown error), the backoff schedule and
 * attempt cap, two dispatchers racing, stale-lock recovery after a crash, and the lease fence.
 */

import type { OutboxMessage } from '@bridge/db';

import {
  backoffDelayMs,
  type BackoffPolicy,
  DEFAULT_BACKOFF,
  type HandlerContext,
  InvalidRequestError,
  OutboxDispatcher,
  type OutboxDispatcherOptions,
  type OutboxHandler,
  type OutboxOutcome,
  type OperationService,
} from '../src';
import { createTestDatabase, type TestDatabase } from './support/database';
import {
  FakeClock,
  insertDeployment,
  insertUser,
  RecordingIds,
  serviceFor,
  type TestDeployment,
} from './support/fixtures';

let db: TestDatabase;
let dep: TestDeployment;
let service: OperationService;
let clock: FakeClock;

const POLICY: BackoffPolicy = { baseMs: 1_000, maxMs: 10_000, maxAttempts: 4 };
const LOCK_TIMEOUT = 60_000;

beforeAll(async () => {
  db = await createTestDatabase();
  dep = await insertDeployment(db.prisma);
});

afterAll(async () => {
  await db?.drop();
});

beforeEach(async () => {
  // Every test starts with an empty queue: retire whatever earlier tests left behind.
  await db.prisma.outboxMessage.updateMany({
    where: { status: { in: ['pending', 'processing'] } },
    data: { status: 'done', lockedAt: null, lockedBy: null },
  });
  clock = new FakeClock();
  service = serviceFor(db.prisma, dep, { clock });
});

let keyN = 0;
/** Creates `n` operations (deposits), hence `n` pending outbox rows, available at clock time. */
async function enqueue(n: number): Promise<string[]> {
  const u = await insertUser(db.prisma);
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const { operation } = await service.requestDeposit(u.id, 1n, `ob-${(keyN += 1)}`);
    const row = await db.prisma.outboxMessage.findFirstOrThrow({
      where: { operationId: operation.id },
    });
    ids.push(row.id);
  }
  return ids;
}

function dispatcher(
  handler: OutboxHandler,
  extra: Partial<OutboxDispatcherOptions> = {},
): OutboxDispatcher {
  return new OutboxDispatcher({
    prisma: db.prisma,
    clock,
    ids: new RecordingIds(),
    workerId: 'w1',
    handler,
    lockTimeoutMs: LOCK_TIMEOUT,
    backoff: POLICY,
    ...extra,
  });
}

const handlerOf = (
  fn: (row: OutboxMessage, ctx: HandlerContext) => Promise<OutboxOutcome>,
): OutboxHandler => ({
  handle: fn,
});

async function rowOf(id: string) {
  return db.prisma.outboxMessage.findUniqueOrThrow({ where: { id } });
}

describe('backoff schedule', () => {
  it('doubles from baseMs and caps at maxMs', () => {
    expect([1, 2, 3, 4, 5, 6].map((a) => backoffDelayMs(POLICY, a))).toEqual([
      1_000, 2_000, 4_000, 8_000, 10_000, 10_000,
    ]);
    expect(backoffDelayMs(POLICY, 0)).toBe(1_000);
    expect(backoffDelayMs(DEFAULT_BACKOFF, 1_000)).toBe(DEFAULT_BACKOFF.maxMs);
  });
});

describe('claiming', () => {
  it('claims due rows, commits the claim before the handler runs, marks done', async () => {
    const [id] = await enqueue(1);
    const observer = db.client();
    let seenFromOutside: OutboxMessage | null = null;
    const d = dispatcher(
      handlerOf(async (row) => {
        // Another connection must already see the claim: no transaction is held across the handler.
        seenFromOutside = await observer.outboxMessage.findUnique({ where: { id: row.id } });
        expect(row).toMatchObject({
          status: 'processing',
          attemptsCount: 1,
          lockedAt: clock.now(),
        });
        return 'done';
      }),
    );
    const summary = await d.runOnce();
    expect(summary).toEqual({ claimed: 1, done: 1, retried: 0, dead: 0, lostLease: 0, reaped: 0 });
    expect(seenFromOutside).toMatchObject({ status: 'processing', attemptsCount: 1 });
    expect((seenFromOutside as OutboxMessage | null)?.lockedBy).toMatch(/^w1\//);
    expect(await rowOf(id as string)).toMatchObject({
      status: 'done',
      processedAt: clock.now(),
      lockedAt: null,
      lockedBy: null,
    });
  });

  it('does not claim a row before its available_at', async () => {
    const [id] = await enqueue(1);
    await db.prisma.outboxMessage.update({
      where: { id },
      data: { availableAt: new Date(clock.now().getTime() + 5_000) },
    });
    const seen: string[] = [];
    const d = dispatcher(handlerOf(async (r) => (seen.push(r.id), 'done')));
    expect((await d.runOnce()).claimed).toBe(0);
    clock.advance(5_000);
    expect((await d.runOnce()).claimed).toBe(1);
    expect(seen).toEqual([id]);
  });

  it('respects the batch size', async () => {
    await enqueue(3);
    const d = dispatcher(
      handlerOf(async () => 'done'),
      { batchSize: 2 },
    );
    expect((await d.runOnce()).claimed).toBe(2);
    expect((await d.runOnce()).claimed).toBe(1);
    expect((await d.runOnce()).claimed).toBe(0);
  });

  it('skips a row another transaction has locked instead of waiting for it', async () => {
    const [locked, free] = await enqueue(2);
    const other = db.client();
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const isHeld = new Promise<void>((r) => (held = r));
    const holder = other.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM outbox_message WHERE id = ${locked}::uuid FOR UPDATE`;
        held();
        await released;
      },
      { timeout: 30_000 },
    );
    await isHeld;
    const seen: string[] = [];
    const d = dispatcher(handlerOf(async (r) => (seen.push(r.id), 'done')));
    const timeout = new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 3_000));
    const result = await Promise.race([d.runOnce(), timeout]);
    release();
    await holder;
    expect(result).not.toBe('blocked');
    expect(seen).toEqual([free]);
  });

  it('two dispatchers racing over many rows handle each row exactly once', async () => {
    const ids = await enqueue(30);
    const handled = new Map<string, number>();
    const handler = handlerOf(async (row) => {
      handled.set(row.id, (handled.get(row.id) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 2));
      return 'done';
    });
    const a = dispatcher(handler, { workerId: 'a', batchSize: 3, prisma: db.client() });
    const b = dispatcher(handler, { workerId: 'b', batchSize: 3, prisma: db.client() });
    const drain = async (d: OutboxDispatcher) => {
      for (;;) {
        const s = await d.runOnce();
        if (s.claimed === 0) return;
      }
    };
    await Promise.all([drain(a), drain(b), drain(a), drain(b)]);
    expect([...handled.keys()].sort()).toEqual([...ids].sort());
    expect([...handled.values()].every((n) => n === 1)).toBe(true);
    const rows = await db.prisma.outboxMessage.findMany({ where: { id: { in: ids } } });
    expect(rows.every((r) => r.status === 'done' && r.attemptsCount === 1)).toBe(true);
  });
});

describe('outcomes', () => {
  it('a thrown error is a retry with exponential backoff, then dead at the cap', async () => {
    const [id] = await enqueue(1);
    const d = dispatcher(
      handlerOf(async () => {
        throw new Error('node timed out (outcome unknown)');
      }),
    );
    const schedule: number[] = [];
    for (let attempt = 1; attempt < POLICY.maxAttempts; attempt += 1) {
      const s = await d.runOnce();
      expect(s).toMatchObject({ claimed: 1, retried: 1, dead: 0 });
      const row = await rowOf(id as string);
      expect(row).toMatchObject({ status: 'pending', attemptsCount: attempt, lockedBy: null });
      const delay = row.availableAt.getTime() - clock.now().getTime();
      schedule.push(delay);
      // Not due one millisecond early.
      clock.advance(delay - 1);
      expect((await d.runOnce()).claimed).toBe(0);
      clock.advance(1);
    }
    expect(schedule).toEqual([1_000, 2_000, 4_000]);
    const last = await d.runOnce();
    expect(last).toMatchObject({ claimed: 1, dead: 1 });
    expect(await rowOf(id as string)).toMatchObject({
      status: 'dead',
      attemptsCount: POLICY.maxAttempts,
      lockedBy: null,
    });
    const audit = await db.prisma.auditLog.findFirstOrThrow({
      where: { toState: 'outbox:dead' },
      orderBy: { id: 'desc' },
    });
    expect(audit).toMatchObject({ entity: 'operation', fromState: 'outbox:processing' });
    expect(audit.detail).toMatchObject({ outboxId: id, attempts: POLICY.maxAttempts });
  });

  it('a deliberate wait reschedules at retryAt and does not use up an attempt', async () => {
    const [id] = await enqueue(1);
    const retryAt = new Date(clock.now().getTime() + 12_345);
    const d = dispatcher(handlerOf(async () => ({ retryAt })));
    for (let i = 0; i < POLICY.maxAttempts + 2; i += 1) {
      expect(await d.runOnce()).toMatchObject({ claimed: 1, retried: 1 });
      expect(await rowOf(id as string)).toMatchObject({
        status: 'pending',
        attemptsCount: 0,
        availableAt: retryAt,
      });
      clock.advance(12_345);
      retryAt.setTime(clock.now().getTime() + 12_345);
    }
  });

  it('a handler failure dead-letters at once, with an audit row', async () => {
    const [id] = await enqueue(1);
    const d = dispatcher(handlerOf(async () => ({ failed: 'not_encodable' })));
    expect(await d.runOnce()).toMatchObject({ claimed: 1, dead: 1 });
    expect(await rowOf(id as string)).toMatchObject({
      status: 'dead',
      processedAt: clock.now(),
      lastError: 'failed:not_encodable',
      lastErrorAt: clock.now(),
    });
    const audit = await db.prisma.auditLog.findFirstOrThrow({
      where: { toState: 'outbox:dead' },
      orderBy: { id: 'desc' },
    });
    expect(audit.detail).toMatchObject({
      outboxId: id,
      note: 'failed:not_encodable',
    });
  });
});

describe('crashes and stale locks', () => {
  it('a crashed worker’s row is reclaimed only once its lock is stale', async () => {
    const [id] = await enqueue(1);
    // Simulate a crash: claim the row, then do not finish while the rescue happens (the handler
    // is held open; it is released at the end so nothing outlives the test).
    let wake!: (o: OutboxOutcome) => void;
    const crashed = dispatcher(
      handlerOf(() => new Promise<OutboxOutcome>((r) => (wake = r))),
      { workerId: 'crashed' },
    );
    const crashedRun = crashed.runOnce();
    for (let i = 0; i < 100 && (await rowOf(id as string)).status !== 'processing'; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await rowOf(id as string)).toMatchObject({ status: 'processing', attemptsCount: 1 });

    const seen: string[] = [];
    const rescuer = dispatcher(
      handlerOf(async (r) => (seen.push(r.id), 'done')),
      { workerId: 'rescuer' },
    );
    clock.advance(LOCK_TIMEOUT - 1);
    expect((await rescuer.runOnce()).claimed).toBe(0); // still a live lock
    clock.advance(1);
    expect(await rescuer.runOnce()).toMatchObject({ claimed: 1, done: 1 });
    expect(seen).toEqual([id]);
    expect(await rowOf(id as string)).toMatchObject({ status: 'done', attemptsCount: 2 });
    wake('done');
    expect(await crashedRun).toMatchObject({ lostLease: 1, done: 0 });
  });

  it('a stale row with no attempts left is reaped to dead, not handed out again', async () => {
    const [id] = await enqueue(1);
    await db.prisma.outboxMessage.update({
      where: { id },
      data: {
        status: 'processing',
        lockedAt: new Date(clock.now().getTime() - LOCK_TIMEOUT),
        lockedBy: 'gone/1',
        attemptsCount: POLICY.maxAttempts,
      },
    });
    const seen: string[] = [];
    const d = dispatcher(handlerOf(async (r) => (seen.push(r.id), 'done')));
    expect(await d.runOnce()).toMatchObject({ reaped: 1, claimed: 0 });
    expect(seen).toEqual([]);
    expect(await rowOf(id as string)).toMatchObject({ status: 'dead', lockedBy: null });
    const audit = await db.prisma.auditLog.findFirstOrThrow({
      where: { toState: 'outbox:dead' },
      orderBy: { id: 'desc' },
    });
    expect(audit.detail).toMatchObject({ outboxId: id });
    expect(String((audit.detail as { note?: unknown }).note)).toContain('lease expired');
    expect((await rowOf(id as string)).lastError).toContain('lease expired');
  });

  it('a slow worker whose lease was taken over cannot overwrite the new owner’s result', async () => {
    const [id] = await enqueue(1);
    let finishSlow!: (o: OutboxOutcome) => void;
    const slow = dispatcher(
      handlerOf(() => new Promise<OutboxOutcome>((r) => (finishSlow = r))),
      { workerId: 'slow' },
    );
    const slowRun = slow.runOnce();
    for (let i = 0; i < 100 && finishSlow === undefined; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    clock.advance(LOCK_TIMEOUT);
    const later = new Date(clock.now().getTime() + 30_000);
    const fast = dispatcher(
      handlerOf(async () => ({ retryAt: later })),
      { workerId: 'fast' },
    );
    expect(await fast.runOnce()).toMatchObject({ claimed: 1, retried: 1 });

    finishSlow('done');
    expect(await slowRun).toMatchObject({ claimed: 1, done: 0, lostLease: 1 });
    // The new owner's decision stands.
    expect(await rowOf(id as string)).toMatchObject({ status: 'pending', availableAt: later });
  });

  it('a lost lease is reported for a failure and a thrown error too', async () => {
    for (const outcome of ['failed', 'throw'] as const) {
      const [id] = await enqueue(1);
      let finishSlow!: () => void;
      const gate = new Promise<void>((r) => (finishSlow = r));
      const slow = dispatcher(
        handlerOf(async () => {
          await gate;
          if (outcome === 'throw') throw new Error('late');
          return { failed: 'late' };
        }),
        { workerId: 'slow' },
      );
      const slowRun = slow.runOnce();
      for (let i = 0; i < 100 && (await rowOf(id as string)).status !== 'processing'; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      clock.advance(LOCK_TIMEOUT);
      await dispatcher(
        handlerOf(async () => 'done'),
        { workerId: 'fast' },
      ).runOnce();
      finishSlow();
      expect(await slowRun).toMatchObject({ lostLease: 1, dead: 0, retried: 0 });
      expect(await rowOf(id as string)).toMatchObject({ status: 'done' });
    }
  });
});

describe('configuration', () => {
  it.each([
    [{ workerId: '' }],
    [{ batchSize: 0 }],
    [{ lockTimeoutMs: 0 }],
    [{ backoff: { baseMs: 0, maxMs: 1, maxAttempts: 1 } }],
    [{ backoff: { baseMs: 10, maxMs: 5, maxAttempts: 1 } }],
    [{ backoff: { baseMs: 1, maxMs: 5, maxAttempts: 0 } }],
    [{ handlerTimeoutMs: 0 }],
    [{ handlerTimeoutMs: LOCK_TIMEOUT }],
    [{ lockTimeoutMs: 1_000, handlerTimeoutMs: 5_000 }],
    [{ maxWaitAgeMs: 0 }],
  ] as [Partial<OutboxDispatcherOptions>][])('refuses %j', (extra) => {
    expect(() =>
      dispatcher(
        handlerOf(async () => 'done'),
        extra,
      ),
    ).toThrow(InvalidRequestError);
  });

  it('uses the defaults when none are given', async () => {
    await enqueue(1);
    const d = new OutboxDispatcher({
      prisma: db.prisma,
      clock,
      ids: new RecordingIds(),
      workerId: 'defaults',
      handler: handlerOf(async () => 'done'),
    });
    expect((await d.runOnce()).done).toBe(1);
  });
});

describe('leases are renewed per row and re-checkable (review M-2)', () => {
  it('a slow batch: rows that went stale and were taken over are skipped, never handled twice', async () => {
    const ids = await enqueue(3);
    const calls = new Map<string, string[]>();
    const record = (worker: string, row: OutboxMessage) =>
      calls.set(row.id, [...(calls.get(row.id) ?? []), worker]);
    const b = dispatcher(
      handlerOf(async (row) => (record('b', row), 'done')),
      { workerId: 'b' },
    );
    let bSummary: unknown;
    let n = 0;
    const a = dispatcher(
      handlerOf(async (row) => {
        record('a', row);
        n += 1;
        // Each row takes 60% of the lock timeout: the third row of the batch goes stale.
        clock.advance(LOCK_TIMEOUT * 0.6);
        if (n === 2) bSummary = await b.runOnce(); // another worker runs meanwhile
        return 'done';
      }),
      { workerId: 'a', batchSize: 3 },
    );
    const aSummary = await a.runOnce();
    expect(aSummary).toMatchObject({ claimed: 3, done: 2, lostLease: 1 });
    expect(bSummary).toMatchObject({ claimed: 1, done: 1 });
    expect([...calls.keys()].sort()).toEqual([...ids].sort());
    for (const id of ids) expect(calls.get(id)).toHaveLength(1);
    // The third row A claimed (claim order is available_at, id) was the one B took over.
    const handlers = [...calls.values()].map((w) => w.join(',')).sort();
    expect(handlers).toEqual(['a', 'a', 'b']);
    const rows = await db.prisma.outboxMessage.findMany({ where: { id: { in: ids } } });
    expect(rows.every((r) => r.status === 'done')).toBe(true);
  });

  it('stillHolds is true while the lease is ours and fresh, false once taken or stale', async () => {
    const [id] = await enqueue(1);
    const seen: boolean[] = [];
    const d = dispatcher(
      handlerOf(async (_row, ctx) => {
        seen.push(await ctx.stillHolds());
        clock.advance(LOCK_TIMEOUT); // our lease is now stale
        seen.push(await ctx.stillHolds());
        clock.advance(-LOCK_TIMEOUT);
        await db.prisma.outboxMessage.update({ where: { id }, data: { lockedBy: 'thief/1' } });
        seen.push(await ctx.stillHolds());
        return 'done';
      }),
    );
    expect(await d.runOnce()).toMatchObject({ lostLease: 1, done: 0 });
    expect(seen).toEqual([true, false, false]);
  });

  it('a handler that never answers times out: unknown outcome, retried, signal aborted', async () => {
    const [id] = await enqueue(1);
    let signal: AbortSignal | undefined;
    const d = dispatcher(
      handlerOf((_row, ctx) => {
        signal = ctx.signal;
        return new Promise<OutboxOutcome>(() => undefined);
      }),
      { handlerTimeoutMs: 50 },
    );
    expect(await d.runOnce()).toMatchObject({ claimed: 1, retried: 1, dead: 0 });
    expect(signal?.aborted).toBe(true);
    const row = await rowOf(id as string);
    expect(row).toMatchObject({ status: 'pending', attemptsCount: 1, lockedBy: null });
    expect(row.lastError).toMatch(/^HandlerTimeoutError: handler did not answer within 50 ms$/);
    expect(row.availableAt.getTime() - clock.now().getTime()).toBe(POLICY.baseMs);
  });

  it('a handler that rejects after its timeout does not crash the dispatcher', async () => {
    await enqueue(1);
    let rejectLate!: (e: Error) => void;
    const d = dispatcher(
      handlerOf(() => new Promise<OutboxOutcome>((_, reject) => (rejectLate = reject))),
      { handlerTimeoutMs: 20 },
    );
    expect(await d.runOnce()).toMatchObject({ retried: 1 });
    rejectLate(new Error('too late'));
    await new Promise((r) => setTimeout(r, 20));
  });
});

describe('error text is recorded redacted and bounded (review L-1, L-2)', () => {
  it('a thrown error: class name, URL redacted, written to last_error', async () => {
    const [id] = await enqueue(1);
    class RpcError extends Error {
      override name = 'RpcError';
    }
    const d = dispatcher(
      handlerOf(async () => {
        throw new RpcError('POST https://eth.example.org/v2/SECRETKEY failed\nretry later');
      }),
    );
    await d.runOnce();
    const row = await rowOf(id as string);
    expect(row.lastError).toBe('RpcError: POST <redacted-url> failed retry later');
    expect(row.lastError).not.toContain('SECRETKEY');
    expect(row.lastErrorAt).toEqual(clock.now());
  });

  it('a failure code and detail are sanitized into last_error and the audit note', async () => {
    const [id] = await enqueue(1);
    const d = dispatcher(
      handlerOf(async () => ({
        failed: 'node_refused',
        detail: `from wss://rpc.example/KEY: ${'x'.repeat(2000)}`,
      })),
    );
    expect(await d.runOnce()).toMatchObject({ dead: 1 });
    const row = await rowOf(id as string);
    expect(row.lastError?.startsWith('failed:node_refused: from <redacted-url> ')).toBe(true);
    expect(row.lastError).toHaveLength(1000);
    expect(row.lastError).not.toContain('KEY');
    const audit = await db.prisma.auditLog.findFirstOrThrow({
      where: { toState: 'outbox:dead' },
      orderBy: { id: 'desc' },
    });
    expect((audit.detail as { note?: string }).note).toBe(row.lastError);
  });

  it('the dead letter at the attempt cap keeps the last error', async () => {
    const [id] = await enqueue(1);
    const d = dispatcher(
      handlerOf(async () => {
        throw new Error('boom');
      }),
      { backoff: { ...POLICY, maxAttempts: 1 } },
    );
    expect(await d.runOnce()).toMatchObject({ dead: 1 });
    expect((await rowOf(id as string)).lastError).toBe('attempts exhausted (1); last: Error: boom');
  });
});

describe('deliberate waits are bounded (review L-3)', () => {
  it('a retryAt in the past is clamped to now + baseMs', async () => {
    const [id] = await enqueue(1);
    const d = dispatcher(handlerOf(async () => ({ retryAt: new Date(0) })));
    await d.runOnce();
    const row = await rowOf(id as string);
    expect(row.availableAt.getTime()).toBe(clock.now().getTime() + POLICY.baseMs);
    expect(row.attemptsCount).toBe(0);
  });

  it.each([
    ['an Invalid Date', { retryAt: new Date(Number.NaN) }],
    ['a non-Date retryAt', { retryAt: '2030-01-01' }],
    ['an unknown outcome', 'maybe'],
  ])('%s is an unknown outcome: backoff, attempt kept', async (_name, outcome) => {
    const [id] = await enqueue(1);
    const d = dispatcher(handlerOf(async () => outcome as unknown as OutboxOutcome));
    expect(await d.runOnce()).toMatchObject({ retried: 1 });
    const row = await rowOf(id as string);
    expect(row).toMatchObject({ status: 'pending', attemptsCount: 1 });
    expect(row.lastError).toMatch(/^InvalidOutcome: /);
    expect(row.availableAt.getTime()).toBe(clock.now().getTime() + POLICY.baseMs);
  });

  it('a row that keeps waiting past maxWaitAgeMs is dead-lettered with an audit row', async () => {
    const [id] = await enqueue(1);
    const d = dispatcher(
      handlerOf(async () => ({ retryAt: new Date(clock.now().getTime() + 10_000) })),
      { maxWaitAgeMs: 25_000 },
    );
    expect(await d.runOnce()).toMatchObject({ retried: 1 });
    clock.advance(10_000);
    expect(await d.runOnce()).toMatchObject({ retried: 1 });
    clock.advance(10_000);
    expect(await d.runOnce()).toMatchObject({ retried: 1 }); // age 20 s
    clock.advance(10_000);
    expect(await d.runOnce()).toMatchObject({ dead: 1 }); // age 30 s
    const row = await rowOf(id as string);
    expect(row).toMatchObject({ status: 'dead', attemptsCount: 1 });
    expect(row.lastError).toBe('still waiting after 25000 ms since it was created');
    const audit = await db.prisma.auditLog.findFirstOrThrow({
      where: { toState: 'outbox:dead' },
      orderBy: { id: 'desc' },
    });
    expect(audit.detail).toMatchObject({ outboxId: id });
  });
});
