/**
 * Guards added by migration 20261124000000_engine_review:
 *  - new operations and compliance changes hold FOR SHARE on their deployment row, so a
 *    deactivation racing an insert never commits alongside it (two real connections);
 *  - outbox_message.last_error is bounded and set together with last_error_at.
 * (Per-user idempotency is in operation.test.ts.)
 */

import type { Client } from 'pg';

import { createTestDatabase, type TestDatabase } from './support/database';
import {
  expectPgError,
  insertDeployment,
  insertOperation,
  insertUser,
  ref,
  type TestUser,
} from './support/fixtures';

let db: TestDatabase;
let c: Client;
let alice: TestUser;

beforeAll(async () => {
  db = await createTestDatabase();
  c = await db.pg();
  alice = await insertUser(c);
});

afterAll(async () => {
  await db?.drop();
});

/** Waits until some backend is blocked on a lock (or fails after ~5 s). */
async function waitForBlockedBackend(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const r = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`,
    );
    if (Number(r.rows[0]?.n) > 0) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error('no backend became blocked on a lock');
}

async function settle(p: Promise<unknown>): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await p;
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

const inserts = {
  operation: (sql: Client, deploymentId: string) =>
    insertOperation(sql, { deploymentId, type: 'deposit', userId: alice.id, amount: 1n }),
  compliance_change: (sql: Client, deploymentId: string) =>
    sql.query(
      `INSERT INTO compliance_change (deployment_id, user_id, action, ref) VALUES ($1, $2, 'verify', $3)`,
      [deploymentId, alice.id, ref()],
    ),
};

describe.each(Object.keys(inserts) as (keyof typeof inserts)[])(
  'a deactivation racing a %s insert',
  (kind) => {
    it('insert first: the deactivation waits for the commit, then is refused', async () => {
      const dep = await insertDeployment(c);
      const writer = await db.pg();
      const admin = await db.pg();
      await writer.query('BEGIN');
      await inserts[kind](writer, dep.id);
      const deactivation = settle(
        admin.query(`UPDATE deployment SET active = false WHERE id = $1`, [dep.id]),
      );
      await waitForBlockedBackend();
      await writer.query('COMMIT');
      const result = await deactivation;
      expect(result).toEqual({
        ok: false,
        message: expect.stringContaining('deployment_in_flight'),
      });
      const d = await c.query(`SELECT active FROM deployment WHERE id = $1`, [dep.id]);
      expect(d.rows[0].active).toBe(true);
    });

    it('deactivation first: the insert waits, then is refused', async () => {
      const dep = await insertDeployment(c);
      const writer = await db.pg();
      const admin = await db.pg();
      await admin.query('BEGIN');
      await admin.query(`UPDATE deployment SET active = false WHERE id = $1`, [dep.id]);
      const insert = settle(inserts[kind](writer, dep.id));
      await waitForBlockedBackend();
      await admin.query('COMMIT');
      const result = await insert;
      expect(result).toEqual({
        ok: false,
        message: expect.stringContaining('deployment_inactive'),
      });
      const table = kind === 'operation' ? 'operation' : 'compliance_change';
      const n = await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE deployment_id = $1`, [
        dep.id,
      ]);
      expect(n.rows[0].n).toBe(0);
    });
  },
);

describe('outbox last_error', () => {
  async function outboxRow(): Promise<string> {
    const dep = await insertDeployment(c);
    const r = ref();
    const opId = await insertOperation(c, {
      deploymentId: dep.id,
      type: 'deposit',
      userId: alice.id,
      amount: 1n,
      ref: r,
    });
    const o = await c.query<{ id: string }>(
      `INSERT INTO outbox_message (deployment_id, signer, call, ref, operation_id)
       VALUES ($1, 'settlement', '{}'::jsonb, $2, $3) RETURNING id`,
      [dep.id, r, opId],
    );
    return o.rows[0]!.id;
  }

  it('accepts a message up to 1000 characters with its timestamp, and it may change', async () => {
    const id = await outboxRow();
    await c.query(
      `UPDATE outbox_message SET last_error = $2, last_error_at = now() WHERE id = $1`,
      [id, 'x'.repeat(1000)],
    );
    await c.query(
      `UPDATE outbox_message SET last_error = 'later', last_error_at = now() WHERE id = $1`,
      [id],
    );
    const r = await c.query(`SELECT last_error FROM outbox_message WHERE id = $1`, [id]);
    expect(r.rows[0].last_error).toBe('later');
  });

  it('refuses a message over 1000 characters, an empty one, and either column alone', async () => {
    const id = await outboxRow();
    await expectPgError(
      c.query(`UPDATE outbox_message SET last_error = $2, last_error_at = now() WHERE id = $1`, [
        id,
        'x'.repeat(1001),
      ]),
      'outbox_last_error_length',
    );
    await expectPgError(
      c.query(`UPDATE outbox_message SET last_error = '', last_error_at = now() WHERE id = $1`, [
        id,
      ]),
      'outbox_last_error_length',
    );
    await expectPgError(
      c.query(`UPDATE outbox_message SET last_error = 'x' WHERE id = $1`, [id]),
      'outbox_last_error_at_with_error',
    );
    await expectPgError(
      c.query(`UPDATE outbox_message SET last_error_at = now() WHERE id = $1`, [id]),
      'outbox_last_error_at_with_error',
    );
  });
});
