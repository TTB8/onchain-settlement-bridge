/**
 * End to end through the public HTTP API, every part real: Postgres (a fresh database for this
 * file), a native anvil (this file's own, on a free port), the contracts deployed and promoted by
 * `setup:local` (forge script + promote-deployment.sh), the API from `startApi`, and the engine
 * built as the worker builds it (real `ViemChainGateway` + `ViemTransactionInspector`), ticked by
 * the test with bounded loops.
 *
 * The scenarios share one chain and run in order (each leaves the ledger clean for the next);
 * the rogue mint and the stopped node come last because they leave the chain dirty and dead.
 *
 * DEV ONLY: Anvil's public dev accounts; the only keys are the two labelled ones in .env.example.
 */

import { calldata, SELECTORS } from '../../scripts/lib/rpc';
import { DEV_ROLE_ADDRESSES } from '../../scripts/lib/local-env';
import { ALICE, BOB, call, type JsonResponse, type Stack, startStack } from './support/stack';

let s: Stack;

beforeAll(async () => {
  s = await startStack();
}, 300_000);

afterAll(async () => {
  await s?.close();
});

const platform = (method: 'GET' | 'POST', path: string, body?: unknown, key?: string) =>
  call(s.apiUrl, s.env.API_PLATFORM_TOKEN, method, path, {
    body,
    headers: key !== undefined ? { 'idempotency-key': key } : {},
  });
const admin = (method: 'GET' | 'POST', path: string, body?: unknown, key?: string) =>
  call(s.apiUrl, s.env.API_ADMIN_TOKEN, method, path, {
    body,
    headers: key !== undefined ? { 'idempotency-key': key } : {},
  });

const token = () => s.setup.token;
/** `isVerified(address)` on the registry. */
const IS_VERIFIED = '0xb9209e33';
const users: Record<'alice' | 'bob', { id: string; walletAddress: string }> = {} as never;

/** Ticks until the operation reaches a final status; returns its view. */
async function settled(operationId: string): Promise<JsonResponse['body']> {
  let view: JsonResponse['body'] = null;
  await s.tickUntil(async () => {
    view = (await platform('GET', `/v1/operations/${operationId}`)).body;
    return ['confirmed', 'reversed'].includes(view.status);
  }, `operation ${operationId}`);
  return view;
}

/** Ticks until a compliance change is confirmed. */
async function complianceConfirmed(changeId: string): Promise<void> {
  await s.tickUntil(
    async () =>
      (await admin('GET', `/v1/admin/compliance-changes/${changeId}`)).body.status === 'confirmed',
    `compliance change ${changeId}`,
  );
}

/** For each user: the ledger's expectedOnChain equals the token balance, nothing pending. */
async function expectLedgerEqualsChain(): Promise<Record<string, bigint>> {
  const out: Record<string, bigint> = {};
  for (const [name, u] of Object.entries(users)) {
    const b = (await platform('GET', `/v1/users/${u.id}/balances`)).body;
    const onChain = await s.rpc.balanceOf(token(), u.walletAddress);
    expect({ name, ledger: BigInt(b.expectedOnChain), held: b.held, incoming: b.incoming }).toEqual(
      { name, ledger: onChain, held: '0', incoming: '0' },
    );
    out[name] = onChain;
  }
  return out;
}

/** One reconciliation through the admin route, after the index caught up with the head. */
async function reconcile(): Promise<JsonResponse['body']> {
  await s.engine.tick(); // index up to the head (depth 1: the head is final)
  const res = await admin('POST', '/v1/admin/reconciliations');
  expect(res.status).toBe(200);
  return res.body;
}

/** The settlement signer's transaction count (every chain tx the bridge sends for operations). */
const settlementNonce = async () =>
  BigInt(
    await s.rpc.call<string>('eth_getTransactionCount', [DEV_ROLE_ADDRESSES.settlement, 'latest']),
  );

describe('the bridge end to end on a real chain', () => {
  it('scenario 1: users allowed, deposit -> transfer -> withdrawal; ledger == chain at every step; tx hashes; CLEAN reconciliation', async () => {
    for (const [name, wallet] of [
      ['alice', ALICE],
      ['bob', BOB],
    ] as const) {
      const res = await platform('POST', '/v1/users', { walletAddress: wallet });
      expect(res.status).toBe(201);
      users[name] = res.body;
      const change = await admin(
        'POST',
        '/v1/admin/compliance-changes',
        { action: 'allow', walletAddress: wallet, reason: 'e2e kyc passed' },
        `allow-${wallet}`,
      );
      expect(change.status).toBe(201);
      await complianceConfirmed(change.body.id);
      const verified = await s.rpc.ethCall(s.setup.registry, calldata(IS_VERIFIED, wallet));
      expect(BigInt(verified)).toBe(1n);
    }
    await expectLedgerEqualsChain();

    const steps: [string, () => Promise<JsonResponse>, Record<string, bigint>][] = [
      [
        'deposit 1.0 to alice',
        () =>
          platform('POST', `/v1/users/${users.alice.id}/deposits`, { amount: '1000000' }, 'dep-1'),
        { alice: 1_000_000n, bob: 0n },
      ],
      [
        'transfer 0.4 alice -> bob',
        () =>
          platform(
            'POST',
            `/v1/users/${users.alice.id}/transfers`,
            { amount: '400000', toUserId: users.bob.id },
            'tr-1',
          ),
        { alice: 600_000n, bob: 400_000n },
      ],
      [
        'withdrawal 0.15 by bob',
        () =>
          platform('POST', `/v1/users/${users.bob.id}/withdrawals`, { amount: '150000' }, 'wd-1'),
        { alice: 600_000n, bob: 250_000n },
      ],
    ];
    for (const [what, request, expected] of steps) {
      const res = await request();
      expect({ what, status: res.status }).toEqual({ what, status: 201 });
      const view = await settled(res.body.id);
      expect({ what, status: view.status }).toEqual({ what, status: 'confirmed' });
      expect(view.transactions).toHaveLength(1);
      const tx = view.transactions[0];
      expect(tx.hash).toMatch(/^0x[0-9a-f]{64}$/);
      const receipt = await s.rpc.call<{ status: string; to: string; blockNumber: string }>(
        'eth_getTransactionReceipt',
        [tx.hash],
      );
      expect(receipt.status).toBe('0x1');
      expect(receipt.to.toLowerCase()).toBe(token());
      // The confirming transaction is recorded as mined, at the receipt's block = confirmedBlock.
      expect(tx).toMatchObject({ status: 'mined', blockNumber: view.confirmedBlock });
      expect(BigInt(receipt.blockNumber).toString()).toBe(view.confirmedBlock);
      expect(await expectLedgerEqualsChain()).toEqual(expected);
    }

    const run = await reconcile();
    expect(run).toMatchObject({
      status: 'ok',
      clean: true,
      mismatchCount: 0,
      mismatches: [],
      error: null,
      deploymentId: s.setup.deploymentId,
    });
  });

  it('scenario 3: a replayed deposit (same Idempotency-Key) is one operation and one chain transaction', async () => {
    const nonceBefore = await settlementNonce();
    const body = { amount: '50000' };
    const first = await platform(
      'POST',
      `/v1/users/${users.alice.id}/deposits`,
      body,
      'dep-replay',
    );
    expect(first.status).toBe(201);
    // Concurrent and sequential copies: every one answers the same operation, none writes.
    const copies = await Promise.all(
      Array.from({ length: 4 }, () =>
        platform('POST', `/v1/users/${users.alice.id}/deposits`, body, 'dep-replay'),
      ),
    );
    for (const c of copies) {
      expect(c.status).toBe(200);
      expect(c.headers.get('idempotent-replayed')).toBe('true');
      expect(c.body.id).toBe(first.body.id);
    }
    const view = await settled(first.body.id);
    expect(view.status).toBe('confirmed');
    const late = await platform('POST', `/v1/users/${users.alice.id}/deposits`, body, 'dep-replay');
    expect(late.status).toBe(200);
    expect(late.body.id).toBe(first.body.id);
    await s.tickUntil(async () => true, 'one more pass');

    expect(
      await s.prisma.operation.count({
        where: { userId: users.alice.id, idempotencyKey: 'dep-replay' },
      }),
    ).toBe(1);
    expect(
      await s.prisma.chainAttempt.count({ where: { outbox: { operationId: first.body.id } } }),
    ).toBe(1);
    expect(view.transactions).toHaveLength(1);
    expect((await settlementNonce()) - nonceBefore).toBe(1n);
    expect(await expectLedgerEqualsChain()).toEqual({ alice: 650_000n, bob: 250_000n });
  });

  it('scenario 4: insufficient funds is 422, nothing is written and nothing is sent', async () => {
    const nonceBefore = await settlementNonce();
    const opsBefore = await s.prisma.operation.count();
    const outboxBefore = await s.prisma.outboxMessage.count();
    const res = await platform(
      'POST',
      `/v1/users/${users.bob.id}/withdrawals`,
      { amount: '250001' },
      'wd-too-much',
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INSUFFICIENT_FUNDS');
    const tr = await platform(
      'POST',
      `/v1/users/${users.bob.id}/transfers`,
      { amount: '9999999', toUserId: users.alice.id },
      'tr-too-much',
    );
    expect(tr.status).toBe(422);
    for (let i = 0; i < 3; i += 1) await s.engine.tick();
    expect(await s.prisma.operation.count()).toBe(opsBefore);
    expect(await s.prisma.outboxMessage.count()).toBe(outboxBefore);
    expect(await settlementNonce()).toBe(nonceBefore);
    expect(await expectLedgerEqualsChain()).toEqual({ alice: 650_000n, bob: 250_000n });
  });

  it("scenario 5: a frozen user's transfer reverts on chain, ends reversed with the funds released, and reconciliation stays clean", async () => {
    const freeze = await admin(
      'POST',
      '/v1/admin/compliance-changes',
      { action: 'freeze', walletAddress: ALICE, reason: 'e2e freeze' },
      'freeze-alice',
    );
    expect(freeze.status).toBe(201);
    await complianceConfirmed(freeze.body.id);

    const tr = await platform(
      'POST',
      `/v1/users/${users.alice.id}/transfers`,
      { amount: '100000', toUserId: users.bob.id },
      'tr-frozen',
    );
    expect(tr.status).toBe(201);
    const reserved = (await platform('GET', `/v1/users/${users.alice.id}/balances`)).body;
    expect(reserved).toMatchObject({ available: '550000', held: '100000' });

    const view = await settled(tr.body.id);
    expect(view.status).toBe('reversed');
    expect(view.failureReason).not.toBeNull();
    expect(view.transactions.length).toBeGreaterThanOrEqual(1);
    const receipt = await s.rpc.call<{ status: string }>('eth_getTransactionReceipt', [
      view.transactions[0].hash,
    ]);
    expect(receipt.status).toBe('0x0'); // the registry refused it on chain
    // A transaction that did not settle the operation is never shown as mined.
    for (const t of view.transactions) {
      expect(t.status).not.toBe('mined');
      expect(t.blockNumber).toBeNull();
    }
    const released = (await platform('GET', `/v1/users/${users.alice.id}/balances`)).body;
    expect(released).toMatchObject({ available: '650000', held: '0', expectedOnChain: '650000' });
    expect(await expectLedgerEqualsChain()).toEqual({ alice: 650_000n, bob: 250_000n });

    const run = await reconcile();
    expect(run).toMatchObject({ status: 'ok', clean: true, mismatchCount: 0 });

    const unfreeze = await admin(
      'POST',
      '/v1/admin/compliance-changes',
      { action: 'unfreeze', walletAddress: ALICE, reason: 'e2e unfreeze' },
      'unfreeze-alice',
    );
    await complianceConfirmed(unfreeze.body.id);
  });

  it('scenario 2: a rogue mint outside the bridge is reported by the reconciliation endpoint', async () => {
    const rogue = await s.rpc.sendUnlocked({
      from: DEV_ROLE_ADDRESSES.settlement, // the dev minter, outside the bridge
      to: token(),
      data: calldata(SELECTORS.mint, ALICE, 7_000n, `0x${'ee'.repeat(32)}`),
    });
    expect(rogue.success).toBe(true);
    expect(await s.rpc.balanceOf(token(), ALICE)).toBe(657_000n);

    const run = await reconcile();
    expect(run.status).toBe('mismatch');
    expect(run.clean).toBe(false);
    const kinds = run.mismatches.map((m: { kind: string }) => m.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['unexpected_onchain_event', 'balance_mismatch', 'supply_mismatch']),
    );
    expect(run.mismatchCount).toBe(kinds.length);
    expect(run.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'balance_mismatch',
          detail: expect.objectContaining({
            address: ALICE,
            expected: '650000',
            observed: '657000',
          }),
        }),
      ]),
    );
    const listed = await admin('GET', '/v1/admin/reconciliations?limit=1');
    expect(listed.body[0].id).toBe(run.id);
  });

  it('scenario 6: with the node stopped, reconciliation is unknown (never ok) and /ready is 503', async () => {
    await s.node.stop();
    const res = await admin('POST', '/v1/admin/reconciliations');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('unknown');
    expect(res.body.clean).toBe(false);
    expect(res.body.error).toMatch(/^read_failed/);
    expect(res.body.error).not.toMatch(/https?:\/\//);
    // /ready caches for 2 s: wait it out (bounded) until it reports the node.
    const deadline = Date.now() + 10_000;
    let ready: JsonResponse;
    do {
      ready = await call(s.apiUrl, undefined, 'GET', '/ready');
      if (ready.status === 503) break;
      await new Promise((r) => setTimeout(r, 250));
    } while (Date.now() < deadline);
    expect(ready.status).toBe(503);
    expect(ready.body.checks.node).toBe('fail');
    // Nothing secret reached a response or a log line.
    for (const line of s.apiLogs) {
      expect(line).not.toContain(s.env.API_ADMIN_TOKEN);
      expect(line).not.toContain(s.env.API_PLATFORM_TOKEN);
      expect(line).not.toContain(s.env.RPC_URL);
    }
  });
});
