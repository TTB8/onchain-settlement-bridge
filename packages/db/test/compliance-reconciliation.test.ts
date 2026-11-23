/**
 * Guards added by migration 20261126000000_compliance_and_reconciliation (engine piece C):
 *  - compliance_change: idempotency key unique per requester, requester/key together, bounded
 *    texts, identity (incl. requester, key, reason) immutable, version and resubmits never go
 *    down, the confirmed block only when confirmed and never moved, failure reason only after a
 *    failure;
 *  - reconciliation_run: an `unknown` run carries an error and a compared run none; status and
 *    mismatch count agree with each other and with the array; runs are sealed;
 *  - reconciliation_mismatch: each row equals its run's array element, kinds are the domain's,
 *    the row count equals the run's count at COMMIT, append-only.
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

function first<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('expected a row');
  return row;
}

async function change(extra: Record<string, string | null> = {}): Promise<string> {
  const cols = ['deployment_id', 'user_id', 'action', 'ref', ...Object.keys(extra)];
  const values = [dep.id, alice.id, 'freeze', ref(), ...Object.values(extra)];
  const r = await c.query<{ id: string }>(
    `INSERT INTO compliance_change (${cols.join(', ')}) VALUES (${cols
      .map((_, i) => `$${i + 1}`)
      .join(', ')}) RETURNING id`,
    values,
  );
  return first(r.rows).id;
}

describe('compliance_change (piece C columns)', () => {
  it('the idempotency key is unique per requester; another requester may reuse it', async () => {
    await change({ requested_by: 'op-1', idempotency_key: 'k-1' });
    await expectPgError(
      change({ requested_by: 'op-1', idempotency_key: 'k-1' }),
      'compliance_change_requested_by_idempotency_key_key',
    );
    await expect(change({ requested_by: 'op-2', idempotency_key: 'k-1' })).resolves.toBeDefined();
  });

  it('requester and key go together; texts are bounded and non-empty', async () => {
    await expectPgError(change({ requested_by: 'op-1' }), 'compliance_change_key_with_requester');
    await expectPgError(change({ idempotency_key: 'k' }), 'compliance_change_key_with_requester');
    await expectPgError(
      change({ requested_by: '', idempotency_key: 'k-2' }),
      'compliance_change_requested_by_length',
    );
    await expectPgError(
      change({ requested_by: 'op-1', idempotency_key: 'x'.repeat(256) }),
      'compliance_change_idempotency_key_length',
    );
    await expectPgError(change({ reason: 'r'.repeat(501) }), 'compliance_change_reason_length');
    await expectPgError(change({ reason: '' }), 'compliance_change_reason_length');
  });

  it('requester, key and reason are identity: they never change', async () => {
    const id = await change({ requested_by: 'op-9', idempotency_key: 'k-9', reason: 'sanctions' });
    for (const set of [`requested_by = 'op-8'`, `idempotency_key = 'k-8'`, `reason = 'other'`]) {
      await expectPgError(
        c.query(`UPDATE compliance_change SET ${set} WHERE id = $1`, [id]),
        'compliance_immutable',
      );
    }
  });

  it('version and resubmits_so_far never decrease', async () => {
    const id = await change();
    await c.query(
      `UPDATE compliance_change SET status = 'submitted', version = 2, resubmits_so_far = 1 WHERE id = $1`,
      [id],
    );
    await expectPgError(
      c.query(`UPDATE compliance_change SET version = 1 WHERE id = $1`, [id]),
      'compliance_version',
    );
    await expectPgError(
      c.query(`UPDATE compliance_change SET resubmits_so_far = 0 WHERE id = $1`, [id]),
      'compliance_version',
    );
    await expectPgError(
      c.query(`UPDATE compliance_change SET version = -1 WHERE id = $1`, [id]),
      'compliance_version',
    );
  });

  it('the confirmed block exists only for a confirmed change and never moves once recorded', async () => {
    const id = await change();
    await c.query(`UPDATE compliance_change SET status = 'submitted' WHERE id = $1`, [id]);
    await expectPgError(
      c.query(`UPDATE compliance_change SET confirmed_block = 5 WHERE id = $1`, [id]),
      'compliance_change_confirmed_block_only_when_confirmed',
    );
    await c.query(
      `UPDATE compliance_change SET status = 'confirmed', confirmed_block = 5 WHERE id = $1`,
      [id],
    );
    await expectPgError(
      c.query(`UPDATE compliance_change SET confirmed_block = 6 WHERE id = $1`, [id]),
      'compliance_immutable',
    );
  });

  it('a failure reason exists only after a failure, and survives a late confirmation', async () => {
    const id = await change();
    await c.query(`UPDATE compliance_change SET status = 'submitted' WHERE id = $1`, [id]);
    await expectPgError(
      c.query(`UPDATE compliance_change SET failure_reason = 'reverted' WHERE id = $1`, [id]),
      'compliance_change_failure_reason_only_after_failure',
    );
    await c.query(
      `UPDATE compliance_change SET status = 'failed', failure_reason = 'reverted' WHERE id = $1`,
      [id],
    );
    const r = await c.query(
      `UPDATE compliance_change SET status = 'confirmed', confirmed_block = 9 WHERE id = $1`,
      [id],
    );
    expect(r.rowCount).toBe(1);
  });
});

async function run(
  status: string,
  opts: {
    mismatches?: unknown[];
    count?: number;
    error?: string | null;
    atBlock?: number | null;
  } = {},
): Promise<string> {
  const mismatches = opts.mismatches ?? [];
  const r = await c.query<{ id: string }>(
    `INSERT INTO reconciliation_run (deployment_id, at_block, final_block, head_block, status, mismatches, mismatch_count, error)
     VALUES ($1, $2, $2, 12, $3, $4, $5, $6) RETURNING id`,
    [
      dep.id,
      opts.atBlock === undefined ? 10 : opts.atBlock,
      status,
      JSON.stringify(mismatches),
      opts.count ?? mismatches.length,
      opts.error ?? null,
    ],
  );
  return first(r.rows).id;
}

const SUPPLY = { kind: 'supply_mismatch', expected: '1', observed: '2' };
const BALANCE = { kind: 'balance_mismatch', address: '0xab', expected: '1', observed: null };

/** A mismatch run and its rows, in one transaction (the only way the COMMIT check allows). */
async function mismatchRun(items: Record<string, unknown>[]): Promise<string> {
  await c.query('BEGIN');
  try {
    const id = await run('mismatch', { mismatches: items });
    for (const [i, item] of items.entries()) {
      await c.query(
        `INSERT INTO reconciliation_mismatch (run_id, ordinal, kind, detail) VALUES ($1, $2, $3, $4)`,
        [id, i, item.kind, JSON.stringify(item)],
      );
    }
    await c.query('COMMIT');
    return id;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  }
}

describe('reconciliation_run (piece C)', () => {
  it('an unknown run needs an error; a compared run has none and names its blocks', async () => {
    await expectPgError(run('unknown'), 'reconciliation_unknown_has_error');
    await expectPgError(run('ok', { error: 'boom' }), 'reconciliation_unknown_has_error');
    await expect(run('unknown', { error: 'node down', atBlock: null })).resolves.toBeDefined();
    await expectPgError(run('ok', { atBlock: null }), 'reconciliation_compared_has_blocks');
    await expectPgError(run('unknown', { error: 'x'.repeat(1001) }), 'reconciliation_error_length');
  });

  it('status, count and array agree: ok has none, mismatch has some, unknown compares nothing', async () => {
    await expectPgError(run('ok', { mismatches: [SUPPLY] }), 'reconciliation_count_matches_status');
    await expectPgError(run('mismatch'), 'reconciliation_count_matches_status');
    await expectPgError(
      run('unknown', { error: 'x', mismatches: [SUPPLY] }),
      'reconciliation_count_matches_status',
    );
    await expectPgError(
      run('mismatch', { mismatches: [SUPPLY], count: 2 }),
      'reconciliation_count_matches_array',
    );
  });

  it('a mismatch run must commit with exactly its rows (checked at COMMIT)', async () => {
    await expectPgError(run('mismatch', { mismatches: [SUPPLY] }), 'reconciliation_incomplete');
    const id = await mismatchRun([SUPPLY, BALANCE]);
    const rows = await c.query(
      `SELECT kind FROM reconciliation_mismatch WHERE run_id = $1 ORDER BY ordinal`,
      [id],
    );
    expect(rows.rows.map((r: { kind: string }) => r.kind)).toEqual([
      'supply_mismatch',
      'balance_mismatch',
    ]);
    // A row added later, in its own transaction, breaks the count.
    await expectPgError(
      c.query(
        `INSERT INTO reconciliation_mismatch (run_id, ordinal, kind, detail) VALUES ($1, 2, 'supply_mismatch', $2)`,
        [id, JSON.stringify(SUPPLY)],
      ),
      'reconciliation_mismatch_foreign',
    );
  });

  it('runs are sealed: no UPDATE, DELETE or TRUNCATE', async () => {
    const id = await run('ok');
    await expectPgError(
      c.query(`UPDATE reconciliation_run SET status = 'mismatch' WHERE id = $1`, [id]),
      'append_only: UPDATE on reconciliation_run',
    );
    await expectPgError(
      c.query(`DELETE FROM reconciliation_run WHERE id = $1`, [id]),
      'append_only: DELETE on reconciliation_run',
    );
    await expectPgError(c.query(`TRUNCATE reconciliation_run CASCADE`), 'append_only: TRUNCATE on');
  });
});

describe('reconciliation_mismatch', () => {
  it("a row must equal its run's array element: other detail, other ordinal, a clean run are refused", async () => {
    await c.query('BEGIN');
    const id = await run('mismatch', { mismatches: [SUPPLY] });
    await expectPgError(
      c.query(
        `INSERT INTO reconciliation_mismatch (run_id, ordinal, kind, detail) VALUES ($1, 0, 'supply_mismatch', $2)`,
        [id, JSON.stringify({ ...SUPPLY, observed: '3' })],
      ),
      'reconciliation_mismatch_foreign',
    );
    await c.query('ROLLBACK');
    const ok = await run('ok');
    await expectPgError(
      c.query(
        `INSERT INTO reconciliation_mismatch (run_id, ordinal, kind, detail) VALUES ($1, 0, 'supply_mismatch', $2)`,
        [ok, JSON.stringify(SUPPLY)],
      ),
      'reconciliation_mismatch_foreign',
    );
  });

  it('kinds are the domain kinds and match the detail; detail is an object (backstop CHECKs)', async () => {
    // The insert trigger already demands an exact copy of the run's element, so each CHECK is
    // reached only through a run whose own array holds the bad element.
    const cases: [unknown, string, string][] = [
      [{ kind: 'made_up' }, 'made_up', 'reconciliation_mismatch_kind_known'],
      [SUPPLY, 'balance_mismatch', 'reconciliation_mismatch_kind_matches_detail'],
      [[], 'supply_mismatch', 'reconciliation_mismatch_detail_is_object'],
    ];
    for (const [element, kind, needle] of cases) {
      await c.query('BEGIN');
      try {
        const id = await run('mismatch', { mismatches: [element] });
        await expectPgError(
          c.query(
            `INSERT INTO reconciliation_mismatch (run_id, ordinal, kind, detail) VALUES ($1, 0, $2, $3)`,
            [id, kind, JSON.stringify(element)],
          ),
          needle,
        );
      } finally {
        await c.query('ROLLBACK');
      }
    }
  });

  it('is append-only', async () => {
    const id = await mismatchRun([SUPPLY]);
    await expectPgError(
      c.query(`UPDATE reconciliation_mismatch SET kind = 'balance_mismatch' WHERE run_id = $1`, [
        id,
      ]),
      'append_only: UPDATE on reconciliation_mismatch',
    );
    await expectPgError(
      c.query(`DELETE FROM reconciliation_mismatch WHERE run_id = $1`, [id]),
      'append_only: DELETE on reconciliation_mismatch',
    );
    await expectPgError(c.query(`TRUNCATE reconciliation_mismatch`), 'append_only: TRUNCATE on');
  });
});
