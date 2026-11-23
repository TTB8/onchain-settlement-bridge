/**
 * Guards added by migration 20261127000000_piece_c_review (review of engine piece C):
 *  - compliance_change.decision_seq: assigned by the database at insert (a client value is
 *    overwritten), strictly increasing, unique, immutable;
 *  - a compliance change starts at version 0 with no resubmissions;
 *  - app_user.wallet_address is immutable.
 */

import type { Client } from 'pg';

import { createTestDatabase, type TestDatabase } from './support/database';
import {
  expectPgError,
  insertDeployment,
  insertUser,
  ref,
  type TestUser,
} from './support/fixtures';

let db: TestDatabase;
let c: Client;
let alice: TestUser;
let dep: { id: string };

beforeAll(async () => {
  db = await createTestDatabase();
  c = await db.pg();
  alice = await insertUser(c);
  dep = await insertDeployment(c);
});

afterAll(async () => {
  await c?.end();
  await db?.drop();
});

async function insert(extra = ''): Promise<{ id: string; seq: string }> {
  const r = await c.query<{ id: string; decision_seq: string }>(
    `INSERT INTO compliance_change (deployment_id, user_id, action, ref${extra === '' ? '' : `, ${extra.split('=')[0]}`})
     VALUES ($1, $2, 'freeze', $3${extra === '' ? '' : `, ${extra.split('=')[1]}`}) RETURNING id, decision_seq`,
    [dep.id, alice.id, ref()],
  );
  const row = r.rows[0];
  if (row === undefined) throw new Error('no row');
  return { id: row.id, seq: row.decision_seq };
}

describe('compliance_change.decision_seq', () => {
  it('is assigned by the database, strictly increasing, and a client-supplied value is overwritten', async () => {
    const a = await insert();
    const b = await insert();
    expect(BigInt(b.seq)).toBeGreaterThan(BigInt(a.seq));
    const forged = await insert('decision_seq=1');
    expect(BigInt(forged.seq)).toBeGreaterThan(BigInt(b.seq));
  });

  it('never changes', async () => {
    const a = await insert();
    await expectPgError(
      c.query(`UPDATE compliance_change SET decision_seq = decision_seq + 1000 WHERE id = $1`, [
        a.id,
      ]),
      'compliance_immutable',
    );
    await expectPgError(
      c.query(
        `UPDATE compliance_change SET decision_seq = DEFAULT, status = 'submitted' WHERE id = $1`,
        [a.id],
      ),
      'compliance_immutable',
    );
  });
});

describe('compliance_change insert', () => {
  it('starts at version 0 with no resubmissions', async () => {
    await expectPgError(insert('version=1'), 'compliance_version');
    await expectPgError(insert('resubmits_so_far=2'), 'compliance_version');
  });
});

describe('app_user.wallet_address', () => {
  it('is immutable; other columns may still change', async () => {
    const u = await insertUser(c);
    await expectPgError(
      c.query(`UPDATE app_user SET wallet_address = $2 WHERE id = $1`, [
        u.id,
        `0x${'ab'.repeat(20)}`,
      ]),
      'app_user_wallet_immutable',
    );
    const r = await c.query(`UPDATE app_user SET frozen = true WHERE id = $1`, [u.id]);
    expect(r.rowCount).toBe(1);
  });
});
