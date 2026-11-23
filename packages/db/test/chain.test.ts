/**
 * Guard 6 (chain-side integrity): deployment binding (composite keys + no rebind on any table),
 * deployment identity and deactivation, outbox payload and subject, chain-attempt immutability and
 * no deletion, signer state, compliance-change transitions, and the lowercase-hex CHECKs on
 * blocks, events, attempts and the audit log; plus a reorg removing a block's events.
 */

import type { Client } from 'pg';

import { createTestDatabase, type TestDatabase } from './support/database';
import {
  address,
  expectPgError,
  fiatClearing,
  hex,
  insertDeployment,
  insertOperation,
  insertUser,
  ref,
  runLifecycle,
  tx,
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
  await c.query(
    `INSERT INTO signer_state (deployment_id, signer, address) VALUES ($1, 'settlement', $2), ($1, 'compliance', $3)`,
    [dep.id, address(), address()],
  );
});

afterAll(async () => {
  await db?.drop();
});

const CALL = JSON.stringify({ fn: 'mint', to: '0x01', amount: '10' });

/** A reserved deposit with its outbox row. */
async function opWithOutbox(): Promise<{ opId: string; ref: string; outboxId: string }> {
  const opId = await runLifecycle(c, {
    deploymentId: dep.id,
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
    [dep.id, CALL, r, opId],
  );
  return { opId, ref: r, outboxId: o.rows[0]!.id };
}

interface AttemptInput {
  deploymentId?: string;
  outboxId: string;
  ref: string;
  signer?: string;
  nonce?: number;
  hash?: string;
  raw?: string;
  maxFee?: bigint;
  maxPriority?: bigint;
  contract?: string;
}

let nextTestNonce = 0;

function insertAttempt(a: AttemptInput) {
  return c.query<{ id: string }>(
    `INSERT INTO chain_attempt (deployment_id, outbox_id, signer, nonce, hash, raw_transaction,
       max_fee_per_gas, max_priority_fee_per_gas, contract_address, ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      a.deploymentId ?? dep.id,
      a.outboxId,
      a.signer ?? 'settlement',
      // Each attempt its own nonce unless a test says otherwise: a nonce shared between two
      // outbox rows is refused (guard 8, chain_attempt_nonce_taken).
      a.nonce ?? nextTestNonce++,
      a.hash ?? ref(),
      a.raw ?? '0x02f8ab',
      (a.maxFee ?? 100n).toString(),
      (a.maxPriority ?? 2n).toString(),
      a.contract ?? dep.token,
      a.ref,
    ],
  );
}

describe('guard 6c: chain attempts are immutable and never deleted', () => {
  let attemptId: string;
  let outbox: { ref: string; outboxId: string };

  beforeAll(async () => {
    outbox = await opWithOutbox();
    attemptId = (await insertAttempt({ outboxId: outbox.outboxId, ref: outbox.ref })).rows[0]!.id;
  });

  const identity: [string, () => string][] = [
    ['outbox_id', () => `outbox_id = gen_random_uuid()`],
    ['signer', () => `signer = 'compliance'`],
    ['nonce', () => `nonce = nonce + 1`],
    ['hash', () => `hash = '${ref()}'`],
    ['raw_transaction', () => `raw_transaction = '0x02ff'`],
    ['max_fee_per_gas', () => `max_fee_per_gas = max_fee_per_gas + 1`],
    ['max_priority_fee_per_gas', () => `max_priority_fee_per_gas = 1`],
    ['contract_address', () => `contract_address = '${address()}'`],
    ['ref', () => `ref = '${ref()}'`],
    ['submitted_at', () => `submitted_at = now() - interval '1 hour'`],
    ['id', () => `id = gen_random_uuid()`],
  ];
  for (const [col, set] of identity) {
    it(`refuses changing ${col}`, async () => {
      await expectPgError(
        c.query(`UPDATE chain_attempt SET ${set()} WHERE id = $1`, [attemptId]),
        'chain_attempt_immutable',
      );
    });
  }

  it('refuses moving an attempt to another deployment', async () => {
    await expectPgError(
      c.query(`UPDATE chain_attempt SET deployment_id = $2 WHERE id = $1`, [attemptId, other.id]),
      'deployment_rebind',
    );
  });

  it('allows the observation columns to change', async () => {
    const r = await c.query(
      `UPDATE chain_attempt SET status = 'mined', block_number = 12, block_hash = $2, bumps_so_far = 1,
              last_checked_at = now() WHERE id = $1`,
      [attemptId, ref()],
    );
    expect(r.rowCount).toBe(1);
  });

  it('refuses DELETE and TRUNCATE (raw SQL and Prisma)', async () => {
    await expectPgError(
      c.query(`DELETE FROM chain_attempt WHERE id = $1`, [attemptId]),
      'append_only: DELETE on chain_attempt',
    );
    await expectPgError(
      c.query(`TRUNCATE chain_attempt`),
      'append_only: TRUNCATE on chain_attempt',
    );
    await expectPgError(db.prisma.chainAttempt.deleteMany({}), 'append_only');
  });

  it("refuses an attempt aimed at a contract that is not the signer's contract of its deployment", async () => {
    const o = await opWithOutbox();
    for (const contract of [dep.registry, other.token, address()]) {
      await expectPgError(
        insertAttempt({ outboxId: o.outboxId, ref: o.ref, contract }),
        'chain_attempt_contract',
      );
    }
  });

  it('refuses an attempt whose ref, signer or deployment differ from its outbox row (composite key)', async () => {
    const o = await opWithOutbox();
    await expectPgError(
      insertAttempt({ outboxId: o.outboxId, ref: ref() }),
      'chain_attempt_outbox_id_deployment_id_signer_ref_fkey',
    );
    await expectPgError(
      insertAttempt({
        outboxId: o.outboxId,
        ref: o.ref,
        deploymentId: other.id,
        contract: other.token,
      }),
      'chain_attempt_outbox_id_deployment_id_signer_ref_fkey',
    );
    await expectPgError(
      insertAttempt({
        outboxId: o.outboxId,
        ref: o.ref,
        signer: 'compliance',
        contract: dep.registry,
      }),
      'chain_attempt_outbox_id_deployment_id_signer_ref_fkey',
    );
  });

  it('format CHECKs: hash, raw bytes, fees, nonce; hashes are unique', async () => {
    const o = await opWithOutbox();
    const base = { outboxId: o.outboxId, ref: o.ref };
    await expectPgError(
      insertAttempt({ ...base, hash: ref().toUpperCase().replace('0X', '0x') }),
      'chain_attempt_hash_format',
    );
    await expectPgError(insertAttempt({ ...base, hash: hex(31) }), 'chain_attempt_hash_format');
    await expectPgError(insertAttempt({ ...base, raw: '0x2' }), 'chain_attempt_raw_format');
    await expectPgError(insertAttempt({ ...base, raw: 'f8ab' }), 'chain_attempt_raw_format');
    await expectPgError(
      insertAttempt({ ...base, maxFee: 1n, maxPriority: 2n }),
      'chain_attempt_fees_valid',
    );
    await expectPgError(insertAttempt({ ...base, nonce: -1 }), 'chain_attempt_nonce_non_negative');
    const h = ref();
    await insertAttempt({ ...base, hash: h });
    await expectPgError(insertAttempt({ ...base, hash: h, nonce: 1 }), 'chain_attempt_hash_key');
  });

  it('block number and block hash are observed together', async () => {
    await expectPgError(
      c.query(`UPDATE chain_attempt SET block_number = 5, block_hash = NULL WHERE id = $1`, [
        attemptId,
      ]),
      'chain_attempt_block_seen_together',
    );
  });
});

describe('guard 6a: every row stays bound to its deployment', () => {
  it('refuses rebinding outbox, compliance change, signer state, block, indexer state, event and reconciliation rows', async () => {
    const o = await opWithOutbox();
    const cc = await c.query<{ id: string }>(
      `INSERT INTO compliance_change (deployment_id, user_id, action, ref) VALUES ($1, $2, 'freeze', $3) RETURNING id`,
      [dep.id, alice.id, ref()],
    );
    const blockHash = ref();
    await c.query(
      `INSERT INTO indexed_block (deployment_id, number, hash, parent_hash, timestamp) VALUES ($1, 50, $2, $3, now())`,
      [dep.id, blockHash, ref()],
    );
    await c.query(`INSERT INTO indexer_state (deployment_id, last_indexed_block) VALUES ($1, 50)`, [
      dep.id,
    ]);
    const ev = await c.query<{ id: string }>(
      `INSERT INTO chain_event (deployment_id, block_number, block_hash, tx_hash, log_index, kind, account, flag_value)
       VALUES ($1, 50, $2, $3, 0, 'FrozenSet', $4, true) RETURNING id`,
      [dep.id, blockHash, ref(), alice.wallet],
    );
    const rr = await c.query<{ id: string }>(
      `INSERT INTO reconciliation_run (deployment_id, at_block, final_block, status) VALUES ($1, 50, 40, 'ok') RETURNING id`,
      [dep.id],
    );
    const rebinds: [string, string, unknown[]][] = [
      [
        'outbox_message',
        `UPDATE outbox_message SET deployment_id = $2 WHERE id = $1`,
        [o.outboxId, other.id],
      ],
      [
        'compliance_change',
        `UPDATE compliance_change SET deployment_id = $2 WHERE id = $1`,
        [cc.rows[0]!.id, other.id],
      ],
      [
        'signer_state',
        `UPDATE signer_state SET deployment_id = $2 WHERE deployment_id = $1 AND signer = 'settlement'`,
        [dep.id, other.id],
      ],
      [
        'indexed_block',
        `UPDATE indexed_block SET deployment_id = $2 WHERE deployment_id = $1 AND number = 50`,
        [dep.id, other.id],
      ],
      [
        'indexer_state',
        `UPDATE indexer_state SET deployment_id = $2 WHERE deployment_id = $1`,
        [dep.id, other.id],
      ],
      [
        'chain_event',
        `UPDATE chain_event SET deployment_id = $2 WHERE id = $1`,
        [ev.rows[0]!.id, other.id],
      ],
      [
        'reconciliation_run',
        `UPDATE reconciliation_run SET deployment_id = $2 WHERE id = $1`,
        [rr.rows[0]!.id, other.id],
      ],
    ];
    for (const [table, sql, params] of rebinds) {
      await expectPgError(c.query(sql, params), `deployment_rebind: ${table}`);
    }
  });

  it("refuses an outbox row whose ref or deployment differ from its operation's (composite key)", async () => {
    const opId = await runLifecycle(c, {
      deploymentId: dep.id,
      type: 'deposit',
      fiat,
      user: alice,
      amount: 1n,
      outcome: 'reserve-only',
    });
    const r = (await c.query<{ ref: string }>(`SELECT ref FROM operation WHERE id = $1`, [opId]))
      .rows[0]!.ref;
    const insert = (deploymentId: string, outRef: string) =>
      c.query(
        `INSERT INTO outbox_message (deployment_id, signer, call, ref, operation_id) VALUES ($1, 'settlement', $2, $3, $4)`,
        [deploymentId, CALL, outRef, opId],
      );
    await expectPgError(
      insert(dep.id, ref()),
      'outbox_message_operation_id_deployment_id_ref_fkey',
    );
    await expectPgError(insert(other.id, r), 'outbox_message_operation_id_deployment_id_ref_fkey');
    await insert(dep.id, r);
    await expectPgError(insert(dep.id, r), 'outbox_message_deployment_id_ref_key');
  });
});

describe('guard 6b: deployment identity and deactivation', () => {
  it('refuses changing chain, contracts or deployment block', async () => {
    for (const set of [
      `chain_id = chain_id + 1`,
      `token_address = '${address()}'`,
      `registry_address = '${address()}'`,
      `deployment_block = 2`,
    ]) {
      await expectPgError(
        c.query(`UPDATE deployment SET ${set} WHERE id = $1`, [dep.id]),
        'deployment_immutable',
      );
    }
  });

  it('refuses deactivating a deployment with a non-final operation, allows it once all are final', async () => {
    const d = await insertDeployment(c);
    const opId = await runLifecycle(c, {
      deploymentId: d.id,
      type: 'deposit',
      fiat,
      user: alice,
      amount: 1n,
      outcome: 'reserve-only',
    });
    await expectPgError(
      c.query(`UPDATE deployment SET active = false WHERE id = $1`, [d.id]),
      'deployment_in_flight',
    );
    // Bring it to a final state, then deactivation is allowed.
    await tx(c, async () => {
      await c.query(
        `UPDATE operation SET status = 'failed', failure_reason = 'rejected', version = version + 1 WHERE id = $1`,
        [opId],
      );
    });
    await expectPgError(
      c.query(`UPDATE deployment SET active = false WHERE id = $1`, [d.id]),
      'deployment_in_flight',
    );
    const d2 = await insertDeployment(c);
    await runLifecycle(c, {
      deploymentId: d2.id,
      type: 'deposit',
      fiat,
      user: alice,
      amount: 1n,
      outcome: 'settle',
    });
    await c.query(`UPDATE deployment SET active = false WHERE id = $1`, [d2.id]);
  });

  it('refuses deactivating with a compliance change in flight', async () => {
    const d = await insertDeployment(c);
    await c.query(
      `INSERT INTO compliance_change (deployment_id, user_id, action, ref) VALUES ($1, $2, 'verify', $3)`,
      [d.id, alice.id, ref()],
    );
    await expectPgError(
      c.query(`UPDATE deployment SET active = false WHERE id = $1`, [d.id]),
      'deployment_in_flight',
    );
  });

  it('one active deployment per chain; contract addresses are lowercase hex; (chain, token) unique', async () => {
    await expectPgError(
      insertDeployment(c, { chainId: 7 }).then(() => insertDeployment(c, { chainId: 7 })),
      'deployment_one_active_per_chain',
    );
    for (const col of ['token_address', 'registry_address']) {
      await expectPgError(
        c.query(
          `INSERT INTO deployment (chain_id, token_address, registry_address, deployment_block) VALUES (1, $1, $2, 0)`,
          col === 'token_address'
            ? [address().toUpperCase().replace('0X', '0x'), address()]
            : [address(), '0x12'],
        ),
        `deployment_${col}_format`,
      );
    }
    const t = address();
    await c.query(
      `INSERT INTO deployment (chain_id, token_address, registry_address, deployment_block) VALUES (9, $1, $2, 0)`,
      [t, address()],
    );
    await expectPgError(
      c.query(
        `INSERT INTO deployment (chain_id, token_address, registry_address, deployment_block) VALUES (9, $1, $2, 0)`,
        [t, address()],
      ),
      'deployment_chain_id_token_address_key',
    );
  });
});

describe('guard 6d: outbox subject and payload', () => {
  it('exactly one subject, with the matching signer', async () => {
    const o = await opWithOutbox();
    const cc = await c.query<{ id: string; ref: string }>(
      `INSERT INTO compliance_change (deployment_id, user_id, action, ref) VALUES ($1, $2, 'verify', $3) RETURNING id, ref`,
      [dep.id, alice.id, ref()],
    );
    const ins = (signer: string, opId: string | null, ccId: string | null, r: string) =>
      c.query(
        `INSERT INTO outbox_message (deployment_id, signer, call, ref, operation_id, compliance_change_id) VALUES ($1, $2, $3, $4, $5, $6)`,
        [dep.id, signer, CALL, r, opId, ccId],
      );
    await expectPgError(ins('settlement', null, null, ref()), 'outbox_exactly_one_subject');
    await expectPgError(ins('compliance', o.opId, null, o.ref), 'outbox_exactly_one_subject');
    await expectPgError(
      ins('settlement', null, cc.rows[0]!.id, cc.rows[0]!.ref),
      'outbox_exactly_one_subject',
    );
    await expectPgError(
      ins('settlement', o.opId, cc.rows[0]!.id, o.ref),
      'outbox_exactly_one_subject',
    );
    await ins('compliance', null, cc.rows[0]!.id, cc.rows[0]!.ref);
  });

  it('payload is immutable; status and lock columns move', async () => {
    const o = await opWithOutbox();
    for (const set of [
      `call = '{"fn":"burn"}'`,
      `signer = 'compliance'`,
      `ref = '${ref()}'`,
      `operation_id = NULL`,
      `created_at = now() - interval '1 day'`,
    ]) {
      await expectPgError(
        c.query(`UPDATE outbox_message SET ${set} WHERE id = $1`, [o.outboxId]),
        'outbox_immutable',
      );
    }
    await c.query(
      `UPDATE outbox_message SET status = 'processing', locked_at = now(), locked_by = 'worker-1', attempts_count = 1 WHERE id = $1`,
      [o.outboxId],
    );
  });

  it('processing requires lock columns; call must be a JSON object; ref format', async () => {
    const o = await opWithOutbox();
    await expectPgError(
      c.query(`UPDATE outbox_message SET status = 'processing' WHERE id = $1`, [o.outboxId]),
      'outbox_processing_is_locked',
    );
    const opId = await insertOperation(c, {
      deploymentId: dep.id,
      type: 'deposit',
      userId: alice.id,
      amount: 1n,
    });
    await expectPgError(
      c.query(
        `INSERT INTO outbox_message (deployment_id, signer, call, ref, operation_id) VALUES ($1, 'settlement', '[1]', $2, $3)`,
        [dep.id, ref(), opId],
      ),
      'outbox_call_is_object',
    );
    await expectPgError(
      c.query(
        `INSERT INTO outbox_message (deployment_id, signer, call, ref, operation_id) VALUES ($1, 'settlement', '{}', '0xAB', $2)`,
        [dep.id, opId],
      ),
      'outbox_ref_format',
    );
  });
});

describe('guard 6e: signer state', () => {
  it('address is immutable and lowercase hex', async () => {
    await expectPgError(
      c.query(
        `UPDATE signer_state SET address = $2 WHERE deployment_id = $1 AND signer = 'settlement'`,
        [dep.id, address()],
      ),
      'signer_state_immutable',
    );
    await expectPgError(
      c.query(
        `INSERT INTO signer_state (deployment_id, signer, address) VALUES ($1, 'settlement', '0xABC')`,
        [other.id],
      ),
      'signer_state_address_format',
    );
    await expectPgError(
      c.query(
        `INSERT INTO signer_state (deployment_id, signer, address) VALUES ($1, 'settlement', $2)`,
        [dep.id, address()],
      ),
      'signer_state_pkey',
    );
  });
});

describe('guard 6f: compliance change transitions', () => {
  const S = ['requested', 'submitted', 'confirmed', 'failed'] as const;
  const LEGAL = new Set([
    'requested>submitted',
    'requested>failed',
    'submitted>submitted',
    'submitted>confirmed',
    'submitted>failed',
    'failed>confirmed',
  ]);
  const PATH: Record<(typeof S)[number], string[]> = {
    requested: [],
    submitted: ['submitted'],
    confirmed: ['submitted', 'confirmed'],
    failed: ['failed'],
  };
  for (const from of S) {
    for (const to of S) {
      const legal = LEGAL.has(`${from}>${to}`);
      it(`${from} -> ${to} is ${legal ? 'allowed' : 'refused'}`, async () => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO compliance_change (deployment_id, user_id, action, ref) VALUES ($1, $2, 'unfreeze', $3) RETURNING id`,
          [dep.id, alice.id, ref()],
        );
        const id = r.rows[0]!.id;
        for (const step of PATH[from])
          await c.query(`UPDATE compliance_change SET status = $2 WHERE id = $1`, [id, step]);
        const move = c.query(`UPDATE compliance_change SET status = $2 WHERE id = $1`, [id, to]);
        if (legal) expect((await move).rowCount).toBe(1);
        else await expectPgError(move, 'compliance_transition');
      });
    }
  }

  it('starts as requested; identity immutable; ref format, non-zero and unique per deployment', async () => {
    await expectPgError(
      c.query(
        `INSERT INTO compliance_change (deployment_id, user_id, action, ref, status) VALUES ($1, $2, 'verify', $3, 'submitted')`,
        [dep.id, alice.id, ref()],
      ),
      'compliance_transition',
    );
    const r = ref();
    const cc = await c.query<{ id: string }>(
      `INSERT INTO compliance_change (deployment_id, user_id, action, ref) VALUES ($1, $2, 'verify', $3) RETURNING id`,
      [dep.id, alice.id, r],
    );
    const bob = await insertUser(c);
    for (const set of [`user_id = '${bob.id}'`, `action = 'unverify'`, `ref = '${ref()}'`]) {
      await expectPgError(
        c.query(`UPDATE compliance_change SET ${set} WHERE id = $1`, [cc.rows[0]!.id]),
        'compliance_immutable',
      );
    }
    await expectPgError(
      c.query(
        `INSERT INTO compliance_change (deployment_id, user_id, action, ref) VALUES ($1, $2, 'verify', $3)`,
        [dep.id, alice.id, r],
      ),
      'compliance_change_deployment_id_ref_key',
    );
    await expectPgError(
      c.query(
        `INSERT INTO compliance_change (deployment_id, user_id, action, ref) VALUES ($1, $2, 'verify', $3)`,
        [dep.id, alice.id, `0x${'0'.repeat(64)}`],
      ),
      'compliance_change_ref_not_zero',
    );
    const inactive = await insertDeployment(c, { active: false });
    await expectPgError(
      c.query(
        `INSERT INTO compliance_change (deployment_id, user_id, action, ref) VALUES ($1, $2, 'verify', $3)`,
        [inactive.id, alice.id, ref()],
      ),
      'deployment_inactive',
    );
  });
});

describe('indexed blocks and chain events', () => {
  async function block(number: number, hash = ref()): Promise<string> {
    await c.query(
      `INSERT INTO indexed_block (deployment_id, number, hash, parent_hash, timestamp) VALUES ($1, $2, $3, $4, now())`,
      [dep.id, number, hash, ref()],
    );
    return hash;
  }

  function event(fields: Record<string, unknown>) {
    const cols = Object.keys(fields);
    return c.query(
      `INSERT INTO chain_event (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(fields),
    );
  }

  it('block hashes are lowercase 0x + 64 hex', async () => {
    await expectPgError(
      block(1000, ref().toUpperCase().replace('0X', '0x')),
      'indexed_block_hash_format',
    );
    await expectPgError(
      c.query(
        `INSERT INTO indexed_block (deployment_id, number, hash, parent_hash, timestamp) VALUES ($1, 1001, $2, '0x00', now())`,
        [dep.id, ref()],
      ),
      'indexed_block_parent_hash_format',
    );
  });

  it('events: every hex field CHECKed, fields must match the kind, the block must be indexed with that hash', async () => {
    const h = await block(2000);
    const base = { deployment_id: dep.id, block_number: 2000, block_hash: h, log_index: 0 };
    const minted = {
      ...base,
      tx_hash: ref(),
      kind: 'Minted',
      to_address: alice.wallet,
      amount: '10',
      ref: ref(),
    };
    await event(minted);
    await expectPgError(
      event({ ...minted, tx_hash: ref() }),
      'chain_event_deployment_id_block_hash_log_index_key',
    );
    await expectPgError(
      event({ ...minted, log_index: 1, tx_hash: '0xAB' }),
      'chain_event_tx_hash_format',
    );
    await expectPgError(
      event({ ...minted, log_index: 1, to_address: '0xAB' }),
      'chain_event_to_format',
    );
    await expectPgError(event({ ...minted, log_index: 1, ref: '0x12' }), 'chain_event_ref_format');
    await expectPgError(
      event({ ...minted, log_index: 1, ref: null }),
      'chain_event_fields_match_kind',
    );
    await expectPgError(
      event({ ...minted, log_index: 1, from_address: alice.wallet }),
      'chain_event_fields_match_kind',
    );
    await expectPgError(
      event({ ...minted, log_index: 1, amount: '-1' }),
      'chain_event_amount_non_negative',
    );
    await expectPgError(
      event({
        ...base,
        log_index: 2,
        tx_hash: ref(),
        kind: 'VerificationSet',
        account: '0xABC',
        flag_value: true,
      }),
      'chain_event_account_format',
    );
    await expectPgError(
      event({
        ...base,
        log_index: 2,
        tx_hash: ref(),
        kind: 'Transfer',
        from_address: '0x1',
        to_address: alice.wallet,
        amount: '1',
      }),
      'chain_event_from_format',
    );
    await expectPgError(
      event({ ...minted, log_index: 3, block_hash: ref() }),
      'chain_event_deployment_id_block_number_block_hash_fkey',
    );
    // A uint256-sized amount is stored faithfully.
    await event({ ...minted, log_index: 4, amount: (2n ** 256n - 1n).toString() });
  });

  it('a reorg deleting a block removes its events (cascade), so no orphaned event survives', async () => {
    const h = await block(3000);
    await event({
      deployment_id: dep.id,
      block_number: 3000,
      block_hash: h,
      log_index: 0,
      tx_hash: ref(),
      kind: 'Burned',
      from_address: alice.wallet,
      amount: '1',
      ref: ref(),
    });
    await c.query(`DELETE FROM indexed_block WHERE deployment_id = $1 AND number >= 3000`, [
      dep.id,
    ]);
    const n = await c.query(`SELECT 1 FROM chain_event WHERE block_hash = $1`, [h]);
    expect(n.rowCount).toBe(0);
  });

  it('reconciliation runs store a mismatch array and a summary object; audit tx hash is CHECKed', async () => {
    await expectPgError(
      c.query(
        `INSERT INTO reconciliation_run (deployment_id, at_block, final_block, status, mismatches) VALUES ($1, 1, 1, 'ok', '{}')`,
        [dep.id],
      ),
      'reconciliation_mismatches_is_array',
    );
    await expectPgError(
      c.query(
        `INSERT INTO audit_log (entity, entity_id, to_state, tx_hash) VALUES ('operation', 'x', 'confirmed', '0xAB')`,
      ),
      'audit_log_tx_hash_format',
    );
  });
});
