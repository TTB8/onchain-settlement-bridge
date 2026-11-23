/**
 * The confirming attempt is recorded as `mined` at the event's block, in the confirmation's own
 * transaction, and that record is OBSERVATION ONLY: no decision depends on it. Real Postgres, the
 * fake chain.
 *
 * The independence check runs each situation twice on twin rigs, once with the attempts' status
 * and block left as the engine wrote them and once with them FORGED (`mined` at a made-up block),
 * and requires the same tick summaries, statuses, failure reasons and ledger at every step.
 */

import { randomUUID } from 'node:crypto';

import { confirmingAttempt, recordConfirmingAttempt } from '../src';
import { createTestDatabase, type TestDatabase } from './support/database';
import { balanceOf, insertUser, type TestUser } from './support/fixtures';
import { attemptsOf, makeRig, opRow, type Rig, setOnChain } from './support/bridge';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

async function verifiedUser(rig: Rig): Promise<TestUser> {
  const u = await insertUser(db.prisma);
  await setOnChain(rig.chain, u.wallet, { verified: true });
  return u;
}

describe('the confirming attempt is recorded as mined', () => {
  it('a confirmed deposit: its one attempt is mined at the event block and hash', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await verifiedUser(rig);
    const dep = (await rig.engine.operations.requestDeposit(alice.id, 10n, randomUUID())).operation;
    const [before] = await attemptsOf(db.prisma, dep.id);
    await rig.engine.tick();
    expect((await opRow(db.prisma, dep.id)).status).toBe('confirmed');
    const [event] = await db.prisma.chainEvent.findMany({ where: { ref: dep.ref } });
    const [attempt] = await attemptsOf(db.prisma, dep.id);
    expect(before).toBeUndefined(); // nothing signed before the tick
    expect(attempt?.hash).toBe(event?.txHash);
    expect({
      status: attempt?.status,
      blockNumber: attempt?.blockNumber,
      blockHash: attempt?.blockHash,
    }).toEqual({ status: 'mined', blockNumber: event?.blockNumber, blockHash: event?.blockHash });
    expect((await opRow(db.prisma, dep.id)).confirmedBlock).toBe(attempt?.blockNumber);
  });

  it('a fee bump: only the replacement that settled is mined; the replaced attempt keeps its status', async () => {
    const rig = await makeRig(db.prisma, { stuckAfterSeconds: 60 }, { automine: false });
    const alice = await verifiedUser(rig);
    rig.chain.mine();
    const dep = (await rig.engine.operations.requestDeposit(alice.id, 13n, randomUUID())).operation;
    await rig.engine.tick();
    const [first] = await attemptsOf(db.prisma, dep.id);
    rig.chain.setBaseFee((first?.maxFeePerGas ?? 0n) + 1n);
    rig.chain.mine();
    await rig.engine.tick();
    rig.clock.advance(61_000);
    await rig.engine.tick(); // bump, same nonce
    rig.chain.mine();
    await rig.engine.tick();
    expect((await opRow(db.prisma, dep.id)).status).toBe('confirmed');
    const [old, bumped] = await attemptsOf(db.prisma, dep.id);
    const [event] = await db.prisma.chainEvent.findMany({ where: { ref: dep.ref } });
    expect(bumped?.hash).toBe(event?.txHash);
    expect(bumped?.status).toBe('mined');
    expect(bumped?.blockNumber).toBe(event?.blockNumber);
    expect(old?.status).toBe(first?.status);
    expect(old?.blockNumber).toBeNull();
    expect(old?.blockHash).toBeNull();
  });

  it('a reverted (frozen) withdrawal is never marked mined: only confirmations record it', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await verifiedUser(rig);
    const dep = (await rig.engine.operations.requestDeposit(alice.id, 100n, randomUUID()))
      .operation;
    await rig.engine.tick();
    const wd = (await rig.engine.operations.requestWithdrawal(alice.id, 60n, randomUUID()))
      .operation;
    await setOnChain(rig.chain, alice.wallet, { frozen: true });
    await rig.engine.tick();
    await rig.engine.tick();
    expect((await opRow(db.prisma, wd.id)).status).toBe('reversed');
    const [attempt] = await attemptsOf(db.prisma, wd.id);
    expect(attempt?.status).not.toBe('mined');
    expect(attempt?.blockNumber).toBeNull();
    expect((await attemptsOf(db.prisma, dep.id))[0]?.status).toBe('mined');
  });

  it('confirmingAttempt matches on the hash only (any case), never on order or nonce', () => {
    const attempts = [
      { id: 'a', hash: `0x${'11'.repeat(32)}` },
      { id: 'b', hash: `0x${'22'.repeat(32)}` },
    ];
    const event = {
      txHash: `0x${'22'.repeat(32)}`.toUpperCase().replace('0X', '0x'),
      blockNumber: 7n,
      blockHash: `0x${'AB'.repeat(32)}`,
    };
    expect(confirmingAttempt(attempts, event)).toEqual({
      attemptId: 'b',
      hash: attempts[1]?.hash,
      blockNumber: 7n,
      blockHash: `0x${'ab'.repeat(32)}`,
    });
    expect(
      confirmingAttempt(attempts, { ...event, txHash: `0x${'33'.repeat(32)}` }),
    ).toBeUndefined();
    expect(confirmingAttempt([], event)).toBeUndefined();
  });

  it('recordConfirmingAttempt is fenced on id AND hash: a wrong hash writes nothing', async () => {
    const rig = await makeRig(db.prisma, {}, { automine: false });
    const alice = await verifiedUser(rig);
    rig.chain.mine();
    const dep = (await rig.engine.operations.requestDeposit(alice.id, 5n, randomUUID())).operation;
    await rig.engine.tick();
    const [a] = await attemptsOf(db.prisma, dep.id);
    await db.prisma.$transaction((tx) =>
      recordConfirmingAttempt(tx, {
        attemptId: a?.id as string,
        hash: `0x${'99'.repeat(32)}`,
        blockNumber: 1n,
        blockHash: `0x${'aa'.repeat(32)}`,
      }),
    );
    const [after] = await attemptsOf(db.prisma, dep.id);
    expect(after?.status).toBe(a?.status);
    expect(after?.blockNumber).toBeNull();
  });
});

/** One observable step of a situation: what the tick did and where every operation stands. */
type Trace = unknown[];

/** Sets every attempt of the rig's deployment to a FORGED `mined` at a made-up block. */
async function forgeMined(rig: Rig): Promise<void> {
  await db.prisma.chainAttempt.updateMany({
    where: { deploymentId: rig.deploymentId },
    data: { status: 'mined', blockNumber: 424_242n, blockHash: `0x${'5a'.repeat(32)}` },
  });
}

/** Clears every attempt's observation back to `sent` with no block. */
async function clearObserved(rig: Rig): Promise<void> {
  await db.prisma.chainAttempt.updateMany({
    where: { deploymentId: rig.deploymentId },
    data: { status: 'sent', blockNumber: null, blockHash: null },
  });
}

async function snapshot(rig: Rig, ids: string[], users: TestUser[], t: unknown): Promise<unknown> {
  const ops = await Promise.all(ids.map((id) => opRow(db.prisma, id)));
  return {
    tick: t,
    ops: ops.map((o) => [o.status, o.failureReason, o.resubmitsSoFar]),
    attempts: (await Promise.all(ids.map((id) => attemptsOf(db.prisma, id)))).map((l) => l.length),
    balances: await Promise.all(
      users.flatMap((u) => [balanceOf(db.prisma, u.available), balanceOf(db.prisma, u.held)]),
    ),
  };
}

/**
 * Runs a situation on a fresh rig; before EVERY tick the attempts' observation columns are
 * either forged to `mined` or cleared, depending on `mode`.
 */
type Situation = (
  rig: Rig,
  tick: () => Promise<void>,
) => Promise<{ ids: string[]; users: TestUser[] }>;

async function trace(mode: 'forged' | 'cleared', situation: Situation, extra = {}, chain = {}) {
  const rig = await makeRig(db.prisma, extra, chain);
  const out: Trace = [];
  let state: { ids: string[]; users: TestUser[] } = { ids: [], users: [] };
  const tick = async () => {
    if (mode === 'forged') await forgeMined(rig);
    else await clearObserved(rig);
    const t = await rig.engine.tick();
    out.push(await snapshot(rig, state.ids, state.users, t.monitor));
  };
  state = await situation(rig, async () => tick());
  out.push(await snapshot(rig, state.ids, state.users, 'end'));
  return out;
}

describe('observation only: decisions are identical with the attempts forged mined or cleared', () => {
  const situations: [string, Situation, object, object][] = [
    [
      'deposit confirmed, then a transfer to a frozen recipient fails and is reversed',
      async (rig, tick) => {
        const a = await verifiedUser(rig);
        const b = await verifiedUser(rig);
        const state = { ids: [] as string[], users: [a, b] };
        const dep = (await rig.engine.operations.requestDeposit(a.id, 50n, randomUUID())).operation;
        state.ids.push(dep.id);
        await tick();
        await setOnChain(rig.chain, b.wallet, { frozen: true });
        const tr = (await rig.engine.operations.requestTransfer(a.id, b.id, 20n, randomUUID()))
          .operation;
        state.ids.push(tr.id);
        await tick();
        await tick();
        await tick();
        return state;
      },
      {},
      {},
    ],
    [
      'a dropped transaction (never mined) is waited for, then rebroadcast, then confirmed',
      async (rig, tick) => {
        const a = await verifiedUser(rig);
        rig.chain.mine();
        const state = { ids: [] as string[], users: [a] };
        const dep = (await rig.engine.operations.requestDeposit(a.id, 12n, randomUUID())).operation;
        state.ids.push(dep.id);
        await tick();
        const [attempt] = await attemptsOf(db.prisma, dep.id);
        rig.chain.dropTransaction(attempt?.hash as `0x${string}`);
        await tick();
        await tick();
        rig.clock.advance(31_000);
        await tick();
        rig.chain.mine();
        await tick();
        return state;
      },
      {},
      { automine: false },
    ],
    [
      'a pending (unmined) transaction is never confirmed early, then confirmed once mined',
      async (rig, tick) => {
        const a = await verifiedUser(rig);
        rig.chain.mine();
        const state = { ids: [] as string[], users: [a] };
        const dep = (await rig.engine.operations.requestDeposit(a.id, 9n, randomUUID())).operation;
        state.ids.push(dep.id);
        await tick();
        await tick();
        await tick();
        rig.chain.mine();
        await tick();
        return state;
      },
      {},
      { automine: false },
    ],
  ];

  it.each(situations)('%s', async (_name, situation, extra, chain) => {
    const cleared = await trace('cleared', situation, extra, chain);
    const forged = await trace('forged', situation, extra, chain);
    expect(forged).toEqual(cleared);
    // The situation really reached the decisions it is about (not an empty or stuck trace).
    const text = JSON.stringify(cleared, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(text).toMatch(/"confirmed"/);
    if (_name.includes('reversed')) expect(text).toMatch(/"reversed"/);
    if (_name.includes('rebroadcast')) expect(text).toMatch(/"resubmitted":1/);
  });
});
