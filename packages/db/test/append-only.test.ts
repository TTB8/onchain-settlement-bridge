/**
 * Guard 3 (append-only history): UPDATE, DELETE and TRUNCATE are refused on journal_entry,
 * posting and audit_log (raw SQL and Prisma), and rows other history depends on (accounts,
 * operations, compliance changes, chain attempts) are never deleted. Also the account guards:
 * fiat_clearing singleton, user accounts need a user, account identity is immutable.
 */

import type { Client } from 'pg';

import { createTestDatabase, type TestDatabase } from './support/database';
import {
  address,
  expectPgError,
  fiatClearing,
  insertDeployment,
  insertUser,
  runLifecycle,
  tx,
  type TestUser,
} from './support/fixtures';

let db: TestDatabase;
let c: Client;
let deploymentId: string;
let fiat: string;
let user: TestUser;
let opId: string;
let entryId: string;
let postingId: string;
let auditId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  c = await db.pg();
  deploymentId = (await insertDeployment(c)).id;
  fiat = await fiatClearing(c);
  user = await insertUser(c);
  opId = await runLifecycle(c, {
    deploymentId,
    type: 'deposit',
    fiat,
    user,
    amount: 10n,
    outcome: 'settle',
  });
  entryId = (
    await c.query<{ id: string }>(`SELECT id FROM journal_entry WHERE operation_id = $1 LIMIT 1`, [
      opId,
    ])
  ).rows[0]!.id;
  postingId = (
    await c.query<{ id: string }>(`SELECT id FROM posting WHERE entry_id = $1 LIMIT 1`, [entryId])
  ).rows[0]!.id;
  auditId = (
    await c.query<{ id: string }>(
      `INSERT INTO audit_log (entity, entity_id, from_state, to_state) VALUES ('operation', $1, 'submitted', 'confirmed')
       RETURNING id::text`,
      [opId],
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await db?.drop();
});

describe('guard 3: append-only ledger and audit log (raw SQL)', () => {
  const cases: [string, () => string, string][] = [
    [
      'journal_entry',
      () => `UPDATE journal_entry SET kind = 'reverse' WHERE id = '${entryId}'`,
      'UPDATE on journal_entry',
    ],
    [
      'journal_entry',
      () => `DELETE FROM journal_entry WHERE id = '${entryId}'`,
      'DELETE on journal_entry',
    ],
    ['journal_entry', () => `TRUNCATE journal_entry CASCADE`, 'TRUNCATE on'],
    [
      'posting',
      () => `UPDATE posting SET amount = amount + 1 WHERE id = '${postingId}'`,
      'UPDATE on posting',
    ],
    ['posting', () => `DELETE FROM posting WHERE id = '${postingId}'`, 'DELETE on posting'],
    ['posting', () => `TRUNCATE posting`, 'TRUNCATE on posting'],
    [
      'audit_log',
      () => `UPDATE audit_log SET to_state = 'x' WHERE id = ${auditId}`,
      'UPDATE on audit_log',
    ],
    ['audit_log', () => `DELETE FROM audit_log WHERE id = ${auditId}`, 'DELETE on audit_log'],
    ['audit_log', () => `TRUNCATE audit_log`, 'TRUNCATE on audit_log'],
  ];
  for (const [table, sql, needle] of cases) {
    it(`refuses ${sql().split(' ')[0]} on ${table}`, async () => {
      await expectPgError(c.query(sql()), `append_only: ${needle}`);
    });
  }

  it('the rows are all still there afterwards', async () => {
    const r = await c.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM posting WHERE id = $1)
            + (SELECT count(*) FROM journal_entry WHERE id = $2)
            + (SELECT count(*) FROM audit_log WHERE id = $3::bigint) AS n`,
      [postingId, entryId, auditId],
    );
    expect(Number(r.rows[0]!.n)).toBe(3);
  });
});

describe('guard 3: append-only through Prisma', () => {
  it('refuses prisma update / delete / deleteMany on posting, journal entry and audit log', async () => {
    const p = db.prisma;
    await expectPgError(
      p.posting.update({ where: { id: postingId }, data: { amount: 999n } }),
      'append_only',
    );
    await expectPgError(p.posting.delete({ where: { id: postingId } }), 'append_only');
    await expectPgError(p.posting.deleteMany({}), 'append_only');
    await expectPgError(
      p.journalEntry.update({ where: { id: entryId }, data: { kind: 'reverse' } }),
      'append_only',
    );
    await expectPgError(p.journalEntry.deleteMany({}), 'append_only');
    await expectPgError(
      p.auditLog.update({ where: { id: BigInt(auditId) }, data: { toState: 'x' } }),
      'append_only',
    );
    await expectPgError(p.auditLog.deleteMany({}), 'append_only');
  });

  it('still allows appending an audit row', async () => {
    const row = await db.prisma.auditLog.create({
      data: { entity: 'operation', entityId: opId, toState: 'requested', detail: { by: 'test' } },
    });
    expect(row.id).toBeGreaterThan(BigInt(auditId));
  });
});

describe('guard 3: rows history depends on are never deleted', () => {
  it('refuses DELETE and TRUNCATE of accounts, operations and compliance changes', async () => {
    await expectPgError(
      c.query(`DELETE FROM account WHERE id = $1`, [user.incoming]),
      'append_only: DELETE on account',
    );
    await expectPgError(c.query(`TRUNCATE account CASCADE`), 'append_only: TRUNCATE on');
    await expectPgError(
      c.query(`DELETE FROM operation WHERE id = $1`, [opId]),
      'append_only: DELETE on operation',
    );
    await expectPgError(c.query(`TRUNCATE operation CASCADE`), 'append_only: TRUNCATE on');
    const cc = await c.query<{ id: string }>(
      `INSERT INTO compliance_change (deployment_id, user_id, action, ref) VALUES ($1, $2, 'verify', $3) RETURNING id`,
      [deploymentId, user.id, `0x${'ab'.repeat(32)}`],
    );
    await expectPgError(
      c.query(`DELETE FROM compliance_change WHERE id = $1`, [cc.rows[0]!.id]),
      'append_only: DELETE on compliance_change',
    );
    await expectPgError(c.query(`TRUNCATE compliance_change CASCADE`), 'append_only: TRUNCATE on');
  });
});

describe('accounts', () => {
  it('fiat_clearing is a singleton', async () => {
    await expectPgError(
      c.query(`INSERT INTO account (kind) VALUES ('fiat_clearing')`),
      'account_one_fiat_clearing',
    );
  });

  it('fiat_clearing has no user, and every user account has one', async () => {
    await expectPgError(
      c.query(`INSERT INTO account (kind, user_id) VALUES ('fiat_clearing', $1)`, [user.id]),
      'account_user_matches_kind',
    );
    for (const kind of ['user_available', 'user_held', 'user_incoming']) {
      await expectPgError(
        c.query(`INSERT INTO account (kind) VALUES ($1)`, [kind]),
        'account_user_matches_kind',
      );
    }
  });

  it('a user has at most one account of each kind', async () => {
    await expectPgError(
      c.query(`INSERT INTO account (kind, user_id) VALUES ('user_available', $1)`, [user.id]),
      'account_kind_user_id_key',
    );
  });

  it('an account cannot be re-pointed to another user or kind, and guard_version cannot go down', async () => {
    const other = await insertUser(c);
    await expectPgError(
      c.query(`UPDATE account SET user_id = $2 WHERE id = $1`, [user.available, other.id]),
      'account_immutable',
    );
    await expectPgError(
      c.query(`UPDATE account SET kind = 'user_held' WHERE id = $1`, [other.incoming]),
      'account_immutable',
    );
    await expectPgError(
      c.query(`UPDATE account SET kind = 'user_incoming' WHERE id = $1`, [user.available]),
      'account_immutable',
    );
    await expectPgError(
      c.query(`UPDATE account SET guard_version = -1 WHERE id = $1`, [user.available]),
      'account_immutable',
    );
  });

  it('wallet addresses must be lowercase 0x + 40 hex, and unique', async () => {
    for (const bad of [
      '0xABCDEF0123456789abcdef0123456789abcdef01',
      '0x1234',
      'abcdef0123456789abcdef0123456789abcdef0123',
    ]) {
      await expectPgError(
        c.query(`INSERT INTO app_user (wallet_address) VALUES ($1)`, [bad]),
        'app_user_wallet_address_format',
      );
    }
    const a = address();
    await tx(c, () => c.query(`INSERT INTO app_user (wallet_address) VALUES ($1)`, [a]));
    await expectPgError(
      c.query(`INSERT INTO app_user (wallet_address) VALUES ($1)`, [a]),
      'app_user_wallet_address_key',
    );
  });
});
