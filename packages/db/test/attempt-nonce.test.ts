/**
 * Guard 8 (migration 20261125000000_attempt_nonce_guard): a (deployment, signer, nonce) belongs
 * to ONE outbox row. The same row may reuse its nonce (a fee bump, a rebroadcast); another row may
 * not, whatever the isolation level the writer uses (two real connections racing).
 */

import type { Client } from 'pg';

import { createTestDatabase, type TestDatabase } from './support/database';
import {
  expectPgError,
  fiatClearing,
  insertDeployment,
  insertUser,
  ref,
  runLifecycle,
  type TestUser,
} from './support/fixtures';

let db: TestDatabase;
let c: Client;
let dep: { id: string; token: string; registry: string };
let other: { id: string; token: string; registry: string };
let fiat: string;
let alice: TestUser;

beforeAll(async () => {
  db = await createTestDatabase();
  c = await db.pg();
  dep = await insertDeployment(c);
  other = await insertDeployment(c);
  fiat = await fiatClearing(c);
  alice = await insertUser(c);
});

afterAll(async () => {
  await db?.drop();
});

const CALL = JSON.stringify({ fn: 'mint', to: '0x01', amount: '10' });

/** A reserved deposit with its outbox row, on `d`. */
async function outboxRow(d: { id: string } = dep): Promise<{ ref: string; outboxId: string }> {
  const opId = await runLifecycle(c, {
    deploymentId: d.id,
    type: 'deposit',
    fiat,
    user: alice,
    amount: 10n,
    outcome: 'reserve-only',
  });
  const r = (await c.query<{ ref: string }>(`SELECT ref FROM operation WHERE id = $1`, [opId]))
    .rows[0]!.ref;
  const o = await c.query<{ id: string }>(
    `INSERT INTO outbox_message (deployment_id, signer, call, ref, operation_id) VALUES ($1, 'settlement', $2, $3, $4) RETURNING id`,
    [d.id, CALL, r, opId],
  );
  return { ref: r, outboxId: o.rows[0]!.id };
}

function insertAttempt(
  sql: Client,
  a: { outboxId: string; ref: string; nonce: number; d?: { id: string; token: string } },
) {
  const d = a.d ?? dep;
  return sql.query(
    `INSERT INTO chain_attempt (deployment_id, outbox_id, signer, nonce, hash, raw_transaction,
       max_fee_per_gas, max_priority_fee_per_gas, contract_address, ref)
     VALUES ($1, $2, 'settlement', $3, $4, '0x02f8ab', 100, 2, $5, $6)`,
    [d.id, a.outboxId, a.nonce, ref(), d.token, a.ref],
  );
}

let nonce = 1000;

describe('guard 8: one nonce, one subject', () => {
  it('the same outbox row may record its nonce again (bump, rebroadcast)', async () => {
    const o = await outboxRow();
    const n = nonce++;
    await insertAttempt(c, { ...o, nonce: n });
    await insertAttempt(c, { ...o, nonce: n });
    const count = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM chain_attempt WHERE outbox_id = $1`,
      [o.outboxId],
    );
    expect(Number(count.rows[0]?.n)).toBe(2);
  });

  it('another outbox row may not use a nonce already held', async () => {
    const a = await outboxRow();
    const b = await outboxRow();
    const n = nonce++;
    await insertAttempt(c, { ...a, nonce: n });
    await expectPgError(insertAttempt(c, { ...b, nonce: n }), 'chain_attempt_nonce_taken');
  });

  it('the same number on another deployment is another nonce', async () => {
    const a = await outboxRow();
    const b = await outboxRow(other);
    const n = nonce++;
    await insertAttempt(c, { ...a, nonce: n });
    await insertAttempt(c, { ...b, nonce: n, d: other });
  });

  it('refuses any isolation level but READ COMMITTED', async () => {
    const a = await outboxRow();
    for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
      await c.query(`BEGIN ISOLATION LEVEL ${level}`);
      try {
        await expectPgError(insertAttempt(c, { ...a, nonce: nonce++ }), 'chain_attempt_isolation');
      } finally {
        await c.query('ROLLBACK');
      }
    }
  });

  it.each(['READ COMMITTED', 'REPEATABLE READ'])(
    'two concurrent %s transactions recording one nonce for two subjects: at most one commits',
    async (level) => {
      const a = await outboxRow();
      const b = await outboxRow();
      const n = nonce++;
      const one = await db.pg();
      const two = await db.pg();
      try {
        await one.query(`BEGIN ISOLATION LEVEL ${level}`);
        await two.query(`BEGIN ISOLATION LEVEL ${level}`);
        // Both take their snapshot before either inserts.
        await one.query('SELECT 1 FROM chain_attempt LIMIT 1');
        await two.query('SELECT 1 FROM chain_attempt LIMIT 1');
        const first = insertAttempt(one, { ...a, nonce: n }).then(
          () => one.query('COMMIT').then(() => 'ok'),
          async (e: unknown) => {
            await one.query('ROLLBACK');
            return String(e);
          },
        );
        const second = insertAttempt(two, { ...b, nonce: n }).then(
          () => two.query('COMMIT').then(() => 'ok'),
          async (e: unknown) => {
            await two.query('ROLLBACK');
            return String(e);
          },
        );
        const results = await Promise.all([first, second]);
        expect(results.filter((r) => r === 'ok').length).toBeLessThanOrEqual(1);
        const held = await c.query<{ n: string }>(
          `SELECT count(DISTINCT outbox_id) AS n FROM chain_attempt WHERE deployment_id = $1 AND nonce = $2`,
          [dep.id, n],
        );
        expect(Number(held.rows[0]?.n)).toBeLessThanOrEqual(1);
        if (level === 'READ COMMITTED') {
          expect(results.filter((r) => r === 'ok')).toHaveLength(1);
          expect(results.some((r) => r.includes('chain_attempt_nonce_taken'))).toBe(true);
        } else {
          expect(results.every((r) => r.includes('chain_attempt_isolation'))).toBe(true);
        }
      } finally {
        await one.end();
        await two.end();
      }
    },
  );
});
