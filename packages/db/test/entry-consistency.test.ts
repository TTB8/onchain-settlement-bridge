/**
 * Guard 5 (journal entries consistent with their operation):
 *  5a the entry kind must be legal for the operation's current status;
 *  5b at COMMIT, the ledger and the status agree (reserve iff past requested, settle iff
 *     confirmed, reverse iff reversed);
 *  5c every posting is for the operation's amount, on fiat_clearing or the operation's parties.
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
  linesFor,
  runLifecycle,
  setStatus,
  tx,
  type TestUser,
} from './support/fixtures';

let db: TestDatabase;
let c: Client;
let deploymentId: string;
let fiat: string;
let alice: TestUser;
let bob: TestUser;
let mallory: TestUser;

beforeAll(async () => {
  db = await createTestDatabase();
  c = await db.pg();
  deploymentId = (await insertDeployment(c)).id;
  fiat = await fiatClearing(c);
  alice = await insertUser(c);
  bob = await insertUser(c);
  mallory = await insertUser(c);
  // Alice has 1000 available, so withdrawals and transfers have funds.
  await runLifecycle(c, {
    deploymentId,
    type: 'deposit',
    fiat,
    user: alice,
    amount: 1000n,
    outcome: 'settle',
  });
});

afterAll(async () => {
  await db?.drop();
});

const depositLines = (kind: 'reserve' | 'settle' | 'reverse') =>
  linesFor('deposit', kind, fiat, alice);

/** A deposit of 10 for Alice at `status`, with the entries that status needs. */
async function depositAt(
  status: 'ledger_reserved' | 'submitted' | 'failed' | 'confirmed' | 'reversed',
): Promise<string> {
  if (status === 'confirmed' || status === 'reversed') {
    return runLifecycle(c, {
      deploymentId,
      type: 'deposit',
      fiat,
      user: alice,
      amount: 10n,
      outcome: status === 'confirmed' ? 'settle' : 'reverse',
    });
  }
  const id = await runLifecycle(c, {
    deploymentId,
    type: 'deposit',
    fiat,
    user: alice,
    amount: 10n,
    outcome: 'reserve-only',
  });
  if (status === 'ledger_reserved') return id;
  await tx(c, () => setStatus(c, id, 'submitted'));
  if (status === 'submitted') return id;
  await tx(c, () => setStatus(c, id, 'failed', { failureReason: 'dropped' }));
  return id;
}

describe('guard 5a: entry kind must be legal for the operation status', () => {
  const illegal: [Parameters<typeof depositAt>[0], 'reserve' | 'settle' | 'reverse'][] = [
    ['submitted', 'reserve'],
    ['failed', 'reserve'],
    ['confirmed', 'reserve'],
    ['reversed', 'reserve'],
    ['ledger_reserved', 'settle'],
    ['submitted', 'settle'],
    ['failed', 'settle'],
    ['reversed', 'settle'],
    ['ledger_reserved', 'reverse'],
    ['submitted', 'reverse'],
    ['failed', 'reverse'],
    ['confirmed', 'reverse'],
  ];
  for (const [status, kind] of illegal) {
    it(`refuses a ${kind} entry while the operation is ${status}`, async () => {
      const id = await depositAt(status);
      await expectPgError(
        tx(c, () => insertEntry(c, id, kind, depositLines(kind), 10n)),
        `ledger_kind_status: a ${kind} entry is not allowed while operation`,
      );
    });
  }

  it('refuses a second settle entry (double settlement) by the unique (operation, kind)', async () => {
    const id = await depositAt('confirmed');
    await expectPgError(
      tx(c, () => insertEntry(c, id, 'settle', depositLines('settle'), 10n)),
      'journal_entry_operation_id_kind_key',
    );
  });

  it('allows the reserve for an operation created in the same transaction directly as ledger_reserved', async () => {
    await tx(c, async () => {
      const id = await insertOperation(c, {
        deploymentId,
        type: 'deposit',
        userId: alice.id,
        amount: 3n,
        status: 'ledger_reserved',
      });
      await insertEntry(c, id, 'reserve', depositLines('reserve'), 3n);
    });
  });
});

describe('guard 5b: at commit, status and ledger agree', () => {
  it('refuses ledger_reserved without a reserve entry (created that way)', async () => {
    await expectPgError(
      tx(c, () =>
        insertOperation(c, {
          deploymentId,
          type: 'deposit',
          userId: alice.id,
          amount: 3n,
          status: 'ledger_reserved',
        }),
      ),
      'ledger_status_mismatch',
    );
  });

  it('refuses requested -> ledger_reserved without a reserve entry', async () => {
    const id = await insertOperation(c, {
      deploymentId,
      type: 'deposit',
      userId: alice.id,
      amount: 3n,
    });
    await expectPgError(
      tx(c, () => setStatus(c, id, 'ledger_reserved')),
      'ledger_status_mismatch',
    );
  });

  it('refuses a reserve entry while the operation stays requested', async () => {
    const id = await insertOperation(c, {
      deploymentId,
      type: 'deposit',
      userId: alice.id,
      amount: 3n,
    });
    await expectPgError(
      tx(c, () => insertEntry(c, id, 'reserve', depositLines('reserve'), 3n)),
      'ledger_status_mismatch',
    );
  });

  it('refuses confirmed without the settle entry', async () => {
    const id = await depositAt('submitted');
    await expectPgError(
      tx(c, () => setStatus(c, id, 'confirmed')),
      'ledger_status_mismatch',
    );
  });

  it('refuses reversed without the reverse entry', async () => {
    const id = await depositAt('failed');
    await expectPgError(
      tx(c, () => setStatus(c, id, 'reversed')),
      'ledger_status_mismatch',
    );
  });

  it('allows the gated late confirmation failed -> confirmed with its settle entry', async () => {
    const id = await depositAt('failed');
    const before = await balance(c, alice.available);
    await tx(c, async () => {
      await setStatus(c, id, 'confirmed');
      await insertEntry(c, id, 'settle', depositLines('settle'), 10n);
    });
    expect(await balance(c, alice.available)).toBe(before + 10n);
  });
});

describe('guard 5c: postings match the operation', () => {
  it("refuses a posting to another user's account", async () => {
    const id = await insertOperation(c, {
      deploymentId,
      type: 'withdrawal',
      userId: alice.id,
      amount: 5n,
    });
    await expectPgError(
      tx(c, async () => {
        await insertEntry(
          c,
          id,
          'reserve',
          [
            [alice.available, 'debit'],
            [mallory.held, 'credit'],
          ],
          5n,
        );
        await setStatus(c, id, 'ledger_reserved');
      }),
      'ledger_foreign_account',
    );
  });

  it('refuses a transfer settle that credits a third user instead of the counterparty', async () => {
    const id = await runLifecycle(c, {
      deploymentId,
      type: 'transfer',
      fiat,
      user: alice,
      counterparty: bob,
      amount: 5n,
      outcome: 'reserve-only',
    });
    await tx(c, () => setStatus(c, id, 'submitted'));
    await expectPgError(
      tx(c, async () => {
        await setStatus(c, id, 'confirmed');
        await insertEntry(
          c,
          id,
          'settle',
          [
            [alice.held, 'debit'],
            [mallory.available, 'credit'],
          ],
          5n,
        );
      }),
      'ledger_foreign_account',
    );
  });

  it('refuses postings for a different amount than the operation, even when balanced', async () => {
    const id = await insertOperation(c, {
      deploymentId,
      type: 'deposit',
      userId: alice.id,
      amount: 100n,
    });
    await expectPgError(
      tx(c, async () => {
        await insertEntry(c, id, 'reserve', depositLines('reserve'), 50n);
        await setStatus(c, id, 'ledger_reserved');
      }),
      'ledger_amount_mismatch',
    );
  });

  it("DOCUMENTED LIMIT: a wrong but balanced pair inside the operation's own accounts is not caught here", async () => {
    // Deposit reserve straight to available (should be incoming). The posting table lives in
    // @bridge/domain; reconciliation, not this guard, catches it. This test pins the documented
    // scope so a reader is not misled; it is not a behaviour to rely on.
    await tx(c, async () => {
      const id = await insertOperation(c, {
        deploymentId,
        type: 'deposit',
        userId: bob.id,
        amount: 2n,
      });
      await insertEntry(
        c,
        id,
        'reserve',
        [
          [fiat, 'debit'],
          [bob.available, 'credit'],
        ],
        2n,
      );
      await setStatus(c, id, 'ledger_reserved');
    });
  });
});
