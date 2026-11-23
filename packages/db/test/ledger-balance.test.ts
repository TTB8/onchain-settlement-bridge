/**
 * Guard 1 (every entry balances, at COMMIT), guard 1b (committed entries are sealed), the
 * `account_balance` view, and the happy path: full deposit, withdrawal and transfer lifecycles
 * written as the engine writes them, with balances checked against hand-computed values.
 */

import type { Client } from 'pg';

import { createTestDatabase, type TestDatabase } from './support/database';
import {
  balance,
  expectPgError,
  fiatClearing,
  insertDeployment,
  insertEntry,
  insertOperation,
  insertUser,
  runLifecycle,
  setStatus,
  tx,
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

async function count(table: string): Promise<number> {
  const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(r.rows[0]!.n);
}

/** A requested deposit for a fresh user, plus the user. */
async function requestedDeposit(amount = 100n): Promise<{ opId: string; user: TestUser }> {
  const user = await insertUser(c);
  const opId = await insertOperation(c, { deploymentId, type: 'deposit', userId: user.id, amount });
  return { opId, user };
}

describe('guard 1: every journal entry balances at commit', () => {
  it('accepts a balanced two-posting entry written with separate INSERTs in one transaction', async () => {
    const { opId, user } = await requestedDeposit(250n);
    await tx(c, async () => {
      await insertEntry(
        c,
        opId,
        'reserve',
        [
          [fiat, 'debit'],
          [user.incoming, 'credit'],
        ],
        250n,
      );
      await setStatus(c, opId, 'ledger_reserved');
    });
    expect(await balance(c, user.incoming)).toBe(250n);
  });

  it('refuses an unbalanced entry at COMMIT (the inserts themselves succeed)', async () => {
    const { opId, user } = await requestedDeposit(100n);
    const before = await count('posting');
    await c.query('BEGIN');
    // Each posting passes the per-row checks; only the deferred balance check can see the whole entry.
    const e = await c.query<{ id: string }>(
      `INSERT INTO journal_entry (operation_id, kind) VALUES ($1, 'reserve') RETURNING id`,
      [opId],
    );
    await c.query(
      `INSERT INTO posting (entry_id, account_id, side, amount) VALUES ($1, $2, 'debit', 100)`,
      [e.rows[0]!.id, fiat],
    );
    await c.query(
      `INSERT INTO posting (entry_id, account_id, side, amount) VALUES ($1, $2, 'debit', 100)`,
      [e.rows[0]!.id, user.incoming],
    );
    await setStatus(c, opId, 'ledger_reserved');
    await expectPgError(c.query('COMMIT'), 'ledger_unbalanced');
    expect(await count('posting')).toBe(before);
  });

  it('refuses an entry with a single posting', async () => {
    const { opId } = await requestedDeposit(100n);
    await expectPgError(
      tx(c, async () => {
        await insertEntry(c, opId, 'reserve', [[fiat, 'debit']], 100n);
        await setStatus(c, opId, 'ledger_reserved');
      }),
      /ledger_unbalanced: .* has 1 posting/,
    );
  });

  it('refuses an entry with no postings at all', async () => {
    const { opId } = await requestedDeposit(100n);
    await expectPgError(
      tx(c, async () => {
        await insertEntry(c, opId, 'reserve', [], 100n);
        await setStatus(c, opId, 'ledger_reserved');
      }),
      /ledger_unbalanced: .* has 0 posting/,
    );
  });

  it('refuses a negative-amount posting and a zero-amount posting', async () => {
    const { opId, user } = await requestedDeposit(100n);
    for (const amount of [-100n, 0n]) {
      // Two guards refuse it: the amount must match the operation (guard 5c) ...
      await expectPgError(
        tx(c, () =>
          insertEntry(
            c,
            opId,
            'reserve',
            [
              [fiat, 'debit'],
              [user.incoming, 'credit'],
            ],
            amount,
          ),
        ),
        'ledger_amount_mismatch',
      );
      // ... and, with guard 5c switched off inside this transaction only, the CHECK on its own.
      await expectPgError(
        tx(c, async () => {
          await c.query('ALTER TABLE posting DISABLE TRIGGER posting_matches_operation');
          await insertEntry(
            c,
            opId,
            'reserve',
            [
              [fiat, 'debit'],
              [user.incoming, 'credit'],
            ],
            amount,
          );
        }),
        'posting_amount_positive',
      );
    }
  });

  it('refuses, when constraints are forced IMMEDIATE, at the first posting (fails closed)', async () => {
    const { opId, user } = await requestedDeposit(100n);
    await expectPgError(
      tx(c, async () => {
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
        await insertEntry(
          c,
          opId,
          'reserve',
          [
            [fiat, 'debit'],
            [user.incoming, 'credit'],
          ],
          100n,
        );
      }),
      'ledger_unbalanced',
    );
  });
});

describe('guard 1b: a committed entry is sealed', () => {
  it('refuses a balanced pair of postings added to an entry by a later transaction', async () => {
    const user = await insertUser(c);
    const opId = await runLifecycle(c, {
      deploymentId,
      type: 'deposit',
      fiat,
      user,
      amount: 40n,
      outcome: 'reserve-only',
    });
    const e = await c.query<{ id: string }>(
      `SELECT id FROM journal_entry WHERE operation_id = $1`,
      [opId],
    );
    await expectPgError(
      tx(c, async () => {
        for (const [acc, side] of [
          [fiat, 'debit'],
          [user.incoming, 'credit'],
        ] as const) {
          await c.query(
            `INSERT INTO posting (entry_id, account_id, side, amount) VALUES ($1, $2, $3, 40)`,
            [e.rows[0]!.id, acc, side],
          );
        }
      }),
      'ledger_entry_sealed',
    );
    expect(await balance(c, user.incoming)).toBe(40n);
  });

  it('ignores a client-supplied sealed_tx (the database always sets its own)', async () => {
    const { opId, user } = await requestedDeposit(10n);
    await expectPgError(
      tx(c, async () => {
        // Claim the entry was created by transaction 1; the seal trigger overwrites it, so the
        // postings still go in (no "sealed" error) and only the balance of the claim matters.
        const e = await c.query<{ id: string; sealed: string; cur: string }>(
          `INSERT INTO journal_entry (operation_id, kind, sealed_tx) VALUES ($1, 'reserve', '1'::xid8)
           RETURNING id, sealed_tx::text AS sealed, pg_current_xact_id()::text AS cur`,
          [opId],
        );
        expect(e.rows[0]!.sealed).toBe(e.rows[0]!.cur);
        await c.query(
          `INSERT INTO posting (entry_id, account_id, side, amount) VALUES ($1, $2, 'debit', 10)`,
          [e.rows[0]!.id, fiat],
        );
        await c.query(
          `INSERT INTO posting (entry_id, account_id, side, amount) VALUES ($1, $2, 'credit', 10)`,
          [e.rows[0]!.id, user.incoming],
        );
        await c.query('SELECT 1/0'); // abort deliberately: this test only inspects the seal
      }),
      'division by zero',
    );
  });
});

describe('happy path: lifecycles written as the engine writes them', () => {
  it('deposit settle, withdrawal settle, transfer settle and their reversals give hand-computed balances', async () => {
    const alice = await insertUser(c);
    const bob = await insertUser(c);
    const fiatBefore = await balance(c, fiat);

    // Deposit 1000 to Alice, settled: incoming 0, available 1000, fiat +1000.
    await runLifecycle(c, {
      deploymentId,
      type: 'deposit',
      fiat,
      user: alice,
      amount: 1000n,
      outcome: 'settle',
    });
    expect(await balance(c, alice.available)).toBe(1000n);
    expect(await balance(c, alice.incoming)).toBe(0n);
    expect(await balance(c, fiat)).toBe(fiatBefore + 1000n);

    // Deposit 70 to Bob, reversed (never minted): Bob 0 everywhere, fiat unchanged.
    await runLifecycle(c, {
      deploymentId,
      type: 'deposit',
      fiat,
      user: bob,
      amount: 70n,
      outcome: 'reverse',
    });
    expect(await balance(c, bob.incoming)).toBe(0n);
    expect(await balance(c, bob.available)).toBe(0n);
    expect(await balance(c, fiat)).toBe(fiatBefore + 1000n);

    // Withdrawal 300 by Alice, settled: available 700, held 0, fiat -300.
    await runLifecycle(c, {
      deploymentId,
      type: 'withdrawal',
      fiat,
      user: alice,
      amount: 300n,
      outcome: 'settle',
    });
    expect(await balance(c, alice.available)).toBe(700n);
    expect(await balance(c, alice.held)).toBe(0n);
    expect(await balance(c, fiat)).toBe(fiatBefore + 700n);

    // Withdrawal 50 by Alice, reversed: back to 700 available.
    await runLifecycle(c, {
      deploymentId,
      type: 'withdrawal',
      fiat,
      user: alice,
      amount: 50n,
      outcome: 'reverse',
    });
    expect(await balance(c, alice.available)).toBe(700n);
    expect(await balance(c, alice.held)).toBe(0n);

    // Transfer 200 Alice -> Bob, settled: Alice 500, Bob 200, fiat unchanged.
    await runLifecycle(c, {
      deploymentId,
      type: 'transfer',
      fiat,
      user: alice,
      counterparty: bob,
      amount: 200n,
      outcome: 'settle',
    });
    expect(await balance(c, alice.available)).toBe(500n);
    expect(await balance(c, alice.held)).toBe(0n);
    expect(await balance(c, bob.available)).toBe(200n);

    // Transfer 120 Bob -> Alice, reversed: unchanged.
    await runLifecycle(c, {
      deploymentId,
      type: 'transfer',
      fiat,
      user: bob,
      counterparty: alice,
      amount: 120n,
      outcome: 'reverse',
    });
    expect(await balance(c, bob.available)).toBe(200n);
    expect(await balance(c, alice.available)).toBe(500n);

    // A pending (reserve-only) withdrawal of 100 by Alice: 400 available, 100 held.
    await runLifecycle(c, {
      deploymentId,
      type: 'withdrawal',
      fiat,
      user: alice,
      amount: 100n,
      outcome: 'reserve-only',
    });
    expect(await balance(c, alice.available)).toBe(400n);
    expect(await balance(c, alice.held)).toBe(100n);

    // Ledger-wide invariant: fiat_clearing = sum of all user balances (all kinds).
    const r = await c.query<{ users: string; fiat: string }>(
      `SELECT (SELECT sum(balance) FROM account_balance WHERE kind <> 'fiat_clearing')::text AS users,
              (SELECT balance FROM account_balance WHERE kind = 'fiat_clearing')::text AS fiat`,
    );
    expect(r.rows[0]!.users).toBe(r.rows[0]!.fiat);
  });

  it('the view shows 0 for an account with no postings, and the maximum bigint amount round-trips', async () => {
    const carol = await insertUser(c);
    expect(await balance(c, carol.available)).toBe(0n);
    const max = 2n ** 63n - 1n;
    await runLifecycle(c, {
      deploymentId,
      type: 'deposit',
      fiat,
      user: carol,
      amount: max,
      outcome: 'reserve-only',
    });
    expect(await balance(c, carol.incoming)).toBe(max);
  });
});
