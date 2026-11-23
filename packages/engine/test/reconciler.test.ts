/**
 * Piece C, the reconciler, on real Postgres with the FakeChainGateway. Every mismatch kind the
 * engine can meet is injected the way it happens in production (a rogue transfer, a rogue
 * registry change, a rogue mint, a forged confirmation, a stale index) and must be caught,
 * persisted and alarmed; a clean history must give ZERO mismatches; a run that cannot read
 * something is `unknown`, never clean; and the final block keeps a run stable through a reorg of
 * blocks that are not final yet. Checklist items 13, 15, 16.
 */

import { randomUUID } from 'node:crypto';

import type { Address } from '@bridge/chain';
import type { ComplianceChange } from '@bridge/db';

import {
  deriveExpectedCompliance,
  type KnownComplianceChange,
  moveOperation,
  observedEventOf,
  RECONCILIATION_ALARMS,
  type ReconciliationRunRecord,
} from '../src';
import { createTestDatabase, type TestDatabase } from './support/database';
import { insertUser, type TestUser } from './support/fixtures';
import { makeRig, opRow, ref32, type Rig, setOnChain, tickUntil } from './support/bridge';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

/** A rig whose ticks never reconcile on their own: each test calls `reconcileNow()`. */
function rigFor(
  extra: Parameters<typeof makeRig>[1] = {},
  chain: Parameters<typeof makeRig>[2] = {},
) {
  return makeRig(db.prisma, { reconcileEveryTicks: 1_000_000, ...extra }, chain);
}

function changeRow(id: string): Promise<ComplianceChange> {
  return db.prisma.complianceChange.findUniqueOrThrow({ where: { id } });
}

/** A user allowed on chain THROUGH THE BRIDGE, so the registry event is a known change. */
async function allowedUser(rig: Rig): Promise<TestUser> {
  const u = await insertUser(db.prisma);
  const { change } = await rig.engine.compliance.requestAllow({
    address: u.wallet,
    reason: 'kyc passed',
    idempotencyKey: randomUUID(),
    requestedBy: 'ops',
  });
  await tickUntil(
    rig.engine,
    async () => (await changeRow(change.id)).status === 'confirmed',
    10,
    () => {
      rig.chain.mine();
    },
  );
  expect((await changeRow(change.id)).status).toBe('confirmed');
  return u;
}

async function settled(rig: Rig, operationId: string): Promise<void> {
  await tickUntil(
    rig.engine,
    async () => (await opRow(db.prisma, operationId)).status === 'confirmed',
    10,
    () => {
      rig.chain.mine();
    },
  );
  expect((await opRow(db.prisma, operationId)).status).toBe('confirmed');
}

/** alice funded with `amount` through the bridge. */
async function funded(rig: Rig, amount: bigint): Promise<TestUser> {
  const u = await allowedUser(rig);
  const dep = await rig.engine.operations.requestDeposit(u.id, amount, randomUUID());
  await settled(rig, dep.operation.id);
  return u;
}

function kinds(run: ReconciliationRunRecord | null): string[] {
  return (run?.mismatches ?? []).map((m) => m.kind);
}

async function reconcile(rig: Rig): Promise<ReconciliationRunRecord> {
  const run = await rig.engine.reconciler.reconcileNow();
  if (run === null) throw new Error('no bound deployment');
  return run;
}

function wallet(u: TestUser): Address {
  return u.wallet as Address;
}

describe('a clean history reconciles with ZERO mismatches', () => {
  it('allow -> deposit -> transfer -> withdrawal: status ok, persisted, audited, no alarm', async () => {
    const rig = await rigFor({ confirmationDepth: 2 });
    const alice = await funded(rig, 1_000n);
    const bob = await allowedUser(rig);
    const tr = await rig.engine.operations.requestTransfer(alice.id, bob.id, 400n, randomUUID());
    await settled(rig, tr.operation.id);
    const wd = await rig.engine.operations.requestWithdrawal(bob.id, 150n, randomUUID());
    await settled(rig, wd.operation.id);

    const run = await reconcile(rig);
    expect(run.mismatches).toEqual([]);
    expect(run.status).toBe('ok');
    expect(run.error).toBeNull();
    const head = await rig.chain.getHeadBlock();
    expect(run.headBlock).toBe(head);
    expect(run.finalBlock).toBe(head - 1n);
    expect(run.atBlock).toBe(run.finalBlock);
    const [latest] = await rig.engine.reconciler.latestRuns(5);
    expect(latest?.id).toBe(run.id);
    const audit = await db.prisma.auditLog.findMany({
      where: { entity: 'reconciliation', entityId: run.id },
    });
    expect(audit.map((a) => a.toState)).toEqual(['ok']);
    for (const kind of [
      ...Object.values(RECONCILIATION_ALARMS),
      'reconciliation_unknown',
    ] as const) {
      expect(rig.alarms.ofKind(kind)).toHaveLength(0);
    }
    expect(rig.chain.balanceOf(wallet(alice))).toBe(600n);
    expect(rig.chain.balanceOf(wallet(bob))).toBe(250n);
  });

  it('runs on the tick cadence (reconcileEveryTicks) and not in between', async () => {
    const rig = await makeRig(db.prisma, { reconcileEveryTicks: 2 });
    expect((await rig.engine.tick()).reconciliation).toBeNull();
    const second = await rig.engine.tick();
    expect(second.reconciliation?.status).toBe('ok');
    expect((await rig.engine.tick()).reconciliation).toBeNull();
    expect(() => rig.makeEngine({ reconcileEveryTicks: 0 })).toThrow(/reconcileEveryTicks/);
  });
});

describe('each mismatch kind is caught, persisted and alarmed', () => {
  it('a rogue holder transfer (no bridge reference): unexplained_transfer and both balances', async () => {
    const rig = await rigFor();
    const alice = await funded(rig, 100n);
    const bob = await allowedUser(rig);
    rig.chain.setHolderTransfersEnabled(true);
    rig.chain.injectTransfer(wallet(alice), wallet(bob), 30n);
    await rig.engine.tick(); // indexed
    const run = await reconcile(rig);
    expect(run.status).toBe('mismatch');
    expect(kinds(run)).toEqual(['unexplained_transfer', 'balance_mismatch', 'balance_mismatch']);
    const balances = run.mismatches
      .filter((m) => m.kind === 'balance_mismatch')
      .map((m) => m.detail);
    expect(balances).toEqual(
      expect.arrayContaining([
        { kind: 'balance_mismatch', address: alice.wallet, expected: '100', observed: '70' },
        { kind: 'balance_mismatch', address: bob.wallet, expected: '0', observed: '30' },
      ]),
    );
    expect(rig.alarms.ofKind('reconciliation_unexplained_transfer')).toHaveLength(1);
    expect(rig.alarms.ofKind('reconciliation_balance_mismatch')).toHaveLength(1);
    // Persisted exactly: one row per mismatch, equal to the run's report.
    const rows = await db.prisma.reconciliationMismatch.findMany({
      where: { runId: run.id },
      orderBy: { ordinal: 'asc' },
    });
    expect(rows.map((r) => r.kind)).toEqual(kinds(run));
    const stored = await db.prisma.reconciliationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.mismatchCount).toBe(3);
    expect(stored.mismatches).toEqual(rows.map((r) => r.detail));
  });

  it('a rogue transfer to an OUTSIDER: its balance is read because it appears in a Transfer (checklist 16)', async () => {
    const rig = await rigFor();
    const alice = await funded(rig, 100n);
    const outsider = `0x${'5e'.repeat(20)}` as Address;
    await setOnChain(rig.chain, outsider, { verified: true }); // a rogue registry change too
    rig.chain.setHolderTransfersEnabled(true);
    rig.chain.injectTransfer(wallet(alice), outsider, 40n);
    await rig.engine.tick();
    const run = await reconcile(rig);
    const details = run.mismatches.map((m) => m.detail);
    expect(details).toContainEqual({
      kind: 'balance_mismatch',
      address: outsider,
      expected: '0',
      observed: '40',
    });
    expect(kinds(run)).toContain('unexplained_transfer');
    expect(kinds(run)).toContain('compliance_event_mismatch');
    expect(details).toContainEqual({
      kind: 'compliance_mismatch',
      address: outsider,
      expected: { verified: false, frozen: false },
      observed: { verified: true, frozen: false },
    });
  });

  it('a rogue registry freeze (unknown reference): compliance_event_mismatch and compliance_mismatch', async () => {
    const rig = await rigFor();
    const alice = await funded(rig, 10n);
    await setOnChain(rig.chain, alice.wallet, { frozen: true });
    await rig.engine.tick();
    const run = await reconcile(rig);
    expect(kinds(run)).toEqual(['compliance_event_mismatch', 'compliance_mismatch']);
    const [event, flags] = run.mismatches;
    expect(event?.detail).toMatchObject({
      why: 'unknown_reference',
      event: 'FrozenSet',
      expected: null,
    });
    expect(flags?.detail).toEqual({
      kind: 'compliance_mismatch',
      address: alice.wallet,
      expected: { verified: true, frozen: false },
      observed: { verified: true, frozen: true },
    });
    expect(rig.alarms.ofKind('reconciliation_compliance_event_mismatch')).toHaveLength(1);
    expect(rig.alarms.ofKind('reconciliation_compliance_mismatch')).toHaveLength(1);
  });

  it('a rogue mint by the minter key (unknown reference): unexpected event, balance and supply', async () => {
    const rig = await rigFor();
    const alice = await funded(rig, 10n);
    const { pending } = await rig.chain.getNonce('settlement');
    await rig.chain.submit({
      signer: 'settlement',
      call: { kind: 'mint', to: wallet(alice), amount: 5n, ref: ref32() },
      nonce: pending,
      fees: await rig.chain.estimateFees(),
    });
    await rig.engine.tick();
    const run = await reconcile(rig);
    expect(kinds(run)).toEqual(['unexpected_onchain_event', 'balance_mismatch', 'supply_mismatch']);
    expect(run.mismatches[0]?.detail).toMatchObject({ why: 'unknown_reference', event: 'Minted' });
    expect(run.mismatches[2]?.detail).toEqual({
      kind: 'supply_mismatch',
      expected: '10',
      observed: '15',
    });
    expect(rig.alarms.ofKind('reconciliation_supply_mismatch')).toHaveLength(1);
    expect(rig.alarms.ofKind('reconciliation_unexpected_onchain_event')).toHaveLength(1);
  });

  it('a confirmation the chain never made: missing_onchain (and the balance it claims)', async () => {
    const rig = await rigFor();
    const alice = await funded(rig, 10n);
    const forged = (await rig.engine.operations.requestDeposit(alice.id, 7n, randomUUID()))
      .operation;
    // Never dispatched; a buggy (or malicious) caller confirms it with a hand-made judgement.
    await db.prisma.$transaction(async (tx) => {
      const s = await moveOperation(tx, {
        operationId: forged.id,
        from: 'ledger_reserved',
        version: 0,
        move: { event: 'SUBMIT', kind: 'first' },
        at: rig.clock.now(),
        note: 'forged',
      });
      await moveOperation(tx, {
        operationId: forged.id,
        from: 'submitted',
        version: s.version,
        move: {
          event: 'CONFIRM',
          judgement: { verdict: 'confirm', event: 'CONFIRM' },
          confirmedBlock: 1n,
        },
        at: rig.clock.now(),
        note: 'forged',
      });
    });
    const run = await reconcile(rig);
    expect(kinds(run)).toEqual(['missing_onchain', 'balance_mismatch', 'supply_mismatch']);
    expect(run.mismatches[0]?.detail).toMatchObject({
      operationId: forged.id,
      expectedEvent: 'Minted',
      confirmedBlock: '1',
    });
    expect(rig.alarms.ofKind('reconciliation_missing_onchain')).toHaveLength(1);
  });

  it('a confirmation recorded at another block than its event: confirmed_block_mismatch', async () => {
    const rig = await rigFor();
    const alice = await funded(rig, 10n);
    const dep = (await rig.engine.operations.requestDeposit(alice.id, 3n, randomUUID())).operation;
    await rig.engine.dispatcher.runOnce(); // mined
    await rig.engine.indexer.runOnce(); // indexed
    const [event] = await db.prisma.chainEvent.findMany({ where: { ref: dep.ref } });
    const row = await opRow(db.prisma, dep.id);
    await db.prisma.$transaction((tx) =>
      moveOperation(tx, {
        operationId: dep.id,
        from: 'submitted',
        version: row.version,
        move: {
          event: 'CONFIRM',
          judgement: { verdict: 'confirm', event: 'CONFIRM' },
          confirmedBlock: (event?.blockNumber ?? 2n) - 1n,
        },
        at: rig.clock.now(),
        note: 'wrong block',
      }),
    );
    const run = await reconcile(rig);
    expect(kinds(run)).toEqual(['confirmed_block_mismatch']);
    expect(run.mismatches[0]?.detail).toMatchObject({
      operationId: dep.id,
      observed: String(event?.blockNumber),
    });
    expect(rig.alarms.ofKind('reconciliation_confirmed_block_mismatch')).toHaveLength(1);
  });

  it("the bridge's latest confirmed decision disagrees with the registry: compliance_mismatch, no event mismatch", async () => {
    const rig = await rigFor();
    const alice = await funded(rig, 10n);
    rig.clock.advance(1_000); // a later decision than the allow
    const { change } = await rig.engine.compliance.requestDisallow({
      address: alice.wallet,
      reason: 'kyc expired',
      idempotencyKey: randomUUID(),
      requestedBy: 'ops',
    });
    // Recorded as confirmed (a forged or mistaken DB write) although nothing was ever sent.
    await db.prisma.complianceChange.update({
      where: { id: change.id },
      data: { status: 'submitted', version: 1 },
    });
    await db.prisma.complianceChange.update({
      where: { id: change.id },
      data: { status: 'confirmed', version: 2, confirmedBlock: 1n },
    });
    const run = await reconcile(rig);
    expect(kinds(run)).toEqual(['compliance_mismatch']);
    expect(run.mismatches[0]?.detail).toEqual({
      kind: 'compliance_mismatch',
      address: alice.wallet,
      expected: { verified: false, frozen: false },
      observed: { verified: true, frozen: false },
    });
  });

  it('a stale index (an orphaned settlement still stored): stale_block from the NODE hashes, and the confirmed op is missing', async () => {
    const rig = await rigFor();
    const alice = await funded(rig, 10n);
    // The block holding the mint is replaced and its transaction forgotten; the indexer has not
    // run since, so the index still holds the orphaned event at a height that is final.
    rig.chain.reorg({ depth: 1, dropTransactions: true });
    const run = await reconcile(rig);
    expect(kinds(run)).toEqual(
      expect.arrayContaining(['missing_onchain', 'unexpected_onchain_event', 'balance_mismatch']),
    );
    expect(run.mismatches.map((m) => m.detail)).toContainEqual(
      expect.objectContaining({
        kind: 'unexpected_onchain_event',
        why: 'stale_block',
        event: 'Minted',
      }),
    );
    expect(rig.chain.balanceOf(wallet(alice))).toBe(0n);
  });
});

describe('final block, reorgs and unknown runs (never a clean pass on bad reads)', () => {
  it('a reorg of NOT-final blocks leaves the run stable: same final block, still clean', async () => {
    const rig = await rigFor({ confirmationDepth: 3 });
    const alice = await funded(rig, 10n);
    const dep = (await rig.engine.operations.requestDeposit(alice.id, 4n, randomUUID())).operation;
    const freeze = await rig.engine.compliance.requestFreeze({
      address: alice.wallet,
      reason: 'review',
      idempotencyKey: randomUUID(),
      requestedBy: 'ops',
    });
    await rig.engine.tick(); // both mined in the newest blocks, not final: submitted
    expect((await opRow(db.prisma, dep.id)).status).toBe('submitted');
    expect((await changeRow(freeze.change.id)).status).toBe('submitted');
    // At the head alice is frozen and holds 14; at the final block she is neither.
    expect(rig.chain.complianceOf(wallet(alice)).frozen).toBe(true);
    const before = await reconcile(rig);
    expect(before.status).toBe('ok');
    rig.chain.reorg({ depth: 1 });
    const during = await reconcile(rig);
    expect(during.status).toBe('ok');
    expect(during.finalBlock).toBe(before.finalBlock);
    expect(during.finalBlock).toBe((await rig.chain.getHeadBlock()) - 2n);
    await rig.engine.tick();
    const after = await reconcile(rig);
    expect(after.status).toBe('ok');
  });

  it('a node read error: unknown run, redacted reason, alarm, no mismatches', async () => {
    const rig = await rigFor({ secrets: ['https://rpc.example/key-123'] });
    await funded(rig, 10n);
    rig.chain.setUnavailable(true);
    const run = await reconcile(rig);
    rig.chain.setUnavailable(false);
    expect(run.status).toBe('unknown');
    expect(run.error).toMatch(/^read_failed: ChainUnavailableError/);
    expect(run.mismatches).toEqual([]);
    expect(run.atBlock).toBeNull();
    expect(rig.alarms.ofKind('reconciliation_unknown')).toHaveLength(1);
  });

  it('a read error AFTER the head (a balance read): unknown, never a partial clean pass', async () => {
    const rig = await rigFor();
    const alice = await funded(rig, 10n);
    const original = rig.chain.readBalance.bind(rig.chain);
    rig.chain.readBalance = async (holder, block) => {
      if (holder === wallet(alice)) throw new Error('read https://rpc.example/key-123 failed');
      return original(holder, block);
    };
    const run = await reconcile(rig);
    rig.chain.readBalance = original;
    expect(run.status).toBe('unknown');
    expect(run.finalBlock).not.toBeNull();
    expect(run.error).not.toContain('key-123');
    const compliance = rig.chain.readCompliance.bind(rig.chain);
    rig.chain.readCompliance = async () => {
      throw new Error('flags unavailable');
    };
    expect((await reconcile(rig)).status).toBe('unknown');
    rig.chain.readCompliance = compliance;
    expect((await reconcile(rig)).status).toBe('ok');
  });

  it('an index behind the final block, a ledger behind the chain, a node missing a block: unknown', async () => {
    const rig = await rigFor();
    const alice = await funded(rig, 10n);
    rig.chain.mine(3); // the indexer has not seen these
    const behind = await reconcile(rig);
    expect(behind.status).toBe('unknown');
    expect(behind.error).toMatch(/^index_behind/);
    await rig.engine.tick();

    const dep = (await rig.engine.operations.requestDeposit(alice.id, 2n, randomUUID())).operation;
    await rig.engine.dispatcher.runOnce();
    await rig.engine.indexer.runOnce(); // final on chain, the monitor has not confirmed it yet
    const lagging = await reconcile(rig);
    expect(lagging.status).toBe('unknown');
    expect(lagging.error).toMatch(/^ledger_behind_chain/);
    await rig.engine.tick();
    expect((await opRow(db.prisma, dep.id)).status).toBe('confirmed');

    const getBlock = rig.chain.getBlock.bind(rig.chain);
    rig.chain.getBlock = async () => null;
    const missing = await reconcile(rig);
    rig.chain.getBlock = getBlock;
    expect(missing.error).toMatch(/^node_inconsistent/);
    expect((await reconcile(rig)).status).toBe('ok');
  });

  it('latestRuns lists the newest first and refuses a silly limit; no row, no run', async () => {
    const rig = await rigFor();
    const a = await reconcile(rig);
    rig.clock.advance(1_000);
    const b = await reconcile(rig);
    expect((await rig.engine.reconciler.latestRuns(2)).map((r) => r.id)).toEqual([b.id, a.id]);
    await expect(rig.engine.reconciler.latestRuns(0)).rejects.toThrow(RangeError);
    await expect(rig.engine.reconciler.latestRuns(101)).rejects.toThrow(RangeError);
  });
});

describe('deriveExpectedCompliance (checklist 13, pure)', () => {
  const A = `0x${'aa'.repeat(20)}` as Address;
  const pos = (blockNumber: bigint, logIndex: number) => ({
    blockNumber,
    blockHash: `0x${'11'.repeat(32)}` as `0x${string}`,
    txHash: `0x${'22'.repeat(32)}` as `0x${string}`,
    logIndex,
  });
  const freezeRef = `0x${'01'.repeat(32)}` as `0x${string}`;
  const unfreezeRef = `0x${'02'.repeat(32)}` as `0x${string}`;
  const freeze: KnownComplianceChange = {
    content: { ref: freezeRef, account: A, flag: 'frozen', value: true },
    status: 'confirmed',
    createdAt: new Date(1_000),
    id: 'a',
  };
  const unfreeze: KnownComplianceChange = {
    content: { ref: unfreezeRef, account: A, flag: 'frozen', value: false },
    status: 'confirmed',
    createdAt: new Date(2_000),
    id: 'b',
  };

  it('chain order decides, never the order of the changes (confirmation order) in the input', () => {
    const events = [
      { ...pos(10n, 0), kind: 'FrozenSet' as const, account: A, frozen: true, ref: freezeRef },
      { ...pos(12n, 0), kind: 'FrozenSet' as const, account: A, frozen: false, ref: unfreezeRef },
    ];
    // DB confirmation order reversed: unfreeze recorded first, freeze late.
    const out = deriveExpectedCompliance({ addresses: [A], events, changes: [unfreeze, freeze] });
    expect(out.get(A)).toEqual({ verified: false, frozen: false });
  });

  it('an OLD change landing late: the chain holds it, the latest decision disagrees -> expected follows the decision (a finding)', () => {
    const events = [
      { ...pos(10n, 0), kind: 'FrozenSet' as const, account: A, frozen: false, ref: unfreezeRef },
      { ...pos(12n, 3), kind: 'FrozenSet' as const, account: A, frozen: true, ref: freezeRef },
    ];
    // DB confirmation order: unfreeze, then the late freeze. Applying THAT order would say frozen.
    const out = deriveExpectedCompliance({ addresses: [A], events, changes: [unfreeze, freeze] });
    expect(out.get(A)).toEqual({ verified: false, frozen: false });
  });

  it('a rogue event never moves an expectation; an in-flight latest decision does not override the chain', () => {
    const events = [
      { ...pos(10n, 0), kind: 'FrozenSet' as const, account: A, frozen: true, ref: freezeRef },
      { ...pos(11n, 0), kind: 'FrozenSet' as const, account: A, frozen: false, ref: ref32() },
      {
        ...pos(11n, 1),
        kind: 'VerificationSet' as const,
        account: A,
        verified: true,
        ref: freezeRef,
      },
    ];
    const pending: KnownComplianceChange = { ...unfreeze, status: 'submitted' };
    const out = deriveExpectedCompliance({ addresses: [], events, changes: [freeze, pending] });
    expect(out.get(A)).toEqual({ verified: false, frozen: true });
  });

  it('events are applied in chain order whatever order they arrive in (latest decision still in flight)', () => {
    const events = [
      { ...pos(12n, 0), kind: 'FrozenSet' as const, account: A, frozen: false, ref: unfreezeRef },
      { ...pos(10n, 5), kind: 'FrozenSet' as const, account: A, frozen: true, ref: freezeRef },
    ];
    const inFlight: KnownComplianceChange = { ...unfreeze, status: 'submitted' };
    const out = deriveExpectedCompliance({ addresses: [A], events, changes: [freeze, inFlight] });
    expect(out.get(A)).toEqual({ verified: false, frozen: false });
  });

  it('observedEventOf refuses an indexed row missing a field', () => {
    expect(() =>
      observedEventOf({
        id: 'x',
        deploymentId: 'd',
        blockNumber: 1n,
        blockHash: '0x',
        txHash: '0x',
        logIndex: 0,
        kind: 'Minted',
        fromAddress: null,
        toAddress: null,
        account: null,
        amount: null,
        ref: null,
        flagValue: null,
      }),
    ).toThrow(/no to|no amount|no ref/);
  });
});
