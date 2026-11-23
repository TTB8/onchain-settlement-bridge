/**
 * Guard 2 (no user account may go negative, checked at COMMIT) and the concurrency story:
 *  - with the engine's pattern (lockRows in stable order, read the view, insert) two concurrent
 *    spends of the same balance cannot both succeed: the second waits, sees the first, refuses;
 *  - WITHOUT the lock helper, the deferred guard still stops the overdraft at commit, under
 *    READ COMMITTED (overdraft error) and REPEATABLE READ (serialization failure).
 */

import type { Client } from 'pg';

import { lockRows, readBalances, type Prisma } from '../src';
import { createTestDatabase, type TestDatabase } from './support/database';
import {
  balance,
  expectPgError,
  fiatClearing,
  insertDeployment,
  insertEntry,
  insertOperation,
  insertUser,
  linesFor,
  ref,
  runLifecycle,
  setStatus,
  tx,
  type Sql,
  type TestUser,
} from './support/fixtures';

let db: TestDatabase;
let c: Client;
let deploymentId: string;
let fiat: string;

beforeAll(async () => {
  db = await createTestDatabase();
  c = await db.pg();
  deploymentId = (await insertDeployment(c)).id;
  fiat = await fiatClearing(c);
});

afterAll(async () => {
  await db?.drop();
});

/** A user with `amount` available (a settled deposit). */
async function fundedUser(amount: bigint): Promise<TestUser> {
  const user = await insertUser(c);
  await runLifecycle(c, { deploymentId, type: 'deposit', fiat, user, amount, outcome: 'settle' });
  return user;
}

/** Writes a withdrawal reservation on `sql` without BEGIN/COMMIT. */
async function reserveWithdrawal(sql: Sql, user: TestUser, amount: bigint): Promise<void> {
  const opId = await insertOperation(sql, {
    deploymentId,
    type: 'withdrawal',
    userId: user.id,
    amount,
  });
  await insertEntry(sql, opId, 'reserve', linesFor('withdrawal', 'reserve', fiat, user), amount);
  await setStatus(sql, opId, 'ledger_reserved');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('guard 2: no user account goes negative', () => {
  it('refuses at COMMIT a withdrawal reserve larger than the available balance', async () => {
    const user = await fundedUser(100n);
    await c.query('BEGIN');
    await reserveWithdrawal(c, user, 101n); // every statement succeeds
    await expectPgError(c.query('COMMIT'), 'ledger_overdraft');
    expect(await balance(c, user.available)).toBe(100n);
    expect(await balance(c, user.held)).toBe(0n);
  });

  it('allows spending the balance exactly to zero', async () => {
    const user = await fundedUser(100n);
    await tx(c, () => reserveWithdrawal(c, user, 100n));
    expect(await balance(c, user.available)).toBe(0n);
    expect(await balance(c, user.held)).toBe(100n);
  });

  it('refuses a transfer from an unfunded user', async () => {
    const from = await insertUser(c);
    const to = await insertUser(c);
    await expectPgError(
      tx(c, async () => {
        const opId = await insertOperation(c, {
          deploymentId,
          type: 'transfer',
          userId: from.id,
          counterpartyUserId: to.id,
          amount: 1n,
        });
        await insertEntry(c, opId, 'reserve', linesFor('transfer', 'reserve', fiat, from, to), 1n);
        await setStatus(c, opId, 'ledger_reserved');
      }),
      'ledger_overdraft',
    );
  });

  it('does not lock or check fiat_clearing (the system account)', async () => {
    const before = await c.query<{ v: string }>(
      `SELECT guard_version::text AS v FROM account WHERE id = $1`,
      [fiat],
    );
    await fundedUser(5n); // debits fiat_clearing
    const after = await c.query<{ v: string }>(
      `SELECT guard_version::text AS v FROM account WHERE id = $1`,
      [fiat],
    );
    expect(after.rows[0]!.v).toBe(before.rows[0]!.v);
  });
});

describe('concurrency: two spends of the same balance', () => {
  it('engine pattern (lockRows + readBalances + insert in one transaction): exactly one succeeds, the other sees the new balance', async () => {
    const user = await fundedUser(100n);
    const prisma = db.prisma;
    let firstLocked!: () => void;
    const locked = new Promise<void>((r) => (firstLocked = r));
    const observed: bigint[] = [];

    const spend = (delayAfterLock: number, signal?: () => void) =>
      prisma.$transaction(
        async (t: Prisma.TransactionClient) => {
          await lockRows(t, 'account', [user.held, user.available]);
          signal?.();
          const [avail] = (await readBalances(t, { accountIds: [user.available] })).map(
            (b) => b.balance,
          );
          observed.push(avail!);
          await sleep(delayAfterLock);
          if (avail! < 80n) throw new Error('insufficient funds (engine check)');
          const op = await t.$queryRaw<{ id: string }[]>`
            INSERT INTO operation (deployment_id, type, user_id, amount, ref)
            VALUES (${deploymentId}::uuid, 'withdrawal', ${user.id}::uuid, 80, ${ref()}) RETURNING id::text`;
          const opId = op[0]!.id;
          const e = await t.$queryRaw<{ id: string }[]>`
            INSERT INTO journal_entry (operation_id, kind) VALUES (${opId}::uuid, 'reserve') RETURNING id::text`;
          await t.$executeRaw`
            INSERT INTO posting (entry_id, account_id, side, amount) VALUES
              (${e[0]!.id}::uuid, ${user.available}::uuid, 'debit', 80),
              (${e[0]!.id}::uuid, ${user.held}::uuid, 'credit', 80)`;
          await t.$executeRaw`
            UPDATE operation SET status = 'ledger_reserved', version = version + 1 WHERE id = ${opId}::uuid`;
        },
        { timeout: 20000, maxWait: 20000 },
      );

    const first = spend(300, firstLocked);
    await locked; // the second starts only once the first holds the locks
    const second = spend(0);
    const results = await Promise.allSettled([first, second]);

    expect(results[0]!.status).toBe('fulfilled');
    expect(results[1]!.status).toBe('rejected');
    // Refused by the ENGINE's own check, because it waited and read the committed balance.
    expect(String((results[1] as PromiseRejectedResult).reason)).toContain(
      'insufficient funds (engine check)',
    );
    expect(observed).toEqual([100n, 20n]);
    expect(await balance(c, user.available)).toBe(20n);
    expect(await balance(c, user.held)).toBe(80n);
  });

  for (const isolation of ['READ COMMITTED', 'REPEATABLE READ'] as const) {
    it(`WITHOUT the lock helper (${isolation}): both read 100, both insert, the deferred guard refuses one at COMMIT`, async () => {
      const user = await fundedUser(100n);
      const a = await db.pg();
      const b = await db.pg();
      for (const s of [a, b]) {
        await s.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        // Both read the same available balance: a naive "check then write".
        expect(await balance(s, user.available)).toBe(100n);
      }
      await reserveWithdrawal(a, user, 80n);
      await reserveWithdrawal(b, user, 80n);
      const results = await Promise.allSettled([a.query('COMMIT'), b.query('COMMIT')]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      const message = String(failed[0]!.reason?.message);
      if (isolation === 'READ COMMITTED') {
        expect(message).toContain('ledger_overdraft');
      } else {
        expect(message).toMatch(/ledger_overdraft|could not serialize access/);
      }
      expect(await balance(c, user.available)).toBe(20n);
      expect(await balance(c, user.held)).toBe(80n);
      await a.end();
      await b.end();
    });
  }

  it('WITHOUT the lock helper, ten concurrent spends of 30 from 100: exactly three succeed', async () => {
    const user = await fundedUser(100n);
    const clients = await Promise.all(Array.from({ length: 10 }, () => db.pg()));
    for (const s of clients) await s.query('BEGIN');
    for (const s of clients) await reserveWithdrawal(s, user, 30n);
    const results = await Promise.allSettled(clients.map((s) => s.query('COMMIT')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    for (const r of results) {
      if (r.status === 'rejected') expect(String(r.reason?.message)).toContain('ledger_overdraft');
    }
    expect(await balance(c, user.available)).toBe(10n);
    await Promise.all(clients.map((s) => s.end()));
  });
});
