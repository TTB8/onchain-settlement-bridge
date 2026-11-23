/**
 * OperationService on real Postgres (fresh database per file, real SQL guards).
 *
 * Covers: the three happy paths writing the exact operation, reserve entry, outbox row and audit
 * row; overdraft and the concurrent double-spend; idempotent replay (sequential and concurrent);
 * same key with different content; deployment binding (no active deployment, wrong token, a
 * redeploy after an operation finished); the 40001 retry path and its bound; atomicity.
 */

import { referenceFromUuid } from '@bridge/domain';

import {
  DeploymentMismatchError,
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidRequestError,
  NoActiveDeploymentError,
  OperationService,
  RetriesExhaustedError,
  SelfTransferRequestError,
  UnknownUserError,
} from '../src';
import { createTestDatabase, type TestDatabase } from './support/database';
import {
  balanceOf,
  counts,
  FakeClock,
  fund,
  insertDeployment,
  insertUser,
  line,
  postingsOf,
  RecordingIds,
  serviceFor,
  type TestDeployment,
} from './support/fixtures';

let db: TestDatabase;
let dep: TestDeployment;
let service: OperationService;
let clock: FakeClock;
let ids: RecordingIds;

beforeAll(async () => {
  db = await createTestDatabase();
  dep = await insertDeployment(db.prisma);
});

afterAll(async () => {
  await db?.drop();
});

beforeEach(() => {
  clock = new FakeClock();
  ids = new RecordingIds();
  service = serviceFor(db.prisma, dep, { clock, ids });
});

async function outboxFor(operationId: string) {
  return db.prisma.outboxMessage.findMany({ where: { operationId } });
}

async function auditFor(operationId: string) {
  return db.prisma.auditLog.findMany({ where: { entityId: operationId }, orderBy: { id: 'asc' } });
}

describe('happy paths', () => {
  it('deposit: operation, Dr fiat / Cr incoming, one mint outbox row, one audit row', async () => {
    const u = await insertUser(db.prisma);
    const res = await service.requestDeposit(u.id, 500n, 'dep-1');
    const op = res.operation;

    expect(res.replayed).toBe(false);
    expect(res.attempts).toBe(1);
    expect(op.id).toBe(ids.issued[0]);
    expect(op.ref).toBe(referenceFromUuid(op.id));
    expect(op).toMatchObject({
      type: 'deposit',
      status: 'ledger_reserved',
      userId: u.id,
      counterpartyUserId: null,
      amount: 500n,
      idempotencyKey: 'dep-1',
      version: 0,
      deploymentId: dep.id,
      chainId: dep.chainId,
      tokenAddress: dep.token,
    });
    expect(await postingsOf(db.prisma, op.id, 'reserve')).toEqual(
      [line(db.fiatId, 'debit', 500n), line(u.incoming, 'credit', 500n)].sort(),
    );

    const outbox = await outboxFor(op.id);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      deploymentId: dep.id,
      signer: 'settlement',
      ref: op.ref,
      status: 'pending',
      attemptsCount: 0,
      lockedAt: null,
      lockedBy: null,
      availableAt: clock.now(),
      call: { kind: 'mint', to: u.wallet, amount: '500', ref: op.ref },
    });

    const audit = await auditFor(op.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      entity: 'operation',
      fromState: null,
      toState: 'ledger_reserved',
      at: clock.now(),
    });
    expect(audit[0]?.detail).toMatchObject({
      type: 'deposit',
      amount: '500',
      ref: op.ref,
      chainId: dep.chainId.toString(),
      tokenAddress: dep.token,
    });

    expect(await balanceOf(db.prisma, u.incoming)).toBe(500n);
    expect(await balanceOf(db.prisma, u.available)).toBe(0n);
  });

  it('withdrawal: Dr available / Cr held, one burn outbox row', async () => {
    const u = await insertUser(db.prisma);
    await fund(service, u, 300n);
    const { operation: op } = await service.requestWithdrawal(u.id, 120n, 'wd-1');

    expect(op).toMatchObject({ type: 'withdrawal', status: 'ledger_reserved', amount: 120n });
    expect(await postingsOf(db.prisma, op.id, 'reserve')).toEqual(
      [line(u.available, 'debit', 120n), line(u.held, 'credit', 120n)].sort(),
    );
    const outbox = await outboxFor(op.id);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.call).toEqual({ kind: 'burn', from: u.wallet, amount: '120', ref: op.ref });
    expect(await balanceOf(db.prisma, u.available)).toBe(180n);
    expect(await balanceOf(db.prisma, u.held)).toBe(120n);
  });

  it('transfer: Dr available(F) / Cr held(F), one settleTransfer outbox row', async () => {
    const from = await insertUser(db.prisma);
    const to = await insertUser(db.prisma);
    await fund(service, from, 100n);
    const { operation: op } = await service.requestTransfer(from.id, to.id, 70n, 'tr-1');

    expect(op).toMatchObject({
      type: 'transfer',
      userId: from.id,
      counterpartyUserId: to.id,
      amount: 70n,
    });
    expect(await postingsOf(db.prisma, op.id, 'reserve')).toEqual(
      [line(from.available, 'debit', 70n), line(from.held, 'credit', 70n)].sort(),
    );
    const outbox = await outboxFor(op.id);
    expect(outbox[0]?.call).toEqual({
      kind: 'settleTransfer',
      from: from.wallet,
      to: to.wallet,
      amount: '70',
      ref: op.ref,
    });
    expect(await balanceOf(db.prisma, to.available)).toBe(0n);
  });

  it('get returns the record or null', async () => {
    const u = await insertUser(db.prisma);
    const { operation } = await service.requestDeposit(u.id, 1n, 'get-1');
    expect(await service.get(operation.id)).toEqual(operation);
    expect(await service.get('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('refusals write nothing', () => {
  it('overdraft: InsufficientFundsError carrying the balance read under lock', async () => {
    const u = await insertUser(db.prisma);
    await fund(service, u, 50n);
    const before = await counts(db.prisma);
    const err = await service.requestWithdrawal(u.id, 51n, 'od-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientFundsError);
    expect(err).toMatchObject({ available: 50n, requested: 51n, code: 'INSUFFICIENT_FUNDS' });
    expect(await counts(db.prisma)).toEqual(before);
  });

  it('a transfer from an unfunded user is refused', async () => {
    const a = await insertUser(db.prisma);
    const b = await insertUser(db.prisma);
    await expect(service.requestTransfer(a.id, b.id, 1n, 'od-2')).rejects.toBeInstanceOf(
      InsufficientFundsError,
    );
  });

  it('spending the balance exactly to zero is allowed', async () => {
    const u = await insertUser(db.prisma);
    await fund(service, u, 40n);
    await service.requestWithdrawal(u.id, 40n, 'zero-1');
    expect(await balanceOf(db.prisma, u.available)).toBe(0n);
  });

  it('self transfer, bad amount, bad key, unknown user', async () => {
    const u = await insertUser(db.prisma);
    const before = await counts(db.prisma);
    await expect(service.requestTransfer(u.id, u.id, 1n, 'self')).rejects.toBeInstanceOf(
      SelfTransferRequestError,
    );
    await expect(service.requestDeposit(u.id, 0n, 'zero')).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
    await expect(service.requestDeposit(u.id, -5n, 'neg')).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
    await expect(service.requestDeposit(u.id, 1n, '')).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(service.requestDeposit(u.id, 1n, 'k'.repeat(256))).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
    await expect(
      service.request({ type: 'nope', userId: u.id, amount: 1n, idempotencyKey: 'x' } as never),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(
      service.requestDeposit('00000000-0000-4000-8000-000000000001', 1n, 'ghost'),
    ).rejects.toBeInstanceOf(UnknownUserError);
    const half = await db.prisma.user.create({ data: { walletAddress: `0x${'ab'.repeat(20)}` } });
    await db.prisma.account.create({ data: { kind: 'user_available', userId: half.id } });
    await expect(service.requestDeposit(half.id, 1n, 'half')).rejects.toBeInstanceOf(
      UnknownUserError,
    );
    expect(await counts(db.prisma)).toEqual(before);
  });

  it('constructor refuses a bad chain id or token address', () => {
    expect(() => serviceFor(db.prisma, { ...dep, chainId: 0n })).toThrow(InvalidRequestError);
    expect(() => serviceFor(db.prisma, { ...dep, token: dep.token.toUpperCase() })).toThrow(
      InvalidRequestError,
    );
  });
});

describe('concurrency (ADR 0012 item 18)', () => {
  it('N parallel withdrawals of one balance: exactly the affordable number succeed', async () => {
    const u = await insertUser(db.prisma);
    await fund(service, u, 100n);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => service.requestWithdrawal(u.id, 30n, `race-${i}`)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(3);
    expect(refused).toHaveLength(7);
    // Every loser is refused cleanly by the engine, not by the database's overdraft guard at COMMIT.
    for (const r of refused) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientFundsError);
    }
    expect(await balanceOf(db.prisma, u.available)).toBe(10n);
    expect(await balanceOf(db.prisma, u.held)).toBe(90n);
  });

  it('withdrawals and transfers racing on one sender never overspend', async () => {
    const u = await insertUser(db.prisma);
    const other = await insertUser(db.prisma);
    await fund(service, u, 100n);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0
          ? service.requestWithdrawal(u.id, 25n, `mix-w-${i}`)
          : service.requestTransfer(u.id, other.id, 25n, `mix-t-${i}`),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientFundsError);
    }
    expect(await balanceOf(db.prisma, u.available)).toBe(0n);
  });
});

describe('idempotency', () => {
  it('the same request twice returns the same operation and writes nothing new', async () => {
    const u = await insertUser(db.prisma);
    await fund(service, u, 100n);
    const first = await service.requestWithdrawal(u.id, 10n, 'idem-1');
    const before = await counts(db.prisma);
    const second = await service.requestWithdrawal(u.id, 10n, 'idem-1');
    expect(second.replayed).toBe(true);
    expect(second.operation).toEqual(first.operation);
    expect(await counts(db.prisma)).toEqual(before);
    expect(await balanceOf(db.prisma, u.available)).toBe(90n);
  });

  it('a replay still succeeds when the balance no longer covers it', async () => {
    const u = await insertUser(db.prisma);
    await fund(service, u, 10n);
    const first = await service.requestWithdrawal(u.id, 10n, 'idem-2');
    const again = await service.requestWithdrawal(u.id, 10n, 'idem-2');
    expect(again.operation.id).toBe(first.operation.id);
  });

  it('five concurrent copies of one request create exactly one operation', async () => {
    const u = await insertUser(db.prisma);
    const before = await counts(db.prisma);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.requestDeposit(u.id, 7n, 'idem-3')),
    );
    expect(new Set(results.map((r) => r.operation.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const after = await counts(db.prisma);
    expect(after.operation - before.operation).toBe(1);
    expect(after.outbox - before.outbox).toBe(1);
  });

  it('same key, different content: IdempotencyConflictError, nothing written', async () => {
    const u = await insertUser(db.prisma);
    const v = await insertUser(db.prisma);
    await fund(service, u, 100n);
    const first = await service.requestWithdrawal(u.id, 10n, 'idem-4');
    const before = await counts(db.prisma);
    for (const attempt of [
      () => service.requestWithdrawal(u.id, 11n, 'idem-4'),
      () => service.requestDeposit(u.id, 10n, 'idem-4'),
      () => service.requestTransfer(u.id, v.id, 10n, 'idem-4'),
    ]) {
      const err = await attempt().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IdempotencyConflictError);
      expect(err).toMatchObject({ existingOperationId: first.operation.id });
    }
    expect(await counts(db.prisma)).toEqual(before);
  });

  it('keys are per user: two users with one key at once get two operations', async () => {
    const a = await insertUser(db.prisma);
    const b = await insertUser(db.prisma);
    const [ra, rb] = await Promise.all([
      service.requestDeposit(a.id, 5n, 'idem-5'),
      service.requestDeposit(b.id, 5n, 'idem-5'),
    ]);
    expect(ra.replayed || rb.replayed).toBe(false);
    expect(ra.operation.id).not.toBe(rb.operation.id);
    expect(ra.operation.userId).toBe(a.id);
    expect(rb.operation.userId).toBe(b.id);
  });

  it("a conflict names only the requester's own operation, never the key", async () => {
    const a = await insertUser(db.prisma);
    const b = await insertUser(db.prisma);
    await service.requestDeposit(b.id, 5n, 'shared-secret-key');
    const mine = await service.requestDeposit(a.id, 5n, 'shared-secret-key');
    const err = await service
      .requestDeposit(a.id, 6n, 'shared-secret-key')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdempotencyConflictError);
    expect(err).toMatchObject({ existingOperationId: mine.operation.id });
    expect(String((err as Error).message)).not.toContain('shared-secret-key');
  });

  it('same key, same user, racing requests with different lock sets: one wins, one conflicts', async () => {
    const a = await insertUser(db.prisma);
    await fund(service, a, 50n);
    // A deposit locks incoming; a withdrawal locks available+held: no common lock, so the loser
    // meets the unique index at INSERT and the retry answers with a conflict.
    const results = await Promise.allSettled([
      service.requestDeposit(a.id, 5n, 'idem-6'),
      service.requestWithdrawal(a.id, 5n, 'idem-6'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(IdempotencyConflictError);
  });
});

describe('deployment binding (ADR 0011, ADR 0012 item 17)', () => {
  it('no active deployment on the configured chain: refused, nothing written', async () => {
    const inactive = await insertDeployment(db.prisma, { active: false });
    const svc = serviceFor(db.prisma, inactive);
    const u = await insertUser(db.prisma);
    const before = await counts(db.prisma);
    await expect(svc.requestDeposit(u.id, 1n, 'nodep-1')).rejects.toBeInstanceOf(
      NoActiveDeploymentError,
    );
    expect(await counts(db.prisma)).toEqual(before);
  });

  it('the active token is not the configured one: refused', async () => {
    const svc = serviceFor(db.prisma, { ...dep, token: `0x${'cd'.repeat(20)}` });
    const u = await insertUser(db.prisma);
    await expect(svc.requestDeposit(u.id, 1n, 'mismatch-1')).rejects.toBeInstanceOf(
      DeploymentMismatchError,
    );
  });

  it('after a redeploy, a replay keeps the old binding and new work binds to the new token', async () => {
    const a = await insertDeployment(db.prisma);
    const svcA = serviceFor(db.prisma, a);
    const u = await insertUser(db.prisma);
    const { operation } = await svcA.requestDeposit(u.id, 9n, 'rebind-1');
    // Finish it (terminal), so the database lets the deployment be retired.
    const s = await svcA.move({
      operationId: operation.id,
      from: 'ledger_reserved',
      version: 0,
      move: { event: 'SUBMIT' },
      at: new Date(),
      note: 'sent',
    });
    await svcA.move({
      operationId: operation.id,
      from: 'submitted',
      version: s.version,
      move: { event: 'CONFIRM', confirmedBlock: 5n },
      at: new Date(),
      note: 'final',
    });
    await db.prisma.deployment.update({ where: { id: a.id }, data: { active: false } });
    const b = await insertDeployment(db.prisma, { chainId: a.chainId });
    const svcB = serviceFor(db.prisma, b);

    // The old engine configuration is refused outright.
    await expect(svcA.requestDeposit(u.id, 1n, 'rebind-2')).rejects.toBeInstanceOf(
      DeploymentMismatchError,
    );
    // A replay of the old request is answered from the record: never re-bound, nothing written.
    const before = await counts(db.prisma);
    const replay = await svcB.requestDeposit(u.id, 9n, 'rebind-1');
    expect(replay.replayed).toBe(true);
    expect(replay.operation).toMatchObject({
      id: operation.id,
      deploymentId: a.id,
      tokenAddress: a.token,
    });
    expect(await counts(db.prisma)).toEqual(before);
    // New work goes to the new deployment.
    const fresh = await svcB.requestDeposit(u.id, 9n, 'rebind-3');
    expect(fresh.operation).toMatchObject({ deploymentId: b.id, tokenAddress: b.token });
  });
});

describe('serialization failures (40001)', () => {
  /**
   * Makes the request's first try fail with 40001, deterministically: under SERIALIZABLE the
   * request takes its snapshot, then blocks on the account row another transaction has updated;
   * when that transaction commits, the row lock is granted on a row changed after the snapshot.
   */
  async function withConflict(
    svc: OperationService,
    userAvailable: string,
    key: string,
    userId: string,
  ) {
    const other = db.client();
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let holderStarted!: () => void;
    const started = new Promise<void>((r) => (holderStarted = r));
    const holder = other.$transaction(
      async (tx) => {
        await tx.$executeRaw`UPDATE account SET guard_version = guard_version + 1 WHERE id = ${userAvailable}::uuid`;
        holderStarted();
        await released;
      },
      { timeout: 30_000 },
    );
    await started;
    const request = svc.requestWithdrawal(userId, 5n, key).then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    // Wait until the request is blocked on the row lock, then let the holder commit.
    for (let i = 0; i < 200; i += 1) {
      const [row] = await db.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_locks WHERE NOT granted AND locktype = 'transactionid'`;
      if ((row?.n ?? 0n) > 0n) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    release();
    await holder;
    return request;
  }

  it('retries the whole transaction and succeeds on the second try', async () => {
    const u = await insertUser(db.prisma);
    await fund(service, u, 50n);
    const svc = serviceFor(db.prisma, dep, { transactions: { isolationLevel: 'Serializable' } });
    const out = await withConflict(svc, u.available, 'ser-1', u.id);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.v.attempts).toBe(2);
    expect(await balanceOf(db.prisma, u.available)).toBe(45n);
  });

  it('gives up with RetriesExhaustedError beyond the bound, having written nothing', async () => {
    const u = await insertUser(db.prisma);
    await fund(service, u, 50n);
    const svc = serviceFor(db.prisma, dep, {
      transactions: { isolationLevel: 'Serializable', maxAttempts: 1 },
    });
    const before = await counts(db.prisma);
    const out = await withConflict(svc, u.available, 'ser-2', u.id);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.e).toBeInstanceOf(RetriesExhaustedError);
      expect(out.e).toMatchObject({ attempts: 1 });
    }
    expect(await counts(db.prisma)).toEqual(before);
  });

  it('refuses a retry bound below 1', async () => {
    const svc = serviceFor(db.prisma, dep, { transactions: { maxAttempts: 0 } });
    const u = await insertUser(db.prisma);
    await expect(svc.requestDeposit(u.id, 1n, 'bound')).rejects.toBeInstanceOf(RangeError);
  });
});

describe('atomicity', () => {
  async function withFailingTrigger(table: string, fn: () => Promise<void>) {
    await db.prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_boom() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test_boom'; END $$`);
    await db.prisma.$executeRawUnsafe(
      `CREATE TRIGGER test_boom BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION test_boom()`,
    );
    try {
      await fn();
    } finally {
      await db.prisma.$executeRawUnsafe(`DROP TRIGGER test_boom ON ${table}`);
    }
  }

  it.each(['posting', 'outbox_message', 'audit_log'])(
    'a failure inserting into %s leaves no partial rows',
    async (table) => {
      const u = await insertUser(db.prisma);
      await fund(service, u, 20n);
      const before = await counts(db.prisma);
      await withFailingTrigger(table, async () => {
        await expect(service.requestWithdrawal(u.id, 5n, `atom-${table}`)).rejects.toThrow(
          /test_boom/,
        );
      });
      expect(await counts(db.prisma)).toEqual(before);
      expect(await balanceOf(db.prisma, u.available)).toBe(20n);
      expect(await balanceOf(db.prisma, u.held)).toBe(0n);
    },
  );

  it('a missing fiat_clearing account is a setup error', async () => {
    // A separate database: the seed account cannot be deleted from a live one.
    const empty = await createTestDatabase();
    try {
      await empty.prisma.$executeRawUnsafe(`ALTER TABLE account DISABLE TRIGGER USER`);
      await empty.prisma.$executeRawUnsafe(`DELETE FROM account`);
      await empty.prisma.$executeRawUnsafe(`ALTER TABLE account ENABLE TRIGGER USER`);
      const d = await insertDeployment(empty.prisma);
      const u = await insertUser(empty.prisma);
      const svc = serviceFor(empty.prisma, d);
      await expect(svc.requestDeposit(u.id, 1n, 'nofiat')).rejects.toMatchObject({
        code: 'LEDGER_SETUP',
      });
    } finally {
      await empty.drop();
    }
  });
});

it('uses the injected clock for every timestamp it writes', async () => {
  const c = new FakeClock(Date.UTC(2030, 0, 1));
  const svc = new OperationService({
    prisma: db.prisma,
    clock: c,
    ids: new RecordingIds(),
    chainId: dep.chainId,
    tokenAddress: dep.token,
  });
  const u = await insertUser(db.prisma);
  const { operation } = await svc.requestDeposit(u.id, 3n, 'clock-1');
  const row = await db.prisma.operation.findUniqueOrThrow({ where: { id: operation.id } });
  expect(row.createdAt).toEqual(c.now());
  expect(row.updatedAt).toEqual(c.now());
  const entry = await db.prisma.journalEntry.findFirstOrThrow({
    where: { operationId: operation.id },
  });
  expect(entry.createdAt).toEqual(c.now());
});
