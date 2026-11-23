/**
 * The package's TypeScript helpers: value converters, client creation, readBalances over the
 * view, the lock helpers (stable order, fail closed outside a transaction or on a missing row)
 * and the idempotent seed.
 */

import type { Client } from 'pg';

import {
  assertDbBigint,
  bigintFromDecimal,
  bigintsToDecimal,
  createPrismaClient,
  DbValueError,
  ensureFiatClearingAccount,
  isUuid,
  LockError,
  lockRows,
  lockSignerState,
  MAX_DB_BIGINT,
  MIN_DB_BIGINT,
  readBalances,
  toSortedUniqueUuids,
  toUuid,
  type LockableTable,
  type Prisma,
} from '../src';
import { createTestDatabase, listTestDatabases, type TestDatabase } from './support/database';
import {
  address,
  insertDeployment,
  insertUser,
  runLifecycle,
  type TestUser,
} from './support/fixtures';

describe('values', () => {
  it('assertDbBigint accepts the full bigint range and refuses anything else', () => {
    expect(() => assertDbBigint(MAX_DB_BIGINT)).not.toThrow();
    expect(() => assertDbBigint(MIN_DB_BIGINT)).not.toThrow();
    expect(() => assertDbBigint(MAX_DB_BIGINT + 1n)).toThrow(DbValueError);
    expect(() => assertDbBigint(MIN_DB_BIGINT - 1n)).toThrow(DbValueError);
    expect(() => assertDbBigint(1)).toThrow(/expected a bigint, got number/);
  });

  it('bigintFromDecimal parses only canonical decimals', () => {
    expect(bigintFromDecimal('0')).toBe(0n);
    expect(bigintFromDecimal('-42')).toBe(-42n);
    expect(bigintFromDecimal('9223372036854775807')).toBe(MAX_DB_BIGINT);
    for (const bad of ['', '01', '-0', '1e3', ' 1', '1.0', '+1', '0x10', '9223372036854775808']) {
      expect(() => bigintFromDecimal(bad)).toThrow(DbValueError);
    }
    expect(() => bigintFromDecimal(5 as unknown as string)).toThrow(DbValueError);
  });

  it('bigintsToDecimal converts nested bigints and keeps everything else', () => {
    expect(bigintsToDecimal({ a: 1n, b: [2n, { c: 3n }], d: 'x', e: null, f: 4, g: true })).toEqual(
      {
        a: '1',
        b: ['2', { c: '3' }],
        d: 'x',
        e: null,
        f: 4,
        g: true,
      },
    );
    expect(JSON.stringify(bigintsToDecimal(MAX_DB_BIGINT))).toBe('"9223372036854775807"');
  });

  it('uuid helpers normalise case and refuse non-uuids; sorted unique list', () => {
    const u = '0F8FAD5B-D9CB-469F-A165-70867728950E';
    expect(isUuid(u)).toBe(false);
    expect(toUuid(u)).toBe(u.toLowerCase());
    expect(isUuid(toUuid(u))).toBe(true);
    expect(() => toUuid('not-a-uuid')).toThrow(DbValueError);
    expect(() => toUuid(7)).toThrow(DbValueError);
    expect(
      toSortedUniqueUuids([
        'bbbbbbbb-0000-0000-0000-000000000000',
        'AAAAAAAA-0000-0000-0000-000000000000',
        'bbbbbbbb-0000-0000-0000-000000000000',
      ]),
    ).toEqual(['aaaaaaaa-0000-0000-0000-000000000000', 'bbbbbbbb-0000-0000-0000-000000000000']);
  });
});

describe('createPrismaClient', () => {
  it('refuses a non-postgres URL without echoing it', () => {
    expect(() => createPrismaClient('mysql://user:secret@host/db')).toThrow(
      /postgresql:\/\/ connection string$/,
    );
    try {
      createPrismaClient('mysql://user:secret@host/db');
    } catch (err) {
      expect(String(err)).not.toContain('secret');
    }
  });
});

describe('with a database', () => {
  let db: TestDatabase;
  let c: Client;
  let deploymentId: string;
  let fiat: string;
  let alice: TestUser;
  let bob: TestUser;

  beforeAll(async () => {
    db = await createTestDatabase();
    c = await db.pg();
    deploymentId = (await insertDeployment(c)).id;
    fiat = await ensureFiatClearingAccount(db.prisma);
    alice = await insertUser(c);
    bob = await insertUser(c);
    await runLifecycle(c, {
      deploymentId,
      type: 'deposit',
      fiat,
      user: alice,
      amount: 500n,
      outcome: 'settle',
    });
    await runLifecycle(c, {
      deploymentId,
      type: 'withdrawal',
      fiat,
      user: alice,
      amount: 120n,
      outcome: 'reserve-only',
    });
    await c.query(
      `INSERT INTO signer_state (deployment_id, signer, address) VALUES ($1, 'settlement', $2)`,
      [deploymentId, address()],
    );
  });

  afterAll(async () => {
    await db?.drop();
  });

  describe('ensureFiatClearingAccount', () => {
    it('is idempotent, also when run concurrently', async () => {
      const ids = await Promise.all([1, 2, 3].map(() => ensureFiatClearingAccount(db.prisma)));
      expect(new Set([...ids, fiat]).size).toBe(1);
      const n = await c.query(`SELECT 1 FROM account WHERE kind = 'fiat_clearing'`);
      expect(n.rowCount).toBe(1);
    });
  });

  describe('readBalances', () => {
    it('reads by user ids: every account of each user, ordered by account id', async () => {
      const rows = await readBalances(db.prisma, { userIds: [alice.id, bob.id] });
      expect(rows).toHaveLength(6);
      expect(rows.map((r) => r.accountId)).toEqual([...rows.map((r) => r.accountId)].sort());
      const byId = new Map(rows.map((r) => [r.accountId, r]));
      expect(byId.get(alice.available)).toEqual({
        accountId: alice.available,
        kind: 'user_available',
        userId: alice.id,
        balance: 380n,
      });
      expect(byId.get(alice.held)?.balance).toBe(120n);
      expect(byId.get(alice.incoming)?.balance).toBe(0n);
      expect(byId.get(bob.available)?.balance).toBe(0n);
    });

    it('reads by account ids, including fiat_clearing (debit-normal, no user)', async () => {
      const rows = await readBalances(db.prisma, { accountIds: [fiat, alice.held] });
      const f = rows.find((r) => r.accountId === fiat)!;
      expect(f).toMatchObject({ kind: 'fiat_clearing', userId: null, balance: 500n });
      expect(rows.find((r) => r.accountId === alice.held)?.balance).toBe(120n);
    });

    it('returns [] for an empty selector, omits unknown ids, refuses malformed ids', async () => {
      expect(await readBalances(db.prisma, { accountIds: [] })).toEqual([]);
      expect(
        await readBalances(db.prisma, { userIds: ['00000000-0000-0000-0000-000000000000'] }),
      ).toEqual([]);
      await expect(readBalances(db.prisma, { accountIds: ["x' OR 1=1 --"] })).rejects.toThrow(
        DbValueError,
      );
    });
  });

  describe('lockRows', () => {
    it('locks inside a transaction and returns the ids in ascending order', async () => {
      const ids = [alice.held, alice.available, alice.incoming, alice.held];
      const locked = await db.prisma.$transaction((tx: Prisma.TransactionClient) =>
        lockRows(tx, 'account', ids),
      );
      expect(locked).toEqual([...new Set(ids)].sort());
    });

    it('really holds the lock: another transaction cannot take it with NOWAIT', async () => {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let lockedSignal!: () => void;
      const lockedNow = new Promise<void>((r) => (lockedSignal = r));
      const holder = db.prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          await lockRows(tx, 'account', [bob.available]);
          lockedSignal();
          await held;
        },
        { timeout: 20000 },
      );
      await lockedNow;
      const other = await db.pg();
      await other.query('BEGIN');
      await expect(
        other.query(`SELECT 1 FROM account WHERE id = $1 FOR UPDATE NOWAIT`, [bob.available]),
      ).rejects.toThrow(/could not obtain lock/);
      await other.query('ROLLBACK');
      release();
      await holder;
    });

    it('fails closed: outside a transaction, on a missing row, on a table not in the list', async () => {
      await expect(lockRows(db.prisma, 'account', [alice.available])).rejects.toThrow(
        /must run inside a transaction/,
      );
      await expect(
        db.prisma.$transaction((tx: Prisma.TransactionClient) =>
          lockRows(tx, 'operation', ['00000000-0000-0000-0000-000000000001']),
        ),
      ).rejects.toThrow(LockError);
      await expect(
        db.prisma.$transaction((tx: Prisma.TransactionClient) =>
          lockRows(tx, 'posting' as LockableTable, [alice.available]),
        ),
      ).rejects.toThrow(/not lockable/);
      expect(
        await db.prisma.$transaction((tx: Prisma.TransactionClient) => lockRows(tx, 'account', [])),
      ).toEqual([]);
    });
  });

  describe('lockSignerState', () => {
    it('locks and returns the signer address inside a transaction', async () => {
      const s = await db.prisma.$transaction((tx: Prisma.TransactionClient) =>
        lockSignerState(tx, deploymentId.toUpperCase(), 'settlement'),
      );
      expect(s.deploymentId).toBe(deploymentId);
      expect(s.signer).toBe('settlement');
      expect(s.address).toMatch(/^0x[0-9a-f]{40}$/);
    });

    it('fails closed: missing signer, outside a transaction', async () => {
      await expect(
        db.prisma.$transaction((tx: Prisma.TransactionClient) =>
          lockSignerState(tx, deploymentId, 'compliance'),
        ),
      ).rejects.toThrow(/no compliance signer/);
      await expect(lockSignerState(db.prisma, deploymentId, 'settlement')).rejects.toThrow(
        /must run inside a transaction/,
      );
    });
  });

  it('test databases are named bridge_db_test_<hex> and this one is listed', async () => {
    expect(await listTestDatabases()).toContain(db.name);
    expect(db.name).toMatch(/^bridge_db_test_[0-9a-f]{16}$/);
  });
});
