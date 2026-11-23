/**
 * Guard 4 (operation integrity): every one of the 36 (from, to) status pairs is tried, exactly the
 * 8 legal ones pass; identity columns are immutable; version must go up by exactly one; and the
 * operation CHECKs (reference format, zero reference, duplicates, parties, amount, confirmed
 * block, failure reason).
 */

import type { Client } from 'pg';

import { createTestDatabase, type TestDatabase } from './support/database';
import {
  expectPgError,
  fiatClearing,
  insertDeployment,
  insertOperation,
  insertUser,
  ref,
  runLifecycle,
  setStatus,
  tx,
  ZERO_REF,
  type TestUser,
} from './support/fixtures';

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
  fiat = await fiatClearing(c);
  alice = await insertUser(c);
  bob = await insertUser(c);
});

afterAll(async () => {
  await db?.drop();
});

const STATUSES = [
  'requested',
  'ledger_reserved',
  'submitted',
  'confirmed',
  'failed',
  'reversed',
] as const;
type Status = (typeof STATUSES)[number];

const LEGAL = new Set([
  'requested>ledger_reserved',
  'ledger_reserved>submitted',
  'submitted>submitted',
  'submitted>confirmed',
  'ledger_reserved>failed',
  'submitted>failed',
  'failed>reversed',
  'failed>confirmed',
]);

/** A deposit operation brought legally (with its ledger entries) to `status`. */
async function depositAt(status: Status): Promise<string> {
  if (status === 'requested') {
    return insertOperation(c, { deploymentId, type: 'deposit', userId: alice.id, amount: 5n });
  }
  if (status === 'confirmed') {
    return runLifecycle(c, {
      deploymentId,
      type: 'deposit',
      fiat,
      user: alice,
      amount: 5n,
      outcome: 'settle',
    });
  }
  if (status === 'reversed') {
    return runLifecycle(c, {
      deploymentId,
      type: 'deposit',
      fiat,
      user: alice,
      amount: 5n,
      outcome: 'reverse',
    });
  }
  const id = await runLifecycle(c, {
    deploymentId,
    type: 'deposit',
    fiat,
    user: alice,
    amount: 5n,
    outcome: 'reserve-only',
  });
  if (status === 'ledger_reserved') return id;
  await tx(c, () => setStatus(c, id, 'submitted'));
  if (status === 'submitted') return id;
  await tx(c, () => setStatus(c, id, 'failed', { failureReason: 'dropped' }));
  return id;
}

/** UPDATE to `to` with every column the CHECKs want for that status, version + 1. */
function moveTo(id: string, to: Status) {
  return c.query(
    `UPDATE operation
        SET status = $2::operation_status, version = version + 1,
            failure_reason = CASE WHEN $2 = 'failed' THEN 'reverted'::failure_reason ELSE failure_reason END,
            confirmed_block = CASE WHEN $2 = 'confirmed' THEN 7 ELSE NULL END
      WHERE id = $1`,
    [id, to],
  );
}

describe('guard 4: exactly the legal status transitions', () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const legal = LEGAL.has(`${from}>${to}`);
      it(`${from} -> ${to} is ${legal ? 'allowed' : 'refused'}`, async () => {
        const id = await depositAt(from);
        await c.query('BEGIN');
        try {
          if (legal) {
            const r = await moveTo(id, to);
            expect(r.rowCount).toBe(1);
          } else {
            await expectPgError(moveTo(id, to), 'operation_transition');
          }
        } finally {
          // Statement-level guard only: roll back so the deferred ledger check is not involved.
          await c.query('ROLLBACK');
        }
      });
    }
  }

  it('an operation can only be created as requested or ledger_reserved', async () => {
    for (const status of ['submitted', 'confirmed', 'failed', 'reversed']) {
      await expectPgError(
        insertOperation(c, { deploymentId, type: 'deposit', userId: alice.id, amount: 1n, status }),
        'operation_transition',
      );
    }
  });

  it('Prisma: jumping requested -> confirmed is refused', async () => {
    const id = await depositAt('requested');
    await expectPgError(
      db.prisma.operation.update({
        where: { id },
        data: { status: 'confirmed', confirmedBlock: 1n, version: { increment: 1 } },
      }),
      'operation_transition',
    );
  });
});

describe('guard 4: identity columns are immutable', () => {
  const cases: [string, string][] = [
    ['id', `id = gen_random_uuid()`],
    ['type', `type = 'withdrawal'`],
    ['amount', `amount = amount + 1`],
    ['ref', `ref = '${ref()}'`],
    ['user_id', `user_id = '__BOB__'`],
    ['counterparty_user_id', `counterparty_user_id = '__BOB__'`],
    ['idempotency_key', `idempotency_key = 'changed'`],
    ['created_at', `created_at = now() - interval '1 day'`],
  ];
  for (const [col, set] of cases) {
    it(`refuses changing ${col}`, async () => {
      const id = await depositAt('requested');
      await expectPgError(
        c.query(
          `UPDATE operation SET ${set.replace('__BOB__', bob.id)}, version = version + 1 WHERE id = $1`,
          [id],
        ),
        'operation_immutable',
      );
    });
  }

  it('refuses moving an operation to another deployment', async () => {
    const id = await depositAt('requested');
    const other = await insertDeployment(c);
    await expectPgError(
      c.query(`UPDATE operation SET deployment_id = $2, version = version + 1 WHERE id = $1`, [
        id,
        other.id,
      ]),
      'deployment_rebind',
    );
  });

  it('refuses lowering resubmits_so_far, and changing the failure reason after the failure', async () => {
    const id = await depositAt('submitted');
    await tx(c, () =>
      c.query(`UPDATE operation SET resubmits_so_far = 2, version = version + 1 WHERE id = $1`, [
        id,
      ]),
    );
    await expectPgError(
      c.query(`UPDATE operation SET resubmits_so_far = 1, version = version + 1 WHERE id = $1`, [
        id,
      ]),
      'operation_immutable: resubmits_so_far',
    );
    const failed = await depositAt('failed');
    await expectPgError(
      c.query(
        `UPDATE operation SET status = 'reversed', failure_reason = 'rejected', version = version + 1 WHERE id = $1`,
        [failed],
      ),
      'operation_immutable: failure_reason',
    );
  });
});

describe('guard 4: version must increase by exactly one', () => {
  it('refuses an update that keeps, skips or lowers the version', async () => {
    const id = await depositAt('submitted');
    for (const v of ['version', 'version + 2', 'version - 1']) {
      await expectPgError(
        c.query(
          `UPDATE operation SET resubmits_so_far = resubmits_so_far + 1, version = ${v} WHERE id = $1`,
          [id],
        ),
        'operation_version',
      );
    }
  });

  it('Prisma: an update that forgets the version is refused', async () => {
    const id = await depositAt('submitted');
    await expectPgError(
      db.prisma.operation.update({ where: { id }, data: { resubmitsSoFar: { increment: 1 } } }),
      'operation_version',
    );
  });

  it('stops a lost update: the second writer of a stale read is refused even without WHERE version', async () => {
    const id = await depositAt('submitted');
    const read = await c.query<{ version: number }>(`SELECT version FROM operation WHERE id = $1`, [
      id,
    ]);
    const v = read.rows[0]!.version;
    const a = await db.pg();
    const b = await db.pg();
    // Both workers read version v and write v + 1 (as an engine computing it from its read would).
    await a.query(
      `UPDATE operation SET resubmits_so_far = resubmits_so_far + 1, version = $2 WHERE id = $1`,
      [id, v + 1],
    );
    await expectPgError(
      b.query(
        `UPDATE operation SET resubmits_so_far = resubmits_so_far + 1, version = $2 WHERE id = $1`,
        [id, v + 1],
      ),
      'operation_version',
    );
    await a.end();
    await b.end();
  });

  it('a new operation starts at version 0 with no resubmits', async () => {
    await expectPgError(
      c.query(
        `INSERT INTO operation (deployment_id, type, user_id, amount, ref, version) VALUES ($1, 'deposit', $2, 1, $3, 5)`,
        [deploymentId, alice.id, ref()],
      ),
      'operation_version',
    );
  });
});

describe('operation CHECKs', () => {
  it('reference: lowercase 0x + 64 hex, never zero, unique per deployment (reusable on another)', async () => {
    for (const bad of [
      ref().toUpperCase().replace('0X', '0x'),
      '0x1234',
      ref().slice(2) + 'ab',
      `${ref()}00`,
    ]) {
      await expectPgError(
        insertOperation(c, {
          deploymentId,
          type: 'deposit',
          userId: alice.id,
          amount: 1n,
          ref: bad,
        }),
        'operation_ref_format',
      );
    }
    await expectPgError(
      insertOperation(c, {
        deploymentId,
        type: 'deposit',
        userId: alice.id,
        amount: 1n,
        ref: ZERO_REF,
      }),
      'operation_ref_not_zero',
    );
    const r = ref();
    await insertOperation(c, {
      deploymentId,
      type: 'deposit',
      userId: alice.id,
      amount: 1n,
      ref: r,
    });
    await expectPgError(
      insertOperation(c, { deploymentId, type: 'deposit', userId: alice.id, amount: 1n, ref: r }),
      'operation_deployment_id_ref_key',
    );
    const other = await insertDeployment(c);
    await insertOperation(c, {
      deploymentId: other.id,
      type: 'deposit',
      userId: alice.id,
      amount: 1n,
      ref: r,
    });
  });

  it('idempotency key is unique per user, and two users may use the same key', async () => {
    await insertOperation(c, {
      deploymentId,
      type: 'deposit',
      userId: alice.id,
      amount: 1n,
      idempotencyKey: 'k-1',
    });
    await expectPgError(
      insertOperation(c, {
        deploymentId,
        type: 'deposit',
        userId: alice.id,
        amount: 1n,
        idempotencyKey: 'k-1',
      }),
      'operation_user_id_idempotency_key_key',
    );
    await insertOperation(c, {
      deploymentId,
      type: 'deposit',
      userId: bob.id,
      amount: 1n,
      idempotencyKey: 'k-1',
    });
  });

  it('parties: transfer needs a different counterparty; deposit and withdrawal have none', async () => {
    const bad: [string, string | null][] = [
      ['transfer', alice.id],
      ['transfer', null],
      ['deposit', bob.id],
      ['withdrawal', bob.id],
    ];
    for (const [type, cp] of bad) {
      await expectPgError(
        insertOperation(c, {
          deploymentId,
          type: type as 'transfer',
          userId: alice.id,
          counterpartyUserId: cp,
          amount: 1n,
        }),
        'operation_counterparty_matches_type',
      );
    }
  });

  it('amount must be positive and fit a bigint', async () => {
    for (const amount of [0n, -1n]) {
      await expectPgError(
        insertOperation(c, { deploymentId, type: 'deposit', userId: alice.id, amount }),
        'operation_amount_positive',
      );
    }
    await expectPgError(
      insertOperation(c, { deploymentId, type: 'deposit', userId: alice.id, amount: 2n ** 63n }),
      'out of range',
    );
  });

  it('confirmed requires confirmed_block, and confirmed_block exists only when confirmed', async () => {
    const id = await depositAt('submitted');
    await expectPgError(
      c.query(`UPDATE operation SET status = 'confirmed', version = version + 1 WHERE id = $1`, [
        id,
      ]),
      'operation_confirmed_block_iff_confirmed',
    );
    await expectPgError(
      c.query(`UPDATE operation SET confirmed_block = 9, version = version + 1 WHERE id = $1`, [
        id,
      ]),
      'operation_confirmed_block_iff_confirmed',
    );
  });

  it('failed requires a failure reason, and a reason cannot appear before a failure', async () => {
    const id = await depositAt('submitted');
    await expectPgError(
      c.query(`UPDATE operation SET status = 'failed', version = version + 1 WHERE id = $1`, [id]),
      'operation_failure_reason_required',
    );
    await expectPgError(
      c.query(
        `INSERT INTO operation (deployment_id, type, user_id, amount, ref, failure_reason)
         VALUES ($1, 'deposit', $2, 1, $3, 'dropped')`,
        [deploymentId, alice.id, ref()],
      ),
      'operation_failure_reason_only_after_failure',
    );
  });

  it('a new operation needs an active deployment', async () => {
    const inactive = await insertDeployment(c, { active: false });
    await expectPgError(
      insertOperation(c, {
        deploymentId: inactive.id,
        type: 'deposit',
        userId: alice.id,
        amount: 1n,
      }),
      'deployment_inactive',
    );
  });
});
