/**
 * The indexer on real Postgres with the FakeChainGateway: one row per scanned block with its
 * canonical hash, idempotent re-scans (unique on block hash + log index), the unfinal tail
 * re-scanned, reorg rollback in one transaction, `nodeBehind` (no rollback, no advance, obligation
 * 14), a reorg beyond the window (halt + alarm), and a chain that moves during a pass.
 */

import { randomUUID } from 'node:crypto';

import type { BlockRef, ChainGateway } from '@bridge/chain';

import { AlarmLog, Indexer, type IndexerPolicy } from '../src';
import { createTestDatabase, type TestDatabase } from './support/database';
import { insertUser } from './support/fixtures';
import { makeRig, type Rig, setOnChain } from './support/bridge';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

/** The fake, with `getBlock` (and optionally `getEvents`) overridable per test. */
function wrap(
  rig: Rig,
  overrides: Partial<Pick<ChainGateway, 'getBlock' | 'getEvents'>>,
): ChainGateway {
  return new Proxy(rig.chain, {
    get(target, prop, receiver) {
      if (prop === 'getBlock' && overrides.getBlock) return overrides.getBlock;
      if (prop === 'getEvents' && overrides.getEvents) return overrides.getEvents;
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

function indexerFor(
  rig: Rig,
  gateway: ChainGateway = rig.chain,
  policy: IndexerPolicy = { confirmationDepth: 2, maxBatch: 50, reorgWindow: 8 },
): Indexer {
  return new Indexer({
    prisma: db.prisma,
    gateway,
    clock: rig.clock,
    binding: { chainId: BigInt(rig.chain.chainId), tokenAddress: rig.chain.tokenAddress },
    policy,
    alarms: rig.alarms,
  });
}

async function state(rig: Rig) {
  const s = await db.prisma.indexerState.findUnique({ where: { deploymentId: rig.deploymentId } });
  const blocks = await db.prisma.indexedBlock.findMany({
    where: { deploymentId: rig.deploymentId },
    orderBy: { number: 'asc' },
  });
  const events = await db.prisma.chainEvent.findMany({
    where: { deploymentId: rig.deploymentId },
  });
  return { last: s?.lastIndexedBlock ?? null, blocks, events };
}

/** A rig with a few blocks and a confirmed deposit (Minted + Transfer events). */
async function busyRig(): Promise<Rig> {
  const rig = await makeRig(db.prisma, { confirmationDepth: 2 });
  const u = await insertUser(db.prisma);
  await setOnChain(rig.chain, u.wallet, { verified: true });
  await rig.engine.operations.requestDeposit(u.id, 5n, randomUUID());
  await rig.engine.dispatcher.runOnce();
  rig.chain.mine(3);
  return rig;
}

describe('scanning', () => {
  it('records every scanned block with its node hash, the events bound to block hash and reference, and is idempotent', async () => {
    const rig = await busyRig();
    const ix = indexerFor(rig);
    const r = await ix.runOnce();
    const head = await rig.chain.getHeadBlock();
    expect(r).toEqual({
      status: 'scanned',
      fromBlock: 0n,
      toBlock: head,
      events: expect.any(Number),
    });
    const s = await state(rig);
    expect(s.last).toBe(head);
    expect(s.blocks.map((b) => b.number)).toEqual(
      Array.from({ length: Number(head) + 1 }, (_, i) => BigInt(i)),
    );
    for (const b of s.blocks) {
      expect(b.hash).toBe((await rig.chain.getBlock(b.number))?.hash);
    }
    const minted = s.events.filter((e) => e.kind === 'Minted');
    expect(minted).toHaveLength(1);
    expect(minted[0]?.ref).toMatch(/^0x0{32}/);
    expect(s.events.some((e) => e.kind === 'VerificationSet')).toBe(true);
    expect(s.events.some((e) => e.kind === 'Transfer')).toBe(true);

    // Re-scan: the unfinal tail is read again, nothing is duplicated.
    const again = await ix.runOnce();
    expect(again.status).toBe('scanned');
    if (again.status === 'scanned') expect(again.fromBlock).toBe(head);
    expect((await state(rig)).events).toHaveLength(s.events.length);
    expect((await state(rig)).blocks).toHaveLength(s.blocks.length);
  });

  it('re-scanning a block that holds events writes no duplicate (unique block hash + log index)', async () => {
    const rig = await makeRig(db.prisma, { confirmationDepth: 2 });
    const u = await insertUser(db.prisma);
    await setOnChain(rig.chain, u.wallet, { verified: true });
    await rig.engine.operations.requestDeposit(u.id, 5n, randomUUID());
    await rig.engine.dispatcher.runOnce(); // the head block now holds Minted + Transfer
    const ix = indexerFor(rig);
    await ix.runOnce();
    const n = (await state(rig)).events.length;
    const again = await ix.runOnce(); // the unfinal tail (the head block) is read again
    expect(again).toMatchObject({ status: 'scanned', toBlock: await rig.chain.getHeadBlock() });
    if (again.status === 'scanned') expect(again.events).toBeGreaterThan(0);
    expect((await state(rig)).events).toHaveLength(n);
  });

  it('scans in batches and never past the head', async () => {
    const rig = await busyRig();
    const ix = indexerFor(rig, rig.chain, { confirmationDepth: 2, maxBatch: 2, reorgWindow: 4 });
    const first = await ix.runOnce();
    expect(first).toMatchObject({ status: 'scanned', fromBlock: 0n, toBlock: 1n });
    const head = await rig.chain.getHeadBlock();
    for (let i = 0; i < 10; i += 1) await ix.runOnce();
    expect((await state(rig)).last).toBe(head);
  });

  it('nothing to do: idle', async () => {
    const rig = await makeRig(db.prisma, { confirmationDepth: 1 });
    const ix = indexerFor(rig, rig.chain, { confirmationDepth: 1, maxBatch: 5, reorgWindow: 4 });
    await ix.runOnce();
    expect(await ix.runOnce()).toEqual({ status: 'idle', lastIndexed: 0n });
  });

  it('no deployment row for the binding: unknown, nothing written', async () => {
    const rig = await makeRig(db.prisma);
    const ix = new Indexer({
      prisma: db.prisma,
      gateway: rig.chain,
      clock: rig.clock,
      binding: { chainId: 1n, tokenAddress: rig.chain.tokenAddress },
      policy: { confirmationDepth: 1, maxBatch: 5, reorgWindow: 4 },
      alarms: new AlarmLog(),
    });
    expect(await ix.runOnce()).toEqual({ status: 'unknown' });
  });

  it('the node on another chain id: unknown', async () => {
    const rig = await makeRig(db.prisma);
    const original = rig.chain.getChainId.bind(rig.chain);
    rig.chain.getChainId = async () => 1;
    expect(await indexerFor(rig).runOnce()).toEqual({ status: 'unknown' });
    rig.chain.getChainId = original;
  });
});

describe('reorgs (obligation 14)', () => {
  it('a reorg rolls back the orphaned blocks and their events and rewinds the cursor, in one transaction with an audit row', async () => {
    const rig = await busyRig();
    // The two newest blocks: one with a VerificationSet event, one empty.
    await setOnChain(rig.chain, (await insertUser(db.prisma)).wallet, { verified: true });
    const ix = indexerFor(rig);
    await ix.runOnce();
    const before = await state(rig);
    const head = await rig.chain.getHeadBlock();
    rig.chain.reorg({ depth: 2 });
    const r = await ix.runOnce();
    expect(r).toEqual({ status: 'rolled_back', forkPoint: head - 2n, removed: 2 });
    const after = await state(rig);
    expect(after.last).toBe(head - 2n);
    expect(after.blocks.map((b) => b.number)).toEqual(
      before.blocks.filter((b) => b.number <= head - 2n).map((b) => b.number),
    );
    expect(after.events.every((e) => e.blockNumber <= head - 2n)).toBe(true);
    const audit = await db.prisma.auditLog.findMany({
      where: { entity: 'indexer', entityId: rig.deploymentId },
    });
    expect(audit).toHaveLength(1);
    // Every deleted event is listed: txHash, logIndex, kind, ref, amount.
    const orphaned = before.events.filter((e) => e.blockNumber > head - 2n);
    expect(orphaned.length).toBeGreaterThan(0);
    const detail = audit[0]?.detail as { deletedEvents: string; removedEvents: number };
    expect(detail.removedEvents).toBe(orphaned.length);
    const listed = JSON.parse(detail.deletedEvents) as {
      txHash: string;
      logIndex: number;
      kind: string;
      ref: string | null;
      amount: string | null;
    }[];
    expect(listed.map((e) => `${e.txHash}:${e.logIndex}`).sort()).toEqual(
      orphaned.map((e) => `${e.txHash}:${e.logIndex}`).sort(),
    );
    const minted = orphaned.find((e) => e.kind === 'Minted');
    if (minted !== undefined) {
      expect(listed).toContainEqual(
        expect.objectContaining({
          kind: 'Minted',
          ref: minted.ref,
          amount: minted.amount?.toFixed(),
        }),
      );
    }
    // The next pass re-reads the new branch, with the node's new hashes.
    await ix.runOnce();
    for (const b of (await state(rig)).blocks) {
      expect(b.hash).toBe((await rig.chain.getBlock(b.number))?.hash);
    }
  });

  it('nodeBehind: a node missing stored blocks causes neither a rollback nor an advance', async () => {
    const rig = await busyRig();
    await indexerFor(rig).runOnce();
    const before = await state(rig);
    const limit = (before.last ?? 0n) - 2n;
    const lagging = wrap(rig, {
      getBlock: async (n: bigint): Promise<BlockRef | null> =>
        n > limit ? null : rig.chain.getBlock(n),
    });
    rig.chain.mine(3);
    const r = await indexerFor(rig, lagging).runOnce();
    expect(r).toEqual({ status: 'node_behind' });
    expect(await state(rig)).toEqual(before);
  });

  it('a block of the new range missing on the node: node_behind, nothing written', async () => {
    const rig = await busyRig();
    await indexerFor(rig).runOnce();
    const before = await state(rig);
    rig.chain.mine(3);
    const head = await rig.chain.getHeadBlock();
    const lagging = wrap(rig, {
      getBlock: async (n: bigint) => (n === head ? null : rig.chain.getBlock(n)),
    });
    expect(await indexerFor(rig, lagging).runOnce()).toEqual({ status: 'node_behind' });
    expect(await state(rig)).toEqual(before);
  });

  it('a reorg deeper than the window halts the indexer and raises reorg_beyond_window; it stays halted', async () => {
    const rig = await busyRig();
    const ix = indexerFor(rig, rig.chain, { confirmationDepth: 2, maxBatch: 50, reorgWindow: 2 });
    await ix.runOnce();
    const before = await state(rig);
    rig.chain.reorg({ depth: 4 });
    expect(await ix.runOnce()).toEqual({ status: 'halted' });
    expect(await ix.runOnce()).toEqual({ status: 'halted' });
    expect(rig.alarms.ofKind('reorg_beyond_window')).toHaveLength(2);
    expect(await state(rig)).toEqual(before);
  });

  it('the chain moving during the pass (an event from another block hash, or a broken parent link): nothing written', async () => {
    const rig = await busyRig();
    await indexerFor(rig).runOnce();
    const before = await state(rig);
    rig.chain.mine(2);
    const wrongEvents = wrap(rig, {
      getEvents: async (range) =>
        (await rig.chain.getEvents(range)).map((e) => ({
          ...e,
          blockHash: `0x${'ab'.repeat(32)}`,
        })),
    });
    // An event in the new range so the hash check has something to compare.
    const u = await insertUser(db.prisma);
    await setOnChain(rig.chain, u.wallet, { verified: true });
    expect(await indexerFor(rig, wrongEvents).runOnce()).toEqual({ status: 'unknown' });
    expect(await state(rig)).toEqual(before);

    const head = await rig.chain.getHeadBlock();
    const brokenLink = wrap(rig, {
      getBlock: async (n: bigint) => {
        const b = await rig.chain.getBlock(n);
        return b !== null && n === head ? { ...b, parentHash: `0x${'cd'.repeat(32)}` } : b;
      },
    });
    expect(await indexerFor(rig, brokenLink).runOnce()).toEqual({ status: 'unknown' });
    expect(await state(rig)).toEqual(before);
  });

  it('a stored block at a scanned height with another hash aborts the write (a reorg raced the pass)', async () => {
    const rig = await busyRig();
    const ix = indexerFor(rig);
    await ix.runOnce();
    const s = await state(rig);
    const head = s.last ?? 0n;
    // Pretend a racing writer stored a different block at the tail height above the window check.
    let served = false;
    const racing = wrap(rig, {
      getBlock: async (n: bigint) => {
        const b = await rig.chain.getBlock(n);
        // Window check sees the stored hash; the scan of the same height sees another one.
        if (b !== null && n === head && served) return { ...b, hash: `0x${'ef'.repeat(32)}` };
        if (n === head) served = true;
        return b;
      },
      getEvents: async () => [],
    });
    expect(await indexerFor(rig, racing).runOnce()).toEqual({ status: 'unknown' });
    expect(await state(rig)).toEqual(s);
  });
});

describe('review L-1, L-2: stalls and two indexers', () => {
  it('passes without progress raise indexer_stalled', async () => {
    const rig = await busyRig();
    const ix = indexerFor(rig, rig.chain, {
      confirmationDepth: 2,
      maxBatch: 50,
      reorgWindow: 8,
      stallPasses: 2,
    });
    rig.chain.setUnavailable(true);
    await ix.runOnce();
    expect(rig.alarms.ofKind('indexer_stalled')).toHaveLength(0);
    await ix.runOnce();
    expect(rig.alarms.ofKind('indexer_stalled')).toHaveLength(1);
    rig.chain.setUnavailable(false);
    await ix.runOnce();
    await ix.runOnce();
    expect(rig.alarms.ofKind('indexer_stalled')).toHaveLength(1);
  });

  it('two indexers racing on one deployment: one writes, the other writes nothing, no corruption', async () => {
    const rig = await busyRig();
    const a = indexerFor(rig);
    const b = indexerFor(rig);
    const results = await Promise.all([a.runOnce(), b.runOnce()]);
    expect(results.map((r) => r.status).sort()).toEqual(['scanned', 'unknown']);
    const s = await state(rig);
    expect(s.last).toBe(await rig.chain.getHeadBlock());
    expect(new Set(s.events.map((e) => `${e.blockHash}:${e.logIndex}`)).size).toBe(s.events.length);
  });

  it('a cursor moved by another indexer after this one read it: nothing written (compare-and-set)', async () => {
    const rig = await busyRig();
    const ix = indexerFor(rig);
    // Another indexer advances the cursor while this one is between its reads and its write.
    const realGetEvents = rig.chain.getEvents.bind(rig.chain);
    const sneaky = wrap(rig, {
      getEvents: async (range) => {
        await db.prisma.indexerState.upsert({
          where: { deploymentId: rig.deploymentId },
          create: { deploymentId: rig.deploymentId, lastIndexedBlock: 0n },
          update: { lastIndexedBlock: 0n },
        });
        return realGetEvents(range);
      },
    });
    expect(await indexerFor(rig, sneaky).runOnce()).toEqual({ status: 'unknown' });
    expect(await db.prisma.indexedBlock.count({ where: { deploymentId: rig.deploymentId } })).toBe(
      0,
    );
    expect((await ix.runOnce()).status).toBe('scanned');
  });
});

describe('construction', () => {
  it('refuses a depth < 1, a batch below the depth and a window below the depth', async () => {
    const rig = await makeRig(db.prisma);
    expect(() =>
      indexerFor(rig, rig.chain, { confirmationDepth: 0, maxBatch: 5, reorgWindow: 5 }),
    ).toThrow(RangeError);
    expect(() =>
      indexerFor(rig, rig.chain, { confirmationDepth: 3, maxBatch: 2, reorgWindow: 5 }),
    ).toThrow(RangeError);
    expect(() =>
      indexerFor(rig, rig.chain, { confirmationDepth: 3, maxBatch: 5, reorgWindow: 2 }),
    ).toThrow(RangeError);
  });
});
