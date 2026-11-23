/**
 * Piece B scenarios on real Postgres with the FakeChainGateway: every case from ADRs 0006, 0007,
 * 0009, 0011 and the 18-point checklist (0012) that the submitter and the monitor decide. Each
 * test names the obligation it pins. The indexer's own cases are in indexer.test.ts.
 */

import { randomUUID } from 'node:crypto';

import { ChainUnavailableError, SubmissionRejectedError } from '@bridge/chain';

import {
  AlarmLog,
  BridgeEngine,
  DeploymentMismatchError,
  InvalidRequestError,
  LeaseLostError,
  moveOperation,
} from '../src';
import { createTestDatabase, type TestDatabase } from './support/database';
import { balanceOf, FakeClock, insertUser, RecordingIds, type TestUser } from './support/fixtures';
import {
  attemptsOf,
  configFor,
  FakeTransactionInspector,
  ledgerHolding,
  makeRig,
  opRow,
  ref32,
  type Rig,
  setOnChain,
  SpyChain,
  tickUntil,
} from './support/bridge';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

/** A user verified in the database and on the rig's chain. */
async function verifiedUser(rig: Rig): Promise<TestUser> {
  const u = await insertUser(db.prisma);
  await setOnChain(rig.chain, u.wallet, { verified: true });
  return u;
}

async function deposit(rig: Rig, u: TestUser, amount: bigint) {
  return (await rig.engine.operations.requestDeposit(u.id, amount, randomUUID())).operation;
}

async function statusOf(id: string): Promise<string> {
  return (await opRow(db.prisma, id)).status;
}

/** A person FAILs a submitted operation (any attempt it has stays recorded). */
async function operatorFail(id: string): Promise<void> {
  const op = await opRow(db.prisma, id);
  await db.prisma.$transaction((tx) =>
    moveOperation(tx, {
      operationId: id,
      from: 'submitted',
      version: op.version,
      move: { event: 'FAIL', reason: 'retries_exhausted' },
      at: new Date(),
      note: 'operator gave up',
    }),
  );
}

/** A deposit taken to `confirmed` through tick(). */
async function fundedUser(rig: Rig, amount: bigint): Promise<TestUser> {
  const u = await verifiedUser(rig);
  const op = await deposit(rig, u, amount);
  await tickUntil(rig.engine, async () => (await statusOf(op.id)) === 'confirmed');
  expect(await statusOf(op.id)).toBe('confirmed');
  return u;
}

/** Puts an outbox row back in the queue, as a crash or a lease takeover would. */
async function requeue(rig: Rig, operationId: string): Promise<void> {
  await db.prisma.outboxMessage.updateMany({
    where: { operationId },
    data: { status: 'pending', lockedAt: null, lockedBy: null, availableAt: rig.clock.now() },
  });
}

describe('happy paths through tick() (exact ledger, one attempt, one transaction)', () => {
  it('deposit -> withdrawal -> transfer, each confirmed at its event block, ledger equals chain', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await verifiedUser(rig);
    const bob = await verifiedUser(rig);

    const dep = await deposit(rig, alice, 100n);
    const t1 = await rig.engine.tick();
    expect(t1.dispatch.done).toBe(1);
    expect(t1.monitor.confirmed).toBe(1);
    const depRow = await opRow(db.prisma, dep.id);
    expect(depRow.status).toBe('confirmed');
    const [depEvent] = await db.prisma.chainEvent.findMany({ where: { ref: dep.ref } });
    expect(depRow.confirmedBlock).toBe(depEvent?.blockNumber);
    expect(await attemptsOf(db.prisma, dep.id)).toHaveLength(1);
    expect(await balanceOf(db.prisma, alice.available)).toBe(100n);

    const wd = await rig.engine.operations.requestWithdrawal(alice.id, 40n, randomUUID());
    await rig.engine.tick();
    expect(await statusOf(wd.operation.id)).toBe('confirmed');

    const tr = await rig.engine.operations.requestTransfer(alice.id, bob.id, 25n, randomUUID());
    await rig.engine.tick();
    expect(await statusOf(tr.operation.id)).toBe('confirmed');

    expect(await balanceOf(db.prisma, alice.available)).toBe(35n);
    expect(await balanceOf(db.prisma, bob.available)).toBe(25n);
    expect(await balanceOf(db.prisma, alice.held)).toBe(0n);
    expect(rig.chain.balanceOf(alice.wallet as `0x${string}`)).toBe(35n);
    expect(rig.chain.balanceOf(bob.wallet as `0x${string}`)).toBe(25n);
    expect(await ledgerHolding(db.prisma, alice)).toBe(35n);
    expect(rig.signer.broadcasts).toHaveLength(3);
    const outbox = await db.prisma.outboxMessage.findMany({
      where: { deploymentId: rig.deploymentId },
    });
    expect(outbox.every((o) => o.status === 'done')).toBe(true);
  });

  it('obligation 12: confirmedBlock is the event block, never the head, and only once final', async () => {
    const rig = await makeRig(db.prisma, { confirmationDepth: 3 });
    const alice = await verifiedUser(rig);
    const dep = await deposit(rig, alice, 10n);
    await rig.engine.tick();
    expect(await statusOf(dep.id)).toBe('submitted'); // 1 confirmation of 3
    rig.chain.mine(1);
    await rig.engine.tick();
    expect(await statusOf(dep.id)).toBe('submitted'); // 2 of 3
    rig.chain.mine(4);
    await rig.engine.tick();
    const row = await opRow(db.prisma, dep.id);
    const [ev] = await db.prisma.chainEvent.findMany({ where: { ref: dep.ref } });
    const head = await rig.chain.getHeadBlock();
    expect(row.status).toBe('confirmed');
    expect(row.confirmedBlock).toBe(ev?.blockNumber);
    expect(row.confirmedBlock).not.toBe(head);
  });
});

describe('the submitter: commit before broadcast, idempotent per row (obligation 1)', () => {
  it('an outbox row delivered twice gives one attempt and one transaction', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await verifiedUser(rig);
    const dep = await deposit(rig, alice, 50n);
    await rig.engine.dispatcher.runOnce();
    await requeue(rig, dep.id);
    const second = await rig.engine.dispatcher.runOnce();
    expect(second.done).toBe(1);
    const attempts = await attemptsOf(db.prisma, dep.id);
    expect(attempts).toHaveLength(1);
    // The second delivery rebroadcast the SAME bytes (the node answered "nonce used").
    expect(new Set(rig.signer.broadcasts)).toEqual(new Set([attempts[0]?.hash]));
    expect(rig.chain.balanceOf(alice.wallet as `0x${string}`)).toBe(50n);
    await rig.engine.tick();
    expect(await statusOf(dep.id)).toBe('confirmed');
  });

  it('a crash between the attempt commit and the broadcast rebroadcasts the same transaction', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await verifiedUser(rig);
    const dep = await deposit(rig, alice, 7n);
    rig.signer.crashNextBroadcast = new Error('worker died after the commit');
    const first = await rig.engine.dispatcher.runOnce();
    expect(first.retried).toBe(1);
    const [attempt] = await attemptsOf(db.prisma, dep.id);
    expect(attempt).toBeDefined();
    expect(await statusOf(dep.id)).toBe('submitted');
    expect(rig.chain.tokenReferenceUsed(dep.ref as `0x${string}`)).toBe(false);
    expect(rig.signer.broadcasts).toHaveLength(0);

    rig.clock.advance(60_000);
    await rig.engine.tick();
    expect(await attemptsOf(db.prisma, dep.id)).toHaveLength(1);
    expect(rig.signer.broadcasts).toEqual([attempt?.hash]);
    expect(await statusOf(dep.id)).toBe('confirmed');
  });

  it('stillHolds() false after the commit: nothing is broadcast; the next delivery sends it', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await verifiedUser(rig);
    const dep = await deposit(rig, alice, 9n);
    const lease = 'test/lease';
    await db.prisma.outboxMessage.updateMany({
      where: { operationId: dep.id },
      data: { status: 'processing', lockedBy: lease, lockedAt: rig.clock.now() },
    });
    const row = await db.prisma.outboxMessage.findFirstOrThrow({ where: { operationId: dep.id } });
    const controller = new AbortController();
    await expect(
      rig.engine.submitter.handle(row, {
        stillHolds: async () => false,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(await attemptsOf(db.prisma, dep.id)).toHaveLength(1);
    expect(rig.signer.broadcasts).toHaveLength(0);

    // An aborted signal (the handler's time limit) stops the broadcast as well.
    controller.abort();
    await expect(
      rig.engine.submitter.handle(row, { stillHolds: async () => true, signal: controller.signal }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(rig.signer.broadcasts).toHaveLength(0);

    await requeue(rig, dep.id);
    await rig.engine.tick();
    expect(rig.signer.broadcasts).toHaveLength(1);
    expect(await statusOf(dep.id)).toBe('confirmed');
  });

  it('review L-B: a lease taken over while signing rolls the attempt back and sends nothing', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await verifiedUser(rig);
    const dep = await deposit(rig, alice, 11n);
    await db.prisma.outboxMessage.updateMany({
      where: { operationId: dep.id },
      data: { status: 'processing', lockedBy: 'me/1', lockedAt: rig.clock.now() },
    });
    const row = await db.prisma.outboxMessage.findFirstOrThrow({ where: { operationId: dep.id } });
    // Another worker takes the row over before our attempt transaction reaches the fence.
    await db.prisma.outboxMessage.updateMany({
      where: { id: row.id },
      data: { lockedBy: 'other/2' },
    });
    await expect(
      rig.engine.submitter.handle(row, {
        stillHolds: async () => true,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(await attemptsOf(db.prisma, dep.id)).toHaveLength(0);
    expect(await statusOf(dep.id)).toBe('ledger_reserved');
    expect(rig.signer.broadcasts).toHaveLength(0);
  });

  it('review L-B: FAIL (cancelling the row) committed first: nothing is signed, the reversal releases the funds, nothing is ever broadcast', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await fundedUser(rig, 100n);
    const wd = (await rig.engine.operations.requestWithdrawal(alice.id, 60n, randomUUID()))
      .operation;
    await db.prisma.outboxMessage.updateMany({
      where: { operationId: wd.id },
      data: { status: 'processing', lockedBy: 'me/1', lockedAt: rig.clock.now() },
    });
    const row = await db.prisma.outboxMessage.findFirstOrThrow({ where: { operationId: wd.id } });
    await rig.engine.operations.move({
      operationId: wd.id,
      from: 'ledger_reserved',
      version: 0,
      move: { event: 'FAIL', reason: 'rejected' },
      at: rig.clock.now(),
      note: 'operator cancelled',
    });
    // The operation is no longer reserved: nothing is signed, the row is finished.
    await expect(
      rig.engine.submitter.handle(row, {
        stillHolds: async () => true,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe('done');
    expect(await attemptsOf(db.prisma, wd.id)).toHaveLength(0);
    await rig.engine.monitor.runOnce();
    expect(await statusOf(wd.id)).toBe('reversed');
    expect(await balanceOf(db.prisma, alice.available)).toBe(100n);
    expect(rig.signer.broadcasts.length).toBe(1); // only the funding deposit
  });

  it('review L-B: REVERSE racing the attempt commit: exactly one wins, the loser never broadcasts', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await fundedUser(rig, 100n);
    const sent = rig.signer.broadcasts.length;
    const wd = (await rig.engine.operations.requestWithdrawal(alice.id, 30n, randomUUID()))
      .operation;
    let failMove: Promise<unknown> | undefined;
    // Fired from inside the attempt transaction, after its outbox fence: FAIL + cancel queue on
    // the operation and outbox rows; Postgres serialises (or deadlocks and retries) them.
    rig.signer.onSign = async () => {
      failMove = rig.engine.operations
        .move({
          operationId: wd.id,
          from: 'ledger_reserved',
          version: 0,
          move: { event: 'FAIL', reason: 'rejected' },
          at: rig.clock.now(),
          note: 'cancel racing the send',
        })
        .catch((err: unknown) => err);
    };
    const r = await rig.engine.dispatcher.runOnce();
    const failResult = await failMove;
    await rig.engine.monitor.runOnce();
    const attempts = await attemptsOf(db.prisma, wd.id);
    const status = await statusOf(wd.id);
    if (attempts.length === 0) {
      // The cancellation won: no attempt, no broadcast, funds released.
      expect(status).toBe('reversed');
      expect(rig.signer.broadcasts.length).toBe(sent);
      expect(r.done).toBe(0);
      expect(await balanceOf(db.prisma, alice.available)).toBe(100n);
    } else {
      // The send won: the FAIL was refused and the withdrawal settles.
      expect(failResult).toBeInstanceOf(Error);
      expect(attempts).toHaveLength(1);
      expect(['submitted', 'confirmed']).toContain(status);
    }
  });

  it('obligation 17: an outbox row bound to another deployment is never sent by this engine', async () => {
    const rigA = await makeRig(db.prisma);
    const rigB = await makeRig(db.prisma);
    const alice = await verifiedUser(rigA);
    const dep = await deposit(rigA, alice, 5n);
    await db.prisma.outboxMessage.updateMany({
      where: { operationId: dep.id },
      data: { status: 'processing', lockedBy: 'b/1', lockedAt: rigB.clock.now() },
    });
    const row = await db.prisma.outboxMessage.findFirstOrThrow({ where: { operationId: dep.id } });
    await expect(
      rigB.engine.submitter.handle(row, {
        stillHolds: async () => true,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(DeploymentMismatchError);
    expect(await attemptsOf(db.prisma, dep.id)).toHaveLength(0);
  });
});

describe('unknown and rejected submissions (ADR 0009, obligations 3-4)', () => {
  it('submit outcome unknown but the node took it: confirmed, never reversed, never re-signed', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await verifiedUser(rig);
    const dep = await deposit(rig, alice, 20n);
    rig.chain.failNextSubmit(new ChainUnavailableError('timeout'), { accept: true });
    const t = await rig.engine.tick();
    expect(t.dispatch.retried).toBe(1);
    expect(await statusOf(dep.id)).toBe('confirmed');
    rig.clock.advance(60_000);
    const t2 = await rig.engine.tick();
    expect(t2.dispatch.done).toBe(1);
    expect(await attemptsOf(db.prisma, dep.id)).toHaveLength(1);
    expect(rig.chain.balanceOf(alice.wallet as `0x${string}`)).toBe(20n);
    expect(await balanceOf(db.prisma, alice.available)).toBe(20n);
  });

  it('another node accepted what ours rejected: the rejected attempt still counts, the failed operation is not reversed, then settles late', async () => {
    const rig = await makeRig(db.prisma, {}, { automine: false });
    const alice = await verifiedUser(rig);
    rig.chain.mine();
    const dep = await deposit(rig, alice, 15n);
    rig.chain.failNextSubmit(new SubmissionRejectedError('invalid sender'), { accept: true });
    const t = await rig.engine.tick();
    expect(t.dispatch.dead).toBe(1); // the row is a definite refusal by THIS node
    const [attempt] = await attemptsOf(db.prisma, dep.id);
    expect(attempt?.status).toBe('dropped');
    expect(rig.chain.mempoolSize()).toBe(1); // ...but the pool holds it

    await operatorFail(dep.id); // e.g. a person gives up on it
    for (let i = 0; i < 3; i += 1) await rig.engine.tick();
    expect(await statusOf(dep.id)).toBe('failed'); // NOT reversed: the attempt can still mine

    rig.chain.mine();
    const late = await rig.engine.tick();
    expect(late.monitor.lateConfirmed).toBe(1);
    expect(await statusOf(dep.id)).toBe('confirmed');
    expect(await balanceOf(db.prisma, alice.available)).toBe(15n);
    expect(rig.chain.balanceOf(alice.wallet as `0x${string}`)).toBe(15n);
  });

  it('review H-1c: giving up on the lowest non-final nonce keeps the operation submitted and raises nonce_stuck; queued operations behind it are not failed one by one', async () => {
    const rig = await makeRig(db.prisma, { maxBumps: 0 }, { automine: false });
    const alice = await verifiedUser(rig);
    rig.chain.mine();
    const ops = [];
    for (const amount of [1n, 2n, 3n]) ops.push(await deposit(rig, alice, amount));
    await rig.engine.tick(); // three attempts, nonces n, n+1, n+2, all pooled
    rig.chain.setBaseFee(10n ** 11n); // above every fee cap they were signed with: all stuck
    rig.clock.advance(120_000); // stuck and no bumps allowed: the domain gives up...
    await rig.engine.tick();
    for (const op of ops) expect(await statusOf(op.id)).toBe('submitted'); // ...but not yet (time)
    expect(rig.alarms.ofKind('nonce_stuck')).toHaveLength(0);
    rig.clock.advance(300_000); // past giveUpAfterSeconds
    await rig.engine.tick();
    for (const op of ops) expect(await statusOf(op.id)).toBe('submitted');
    const stuck = rig.alarms.ofKind('nonce_stuck');
    expect(new Set(stuck.map((a) => a.operationId))).toEqual(new Set(ops.map((o) => o.id)));
    const nonces: number[] = [];
    for (const op of ops) for (const a of await attemptsOf(db.prisma, op.id)) nonces.push(a.nonce);
    const lowest = Math.min(...nonces);
    expect(
      stuck.every((a) => a.detail.includes(`nonce ${lowest} is the lowest non-final nonce`)),
    ).toBe(true);
    expect(stuck[0]?.detail).toContain(rig.chain.signerAddress('settlement'));
  });

  it('obligation 3: any read error means nothing is decided or written', async () => {
    const rig = await makeRig(db.prisma, {}, { automine: false });
    const alice = await verifiedUser(rig);
    rig.chain.mine();
    const dep = await deposit(rig, alice, 3n);
    await rig.engine.tick();
    rig.chain.setUnavailable(true);
    rig.clock.advance(3_600_000);
    const before = {
      op: await opRow(db.prisma, dep.id),
      attempts: await attemptsOf(db.prisma, dep.id),
      audit: await db.prisma.auditLog.count(),
      events: await db.prisma.chainEvent.count(),
    };
    const m = await rig.engine.monitor.runOnce();
    const i = await rig.engine.indexer.runOnce();
    expect(m.ran).toBe(false);
    expect(i.status).toBe('unknown');
    expect(await opRow(db.prisma, dep.id)).toEqual(before.op);
    expect(await attemptsOf(db.prisma, dep.id)).toEqual(before.attempts);
    expect(await db.prisma.auditLog.count()).toBe(before.audit);
    expect(await db.prisma.chainEvent.count()).toBe(before.events);
  });

  it('obligation 3: a read error for one operation skips it this pass', async () => {
    const rig = await makeRig(db.prisma, {}, { automine: false });
    const alice = await verifiedUser(rig);
    rig.chain.mine();
    const dep = await deposit(rig, alice, 3n);
    await rig.engine.tick();
    const original = rig.chain.getReceipt.bind(rig.chain);
    rig.chain.getReceipt = async () => {
      throw new ChainUnavailableError('flaky');
    };
    rig.clock.advance(3_600_000);
    const m = await rig.engine.monitor.runOnce();
    rig.chain.getReceipt = original;
    expect(m.skipped).toBe(1);
    expect((await opRow(db.prisma, dep.id)).version).toBe(1);
  });
});

describe('reverts, drops, bumps and give-ups (ADR 0006, 0007)', () => {
  it('frozen address mid-operation: the contract reverts, FAIL compliance_rejected, then REVERSE releases the funds', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await fundedUser(rig, 100n);
    const wd = (await rig.engine.operations.requestWithdrawal(alice.id, 60n, randomUUID()))
      .operation;
    expect(await balanceOf(db.prisma, alice.held)).toBe(60n);
    await setOnChain(rig.chain, alice.wallet, { frozen: true });
    await rig.engine.tick();
    const failed = await opRow(db.prisma, wd.id);
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('compliance_rejected');
    const t = await rig.engine.tick();
    expect(t.monitor.reversed).toBe(1);
    expect(await statusOf(wd.id)).toBe('reversed');
    expect(await balanceOf(db.prisma, alice.available)).toBe(100n);
    expect(await balanceOf(db.prisma, alice.held)).toBe(0n);
    expect(rig.chain.balanceOf(alice.wallet as `0x${string}`)).toBe(100n);
  });

  it('a plain revert (on-chain balance moved away): FAIL reverted, then reversed', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await fundedUser(rig, 100n);
    const bob = await verifiedUser(rig);
    rig.chain.setHolderTransfersEnabled(true);
    rig.chain.injectTransfer(alice.wallet as `0x${string}`, bob.wallet as `0x${string}`, 100n);
    const wd = (await rig.engine.operations.requestWithdrawal(alice.id, 50n, randomUUID()))
      .operation;
    await rig.engine.tick();
    expect((await opRow(db.prisma, wd.id)).failureReason).toBe('reverted');
    await rig.engine.tick();
    expect(await statusOf(wd.id)).toBe('reversed');
    expect(await balanceOf(db.prisma, alice.available)).toBe(100n);
  });

  it('dropped transaction: rebroadcast of the same bytes (SUBMIT resubmit) once dropRetrySeconds passed, then confirmed', async () => {
    const rig = await makeRig(db.prisma, {}, { automine: false });
    const alice = await verifiedUser(rig);
    rig.chain.mine();
    const dep = await deposit(rig, alice, 12n);
    await rig.engine.tick();
    const [attempt] = await attemptsOf(db.prisma, dep.id);
    expect(rig.chain.dropTransaction(attempt?.hash as `0x${string}`)).toBe(true);
    for (let i = 0; i < 5; i += 1) await rig.engine.tick(); // fast passes: patience is time
    expect((await opRow(db.prisma, dep.id)).resubmitsSoFar).toBe(0);
    rig.clock.advance(31_000);
    const t = await rig.engine.tick();
    expect(t.monitor.resubmitted).toBe(1);
    expect(rig.chain.mempoolHashes()).toEqual([attempt?.hash]);
    rig.chain.mine();
    await rig.engine.tick();
    const row = await opRow(db.prisma, dep.id);
    expect(row.status).toBe('confirmed');
    expect(row.resubmitsSoFar).toBe(1);
    expect(await attemptsOf(db.prisma, dep.id)).toHaveLength(1);
  });

  it('review H-1a: dropped because its fees fell below the base fee: a same-nonce replacement at current fees confirms', async () => {
    const rig = await makeRig(db.prisma, {}, { automine: false });
    const alice = await verifiedUser(rig);
    rig.chain.mine();
    const dep = await deposit(rig, alice, 18n);
    await rig.engine.tick();
    const [first] = await attemptsOf(db.prisma, dep.id);
    rig.chain.setBaseFee((first?.maxFeePerGas ?? 0n) * 2n); // the old bytes can never be included
    rig.chain.dropTransaction(first?.hash as `0x${string}`); // ...and the pool evicted them
    rig.clock.advance(31_000);
    const t = await rig.engine.tick();
    expect(t.monitor.bumped).toBe(1);
    expect(t.monitor.resubmitted).toBe(0);
    const attempts = await attemptsOf(db.prisma, dep.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.nonce).toBe(first?.nonce);
    expect(attempts[1]?.bumpsSoFar).toBe(1);
    expect((attempts[1]?.maxFeePerGas ?? 0n) > rig.chain.baseFee).toBe(true);
    rig.chain.mine();
    await rig.engine.tick();
    expect(await statusOf(dep.id)).toBe('confirmed');
    expect(rig.chain.balanceOf(alice.wallet as `0x${string}`)).toBe(18n);
  });

  it('stuck transaction: fee bump with the SAME nonce, then confirmed', async () => {
    const rig = await makeRig(db.prisma, { stuckAfterSeconds: 60 }, { automine: false });
    const alice = await verifiedUser(rig);
    rig.chain.mine();
    const dep = await deposit(rig, alice, 13n);
    await rig.engine.tick();
    const [first] = await attemptsOf(db.prisma, dep.id);
    rig.chain.setBaseFee((first?.maxFeePerGas ?? 0n) + 1n); // above its fee cap: stuck
    rig.chain.mine();
    await rig.engine.tick();
    expect(await statusOf(dep.id)).toBe('submitted'); // not stuck long enough yet
    rig.clock.advance(61_000);
    const t = await rig.engine.tick();
    expect(t.monitor.bumped).toBe(1);
    const attempts = await attemptsOf(db.prisma, dep.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.nonce).toBe(first?.nonce);
    expect(attempts[1]?.bumpsSoFar).toBe(1);
    expect((attempts[1]?.maxFeePerGas ?? 0n) > (first?.maxFeePerGas ?? 0n)).toBe(true);
    rig.chain.mine();
    await rig.engine.tick();
    expect(await statusOf(dep.id)).toBe('confirmed');
    expect(rig.chain.balanceOf(alice.wallet as `0x${string}`)).toBe(13n);
  });

  it('dropped and never mined: no FAIL while the nonce is not final (nonce_stuck); reverse ONLY once the nonce use is final (obligations 2, 4, 7)', async () => {
    const rig = await makeRig(
      db.prisma,
      { maxResubmits: 1, confirmationDepth: 3 },
      { automine: false },
    );
    const alice = await verifiedUser(rig);
    rig.chain.mine();
    const dep = await deposit(rig, alice, 14n);
    await rig.engine.tick();
    const [attempt] = await attemptsOf(db.prisma, dep.id);
    const hash = attempt?.hash as `0x${string}`;
    rig.chain.dropTransaction(hash);
    rig.clock.advance(31_000);
    await rig.engine.tick(); // dropped: resubmit (1 of 1)
    rig.chain.dropTransaction(hash);
    rig.clock.advance(31_000);
    await rig.engine.tick(); // dropped again: the domain gives up, too early to act
    rig.clock.advance(300_000);
    await rig.engine.tick();
    expect(await statusOf(dep.id)).toBe('submitted'); // nonce never used: it can still mine
    expect(rig.alarms.ofKind('nonce_stuck').length).toBeGreaterThan(0);

    // Something else takes the nonce (an operator's transaction from the same key).
    await rig.chain.submit({
      signer: 'settlement',
      call: { kind: 'mint', to: alice.wallet as `0x${string}`, amount: 1n, ref: ref32() },
      nonce: attempt?.nonce ?? 0,
      fees: { maxFeePerGas: 10n ** 10n, maxPriorityFeePerGas: 10n ** 9n },
    });
    rig.chain.mine();
    await rig.engine.tick();
    expect(await statusOf(dep.id)).toBe('submitted'); // used at the head, not final yet
    rig.chain.mine(1);
    await rig.engine.tick();
    expect(await statusOf(dep.id)).toBe('submitted'); // 2 of 3
    rig.chain.mine(1);
    await rig.engine.tick(); // final: replaced for good, resubmissions used up
    const failed = await opRow(db.prisma, dep.id);
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('retries_exhausted');
    const t = await rig.engine.tick();
    expect(t.monitor.reversed).toBe(1);
    expect(await statusOf(dep.id)).toBe('reversed');
    expect(await balanceOf(db.prisma, alice.incoming)).toBe(0n);
  });

  it('every attempt replaced for good and the reference unused: resubmit with a NEW nonce', async () => {
    const rig = await makeRig(db.prisma, {}, { automine: false });
    const alice = await verifiedUser(rig);
    rig.chain.mine();
    const dep = await deposit(rig, alice, 16n);
    await rig.engine.tick();
    const [attempt] = await attemptsOf(db.prisma, dep.id);
    rig.chain.dropTransaction(attempt?.hash as `0x${string}`);
    await rig.chain.submit({
      signer: 'settlement',
      call: { kind: 'mint', to: alice.wallet as `0x${string}`, amount: 1n, ref: ref32() },
      nonce: attempt?.nonce ?? 0,
      fees: { maxFeePerGas: 10n ** 10n, maxPriorityFeePerGas: 10n ** 9n },
    });
    rig.chain.mine();
    const t = await rig.engine.tick();
    expect(t.monitor.resubmitted).toBe(1);
    const attempts = await attemptsOf(db.prisma, dep.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.nonce).toBe((attempt?.nonce ?? 0) + 1);
    rig.chain.mine();
    await rig.engine.tick();
    expect(await statusOf(dep.id)).toBe('confirmed');
    expect(rig.chain.balanceOf(alice.wallet as `0x${string}`)).toBe(17n);
  });

  it('a nonce taken and the resubmissions used up: FAIL retries_exhausted', async () => {
    const rig = await makeRig(db.prisma, { maxResubmits: 0 }, { automine: false });
    const alice = await verifiedUser(rig);
    rig.chain.mine();
    const dep = await deposit(rig, alice, 16n);
    await rig.engine.tick();
    const [attempt] = await attemptsOf(db.prisma, dep.id);
    rig.chain.dropTransaction(attempt?.hash as `0x${string}`);
    await rig.chain.submit({
      signer: 'settlement',
      call: { kind: 'mint', to: alice.wallet as `0x${string}`, amount: 1n, ref: ref32() },
      nonce: attempt?.nonce ?? 0,
      fees: { maxFeePerGas: 10n ** 10n, maxPriorityFeePerGas: 10n ** 9n },
    });
    rig.chain.mine();
    await rig.engine.tick();
    expect((await opRow(db.prisma, dep.id)).failureReason).toBe('retries_exhausted');
  });
});

describe('escalations and late confirmation (obligations 8, 11)', () => {
  it('duplicate_reference: failed and escalated, never reversed; settles late once the index shows the exact event', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await verifiedUser(rig);
    const dep = await deposit(rig, alice, 30n);
    // The reference is consumed by a transaction the index has not seen.
    const { pending } = await rig.chain.getNonce('settlement');
    await rig.chain.submit({
      signer: 'settlement',
      call: {
        kind: 'mint',
        to: alice.wallet as `0x${string}`,
        amount: 30n,
        ref: dep.ref as `0x${string}`,
      },
      nonce: pending,
      fees: await rig.chain.estimateFees(),
    });
    await rig.engine.dispatcher.runOnce();
    await rig.engine.monitor.runOnce(); // no indexer pass: the event is not in the index
    const failed = await opRow(db.prisma, dep.id);
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('duplicate_reference');
    const escalated = await db.prisma.auditLog.findMany({
      where: { entityId: dep.id, toState: 'escalated' },
    });
    expect(escalated).toHaveLength(1);
    expect(rig.alarms.ofKind('escalation').some((a) => a.operationId === dep.id)).toBe(true);
    for (let i = 0; i < 3; i += 1) await rig.engine.monitor.runOnce();
    expect(await statusOf(dep.id)).toBe('failed');
    expect(rig.alarms.ofKind('examine_error')).toHaveLength(0);

    // The index catches up: the event matches exactly, so the operation settles late.
    await rig.engine.indexer.runOnce();
    const m = await rig.engine.monitor.runOnce();
    expect(m.lateConfirmed).toBe(1);
    const row = await opRow(db.prisma, dep.id);
    expect(row.status).toBe('confirmed');
    expect(await balanceOf(db.prisma, alice.available)).toBe(30n);
    expect(rig.chain.balanceOf(alice.wallet as `0x${string}`)).toBe(30n);
  });

  it('reference_conflict: a final event with the reference but another amount is failed and escalated, never reversed or confirmed', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await verifiedUser(rig);
    const dep = await deposit(rig, alice, 30n);
    const { pending } = await rig.chain.getNonce('settlement');
    await rig.chain.submit({
      signer: 'settlement',
      call: {
        kind: 'mint',
        to: alice.wallet as `0x${string}`,
        amount: 29n,
        ref: dep.ref as `0x${string}`,
      },
      nonce: pending,
      fees: await rig.chain.estimateFees(),
    });
    await rig.engine.tick();
    const row = await opRow(db.prisma, dep.id);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe('reference_conflict');
    for (let i = 0; i < 3; i += 1) await rig.engine.tick();
    expect(await statusOf(dep.id)).toBe('failed');
    expect(await balanceOf(db.prisma, alice.incoming)).toBe(30n);
    expect(
      await db.prisma.auditLog.count({ where: { entityId: dep.id, toState: 'escalated' } }),
    ).toBe(1);
  });
});

describe('reorgs and canonical evidence (obligations 9, 12, 15)', () => {
  it('a reorg removing a not-yet-final transaction: never confirmed early, resent, confirmed in its new block', async () => {
    const rig = await makeRig(db.prisma, { confirmationDepth: 3 });
    const alice = await verifiedUser(rig);
    const dep = await deposit(rig, alice, 40n);
    await rig.engine.tick();
    rig.chain.mine(1);
    await rig.engine.tick();
    expect(await statusOf(dep.id)).toBe('submitted'); // 2 of 3
    const [oldEvent] = await db.prisma.chainEvent.findMany({ where: { ref: dep.ref } });
    rig.chain.reorg({ depth: 2, dropTransactions: true }); // depth - 1 blocks vanish
    const t = await rig.engine.tick();
    expect(t.index.status).toBe('rolled_back');
    expect(await statusOf(dep.id)).toBe('submitted');
    expect(
      await db.prisma.chainEvent.count({ where: { ref: dep.ref, blockHash: oldEvent?.blockHash } }),
    ).toBe(0);
    await tickUntil(
      rig.engine,
      async () => (await statusOf(dep.id)) === 'confirmed',
      10,
      () => {
        rig.chain.mine(1);
        rig.clock.advance(31_000);
      },
    );
    const row = await opRow(db.prisma, dep.id);
    const [newEvent] = await db.prisma.chainEvent.findMany({ where: { ref: dep.ref } });
    expect(row.status).toBe('confirmed');
    expect(row.confirmedBlock).toBe(newEvent?.blockNumber);
    expect(newEvent?.blockHash).not.toBe(oldEvent?.blockHash);
    expect(rig.chain.balanceOf(alice.wallet as `0x${string}`)).toBe(40n);
    expect(await balanceOf(db.prisma, alice.available)).toBe(40n);
  });

  it('a stale event from an orphaned block (index not yet rolled back) never confirms: hashes come from the node', async () => {
    const rig = await makeRig(db.prisma, { confirmationDepth: 2 });
    const alice = await verifiedUser(rig);
    const dep = await deposit(rig, alice, 41n);
    await rig.engine.dispatcher.runOnce();
    await rig.engine.indexer.runOnce();
    rig.chain.reorg({ depth: 1, dropTransactions: true });
    rig.chain.mine(3);
    const m = await rig.engine.monitor.runOnce();
    expect(m.confirmed).toBe(0);
    expect(await statusOf(dep.id)).toBe('submitted');
  });
});

describe('deployment binding and alarms (obligations 10, 17)', () => {
  it("another deployment's failed operation is never touched (its evidence lives on another contract)", async () => {
    const rigA = await makeRig(db.prisma, {}, { automine: false });
    const rigB = await makeRig(db.prisma);
    const alice = await verifiedUser(rigA);
    rigA.chain.mine();
    const dep = await deposit(rigA, alice, 8n);
    await rigA.engine.tick();
    await operatorFail(dep.id); // the attempt is still in A's pool
    const failed = await opRow(db.prisma, dep.id);
    expect(failed.status).toBe('failed');
    const m = await rigB.engine.monitor.runOnce();
    expect(m.reversed).toBe(0);
    expect(await opRow(db.prisma, dep.id)).toEqual(failed);
    expect(rigB.alarms.ofKind('foreign_deployment').length).toBeGreaterThan(0);
  });

  it('a node on another chain id: nothing is decided, chain_mismatch is raised', async () => {
    const rig = await makeRig(db.prisma);
    const original = rig.chain.getChainId.bind(rig.chain);
    rig.chain.getChainId = async () => 1;
    const m = await rig.engine.monitor.runOnce();
    rig.chain.getChainId = original;
    expect(m.ran).toBe(false);
    expect(rig.alarms.ofKind('chain_mismatch')).toHaveLength(1);
  });

  it('obligation 10: a head that stops advancing raises head_stalled', async () => {
    const rig = await makeRig(db.prisma, { headStallTicks: 2 }, { automine: false });
    await rig.engine.monitor.runOnce();
    await rig.engine.monitor.runOnce();
    expect(rig.alarms.ofKind('head_stalled')).toHaveLength(0);
    await rig.engine.monitor.runOnce();
    expect(rig.alarms.ofKind('head_stalled')).toHaveLength(1);
    rig.chain.mine();
    await rig.engine.monitor.runOnce();
    expect(rig.alarms.ofKind('head_stalled')).toHaveLength(1);
  });
});

describe('submitter edges', () => {
  const ctx = () => ({ stillHolds: async () => true, signal: new AbortController().signal });

  it('a fee estimate above the cap: the row waits, nothing is signed', async () => {
    const rig = await makeRig(db.prisma, { feeCap: 1n });
    const alice = await verifiedUser(rig);
    const dep = await deposit(rig, alice, 2n);
    const r = await rig.engine.dispatcher.runOnce();
    expect(r.retried).toBe(1);
    expect(await attemptsOf(db.prisma, dep.id)).toHaveLength(0);
    expect(await statusOf(dep.id)).toBe('ledger_reserved');
  });

  it('refuses rows that are not its own, or that do not match their operation', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await verifiedUser(rig);
    const dep = await deposit(rig, alice, 2n);
    const row = await db.prisma.outboxMessage.findFirstOrThrow({ where: { operationId: dep.id } });
    const s = rig.engine.submitter;
    expect(await s.handle({ ...row, signer: 'compliance' }, ctx())).toEqual({
      failed: 'not_a_settlement_row',
    });
    expect(await s.handle({ ...row, operationId: null }, ctx())).toEqual({
      failed: 'not_a_settlement_row',
    });
    expect(await s.handle({ ...row, operationId: randomUUID() }, ctx())).toEqual({
      failed: 'operation_missing',
    });
    expect(await s.handle({ ...row, call: { kind: 'mint' } }, ctx())).toMatchObject({
      failed: 'invalid_call',
    });
    expect(await s.handle({ ...row, ref: ref32() }, ctx())).toEqual({
      failed: 'reference_mismatch',
    });
    expect(await attemptsOf(db.prisma, dep.id)).toHaveLength(0);
  });

  it('a final successful receipt whose event is not indexed yet: wait and alarm, never confirm without the event', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await verifiedUser(rig);
    const dep = await deposit(rig, alice, 2n);
    await rig.engine.dispatcher.runOnce();
    await rig.engine.monitor.runOnce();
    expect(await statusOf(dep.id)).toBe('submitted');
    expect(rig.alarms.ofKind('settled_without_event')).toHaveLength(1);
  });
});

describe('each piece of reversal evidence blocks on its own (obligations 5, 6)', () => {
  /** A failed deposit with no attempt (cancelled before sending), whose reference is then consumed by an exact mint outside the bridge. */
  async function failedThenSettledOutside(rig: Rig) {
    const alice = await verifiedUser(rig);
    const dep = await deposit(rig, alice, 21n);
    await rig.engine.operations.move({
      operationId: dep.id,
      from: 'ledger_reserved',
      version: 0,
      move: { event: 'FAIL', reason: 'rejected' },
      at: rig.clock.now(),
      note: 'cancelled before sending',
    });
    const { pending } = await rig.chain.getNonce('settlement');
    await rig.chain.submit({
      signer: 'settlement',
      call: {
        kind: 'mint',
        to: alice.wallet as `0x${string}`,
        amount: 21n,
        ref: dep.ref as `0x${string}`,
      },
      nonce: pending,
      fees: await rig.chain.estimateFees(),
    });
    return { alice, dep };
  }

  it('chainHasEventForRef: an indexed, not yet final settlement blocks the reversal; it then settles late', async () => {
    const rig = await makeRig(db.prisma, { confirmationDepth: 3 });
    const { alice, dep } = await failedThenSettledOutside(rig);
    await rig.engine.indexer.runOnce();
    // Not final: the contract's flag at the final block is still false, no attempt exists.
    expect(
      await rig.chain.readReferenceUsed(
        'token',
        dep.ref as `0x${string}`,
        (await rig.chain.getHeadBlock()) - 2n,
      ),
    ).toBe(false);
    await rig.engine.monitor.runOnce();
    expect(await statusOf(dep.id)).toBe('failed');
    rig.chain.mine(2);
    await rig.engine.tick();
    expect(await statusOf(dep.id)).toBe('confirmed');
    expect(await balanceOf(db.prisma, alice.available)).toBe(21n);
  });

  it('referenceConsumedOnChain: a final consumed reference the index missed blocks the reversal, escalates (L-3) and alarms once it has waited (H-1d)', async () => {
    const rig = await makeRig(db.prisma, { confirmationDepth: 2 });
    const { dep } = await failedThenSettledOutside(rig);
    rig.chain.mine(3);
    for (let i = 0; i < 3; i += 1) await rig.engine.monitor.runOnce(); // no indexer pass
    expect(await statusOf(dep.id)).toBe('failed');
    expect(rig.alarms.ofKind('escalation').some((a) => a.operationId === dep.id)).toBe(true);
    expect(rig.alarms.ofKind('failed_not_reversible')).toHaveLength(0);
    rig.clock.advance(3_600_000);
    await rig.engine.monitor.runOnce();
    expect(rig.alarms.ofKind('failed_not_reversible').some((a) => a.operationId === dep.id)).toBe(
      true,
    );
  });

  it('chainHasEventForRef: a stale indexed event (block since reorged away, index not yet rolled back) still blocks the reversal', async () => {
    const rig = await makeRig(db.prisma, { confirmationDepth: 2 });
    const { dep } = await failedThenSettledOutside(rig);
    await rig.engine.indexer.runOnce();
    expect(await db.prisma.chainEvent.count({ where: { ref: dep.ref } })).toBe(1);
    rig.chain.reorg({ depth: 1, dropTransactions: true }); // the outside mint is gone
    rig.chain.mine(3);
    // Every other field now allows it: no attempt, reference unused at the final block. Only the
    // (stale) indexed event says "wait": reversing on the absence of evidence is what ADR 0007 forbids.
    await rig.engine.monitor.runOnce(); // no indexer pass
    expect(await statusOf(dep.id)).toBe('failed');
    // Once the index has rolled back, the evidence is complete and final: reversed.
    await rig.engine.indexer.runOnce();
    await rig.engine.monitor.runOnce();
    expect(await statusOf(dep.id)).toBe('reversed');
  });
});

describe('nonce allocation (obligation 1)', () => {
  it('a nonce recorded but never broadcast is never handed to another operation', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await verifiedUser(rig);
    const a = await deposit(rig, alice, 1n);
    rig.signer.crashNextBroadcast = new Error('died after the commit');
    await rig.engine.dispatcher.runOnce();
    const b = await deposit(rig, alice, 2n);
    await rig.engine.dispatcher.runOnce(); // A is backing off; B is handled
    const [ra] = await attemptsOf(db.prisma, a.id);
    const [rb] = await attemptsOf(db.prisma, b.id);
    expect(ra).toBeDefined();
    expect(rb).toBeDefined();
    expect(rb?.nonce).not.toBe(ra?.nonce);
    rig.clock.advance(60_000);
    await tickUntil(rig.engine, async () => (await statusOf(a.id)) === 'confirmed');
    await rig.engine.tick();
    expect(await statusOf(a.id)).toBe('confirmed');
    expect(await statusOf(b.id)).toBe('confirmed');
    expect(rig.chain.balanceOf(alice.wallet as `0x${string}`)).toBe(3n);
  });
});

describe('redaction (review: literal secrets)', () => {
  it('a configured secret in a node error never reaches the audit trail or the outbox row', async () => {
    const secret = 'test-api-key-0123456789abcdef';
    const rig = await makeRig(db.prisma, { secrets: [secret] });
    const alice = await verifiedUser(rig);
    const dep = await deposit(rig, alice, 4n);
    rig.chain.failNextSubmit(new SubmissionRejectedError(`node with key ${secret} refused`));
    await rig.engine.dispatcher.runOnce();
    const row = await db.prisma.outboxMessage.findFirstOrThrow({ where: { operationId: dep.id } });
    expect(row.status).toBe('dead');
    expect(row.lastError).toContain('submission_rejected');
    expect(row.lastError).not.toContain(secret);
    const audits = await db.prisma.auditLog.findMany({ where: { entityId: dep.id } });
    expect(audits.some((a) => JSON.stringify(a.detail).includes('broadcast rejected'))).toBe(true);
    expect(audits.every((a) => !JSON.stringify(a.detail).includes(secret))).toBe(true);
  });
});

describe('review M-1: the gateway signer must be the deployment signer', () => {
  it('a rotated key: nothing is signed, nothing is decided, nothing is reversed; signer_mismatch is raised', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await verifiedUser(rig);
    const pending = await deposit(rig, alice, 3n);
    // A failed operation that WOULD be reversible with the right key.
    const cancelled = await deposit(rig, alice, 4n);
    await rig.engine.operations.move({
      operationId: cancelled.id,
      from: 'ledger_reserved',
      version: 0,
      move: { event: 'FAIL', reason: 'rejected' },
      at: rig.clock.now(),
      note: 'cancelled',
    });
    const rotated = `0x${'5'.repeat(40)}` as `0x${string}`;
    const original = rig.chain.signerAddress.bind(rig.chain);
    rig.chain.signerAddress = (s) => (s === 'settlement' ? rotated : original(s));
    const t = await rig.engine.tick();
    expect(t.dispatch.retried).toBe(1);
    expect(t.monitor.ran).toBe(false);
    expect(await attemptsOf(db.prisma, pending.id)).toHaveLength(0);
    expect(await statusOf(pending.id)).toBe('ledger_reserved');
    expect(await statusOf(cancelled.id)).toBe('failed');
    expect(rig.alarms.ofKind('signer_mismatch').length).toBeGreaterThanOrEqual(2);
    expect(rig.signer.broadcasts).toHaveLength(0);

    rig.chain.signerAddress = original;
    rig.clock.advance(120_000);
    await rig.engine.tick();
    expect(await statusOf(cancelled.id)).toBe('reversed');
    expect(await statusOf(pending.id)).toBe('confirmed');
  });
});

describe('review M-4: reserved operations that never signed anything', () => {
  async function deadBeforeSigning(rig: Rig) {
    const alice = await verifiedUser(rig);
    const dep = await deposit(rig, alice, 6n);
    await db.prisma.outboxMessage.updateMany({
      where: { operationId: dep.id },
      data: { status: 'dead', lastError: 'attempts exhausted', lastErrorAt: rig.clock.now() },
    });
    return { alice, dep };
  }

  it('a dead-lettered row before signing: after orphanAfterSeconds the operation is failed and released', async () => {
    const rig = await makeRig(db.prisma);
    const { alice, dep } = await deadBeforeSigning(rig);
    await rig.engine.monitor.runOnce();
    expect(await statusOf(dep.id)).toBe('ledger_reserved'); // too young
    rig.clock.advance(601_000);
    const m = await rig.engine.monitor.runOnce();
    expect(m.released).toBe(1);
    const row = await opRow(db.prisma, dep.id);
    expect(row.status).toBe('reversed');
    expect(row.failureReason).toBe('rejected');
    expect(await balanceOf(db.prisma, alice.incoming)).toBe(0n);
    expect(rig.alarms.ofKind('orphan_released').map((a) => a.operationId)).toEqual([dep.id]);
  });

  it('the row claimed again meanwhile (or a live row at all): not released', async () => {
    const rig = await makeRig(db.prisma);
    const { dep } = await deadBeforeSigning(rig);
    await db.prisma.outboxMessage.updateMany({
      where: { operationId: dep.id },
      data: { status: 'processing', lockedBy: 'someone/1', lockedAt: rig.clock.now() },
    });
    rig.clock.advance(601_000);
    const m = await rig.engine.monitor.runOnce();
    expect(m.released).toBe(0);
    expect(await statusOf(dep.id)).toBe('ledger_reserved');
  });

  it('the reference already consumed on chain: failed, NOT released (never reverse on missing evidence)', async () => {
    const rig = await makeRig(db.prisma);
    const { alice, dep } = await deadBeforeSigning(rig);
    const { pending } = await rig.chain.getNonce('settlement');
    await rig.chain.submit({
      signer: 'settlement',
      call: {
        kind: 'mint',
        to: alice.wallet as `0x${string}`,
        amount: 6n,
        ref: dep.ref as `0x${string}`,
      },
      nonce: pending,
      fees: await rig.chain.estimateFees(),
    });
    rig.clock.advance(601_000);
    const m = await rig.engine.monitor.runOnce();
    expect(m.released).toBe(0);
    expect(await statusOf(dep.id)).toBe('failed'); // visible, held, and never released
    await rig.engine.monitor.runOnce();
    expect(await statusOf(dep.id)).toBe('failed');
    expect(rig.alarms.ofKind('escalation').some((a) => a.operationId === dep.id)).toBe(true);
  });
});

describe('review L-1, L-2: stalls and isolation', () => {
  it('an unreachable node raises node_unreachable after headStallTicks failed passes', async () => {
    const rig = await makeRig(db.prisma, { headStallTicks: 2 });
    rig.chain.setUnavailable(true);
    await rig.engine.monitor.runOnce();
    expect(rig.alarms.ofKind('node_unreachable')).toHaveLength(0);
    await rig.engine.monitor.runOnce();
    expect(rig.alarms.ofKind('node_unreachable')).toHaveLength(1);
    rig.chain.setUnavailable(false);
  });

  it('a throwing component does not stop the others; component_failed is raised', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await verifiedUser(rig);
    const dep = await deposit(rig, alice, 2n);
    await rig.engine.tick(); // confirmed normally
    const dep2 = await deposit(rig, alice, 3n);
    const broken = jest
      .spyOn(rig.engine.indexer, 'runOnce')
      .mockRejectedValueOnce(new Error('indexer bug'));
    const t = await rig.engine.tick();
    broken.mockRestore();
    expect(t.failed).toEqual(['index']);
    expect(t.dispatch.done).toBe(1);
    expect(t.monitor.ran).toBe(true);
    expect(rig.alarms.ofKind('component_failed')[0]?.detail).toContain('indexer bug');
    await rig.engine.tick();
    expect(await statusOf(dep.id)).toBe('confirmed');
    expect(await statusOf(dep2.id)).toBe('confirmed');
  });
});

describe('review M-3: signed bytes are verified before they are stored', () => {
  it('a signer returning bytes for another nonce: refused, nothing stored, nothing sent', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await verifiedUser(rig);
    const dep = await deposit(rig, alice, 5n);
    rig.chain.tamper = async (_signed, request) =>
      new SpyChain({ chainId: rig.chain.chainId }).signTransaction({
        ...request,
        nonce: request.nonce + 7,
      });
    const r = await rig.engine.dispatcher.runOnce();
    expect(r.retried).toBe(1);
    const row = await db.prisma.outboxMessage.findFirstOrThrow({ where: { operationId: dep.id } });
    expect(row.lastError).toContain('SignedTransactionMismatchError');
    expect(await attemptsOf(db.prisma, dep.id)).toHaveLength(0);
    expect(await statusOf(dep.id)).toBe('ledger_reserved');
    expect(rig.signer.broadcasts).toHaveLength(0);
    rig.chain.tamper = undefined;
    rig.clock.advance(60_000);
    await rig.engine.tick();
    expect(await statusOf(dep.id)).toBe('confirmed');
  });

  it('a nonce taken while signing outside the lock: the signature is discarded and the next nonce signed', async () => {
    const rig = await makeRig(db.prisma);
    const other = rig.makeEngine({ workerId: 'second-worker' });
    const alice = await verifiedUser(rig);
    const a = await deposit(rig, alice, 1n);
    rig.clock.advance(1);
    const b = await deposit(rig, alice, 2n);
    // While A is being signed (no lock held), a second worker signs and commits B.
    rig.chain.onSign = async () => {
      await other.dispatcher.runOnce();
    };
    await rig.engine.dispatcher.runOnce();
    const [ra] = await attemptsOf(db.prisma, a.id);
    const [rb] = await attemptsOf(db.prisma, b.id);
    expect(await attemptsOf(db.prisma, a.id)).toHaveLength(1);
    expect(ra?.nonce).not.toBe(rb?.nonce);
    // The stored bytes carry the stored nonce (never bytes signed for a nonce someone else took).
    const inspector = new FakeTransactionInspector(rig.chain);
    for (const at of [ra, rb]) {
      const decoded = await inspector.decode(at?.rawTransaction as `0x${string}`);
      expect(decoded.nonce).toBe(at?.nonce);
    }
    await rig.engine.tick();
    expect(await statusOf(a.id)).toBe('confirmed');
    expect(await statusOf(b.id)).toBe('confirmed');
  });
});

describe('review M-2: the gateway deployment must be the active deployment', () => {
  it('a gateway on another token: tick() refuses to run and raises deployment_mismatch', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await verifiedUser(rig);
    const dep = await deposit(rig, alice, 5n);
    const wrong = new SpyChain({ chainId: rig.chain.chainId, tokenAddress: `0x${'4'.repeat(40)}` });
    const alarms = new AlarmLog();
    const engine = new BridgeEngine(
      {
        prisma: db.prisma,
        gateway: wrong,
        inspector: new FakeTransactionInspector(wrong),
        clock: rig.clock,
        ids: new RecordingIds(),
        alarms,
      },
      configFor(wrong),
    );
    await expect(engine.tick()).rejects.toBeInstanceOf(DeploymentMismatchError);
    expect(alarms.ofKind('deployment_mismatch')).toHaveLength(1);
    expect(await attemptsOf(db.prisma, dep.id)).toHaveLength(0);
    expect(wrong.broadcasts).toHaveLength(0);
  });

  it('a gateway with the right token but another registry: refused as well', async () => {
    const rig = await makeRig(db.prisma);
    const wrong = new SpyChain({
      chainId: rig.chain.chainId,
      tokenAddress: rig.chain.tokenAddress,
      registryAddress: `0x${'3'.repeat(40)}`,
    });
    const engine = new BridgeEngine(
      {
        prisma: db.prisma,
        gateway: wrong,
        inspector: new FakeTransactionInspector(wrong),
        clock: rig.clock,
        ids: new RecordingIds(),
      },
      configFor(wrong),
    );
    await expect(engine.tick()).rejects.toBeInstanceOf(DeploymentMismatchError);
    await expect(engine.monitor.runOnce()).rejects.toBeInstanceOf(DeploymentMismatchError);
    await expect(engine.indexer.runOnce()).rejects.toBeInstanceOf(DeploymentMismatchError);
  });

  it('configured chain or token disagreeing with the gateway refuses construction; case is normalised', () => {
    const chain = new SpyChain({ chainId: 5150 });
    const deps = {
      prisma: db.prisma,
      gateway: chain,
      inspector: new FakeTransactionInspector(chain),
      clock: new FakeClock(),
      ids: new RecordingIds(),
    };
    expect(
      () => new BridgeEngine(deps, { ...configFor(chain), tokenAddress: `0x${'2'.repeat(40)}` }),
    ).toThrow(DeploymentMismatchError);
    expect(() => new BridgeEngine(deps, { ...configFor(chain), chainId: 1n })).toThrow(
      DeploymentMismatchError,
    );
    expect(
      () =>
        new BridgeEngine(deps, {
          ...configFor(chain),
          tokenAddress: chain.tokenAddress.toUpperCase().replace('0X', '0x'),
        }),
    ).not.toThrow();
    expect(() => new BridgeEngine(deps, { ...configFor(chain), tokenAddress: 'nope' })).toThrow(
      InvalidRequestError,
    );
  });
});
