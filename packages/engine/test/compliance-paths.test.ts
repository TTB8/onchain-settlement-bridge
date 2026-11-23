/**
 * Piece C, compliance: every attempt path of the compliance monitor (the same rules an operation
 * follows: bump, rebroadcast, same-nonce replacement, give-up only on a final nonce, a nonce taken
 * by something else, a revert, an orphan, a signer mismatch, a skipped read), the submitter's
 * refusals, `moveComplianceChange`'s evidence gate and the signer router.
 */

import { randomUUID } from 'node:crypto';

import { ChainUnavailableError, type Receipt } from '@bridge/chain';
import type { ComplianceChange, OutboxMessage } from '@bridge/db';

import {
  ComplianceSubmitter,
  ComplianceVersionConflictError,
  EvidenceRefusedError,
  IllegalTransitionError,
  LeaseLostError,
  moveComplianceChange,
  type OutboxHandler,
  SignerRouter,
} from '../src';
import { createTestDatabase, type TestDatabase } from './support/database';
import { insertUser, type TestUser } from './support/fixtures';
import { FakeTransactionInspector, makeRig, ref32, type Rig } from './support/bridge';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

function changeRow(id: string): Promise<ComplianceChange> {
  return db.prisma.complianceChange.findUniqueOrThrow({ where: { id } });
}

function attemptsOfChange(id: string) {
  return db.prisma.chainAttempt.findMany({
    where: { outbox: { complianceChangeId: id } },
    orderBy: [{ nonce: 'asc' }, { bumpsSoFar: 'asc' }, { submittedAt: 'asc' }],
  });
}

async function freeze(rig: Rig, u: TestUser) {
  return (
    await rig.engine.compliance.requestFreeze({
      address: u.wallet,
      reason: 'sanctions hit',
      idempotencyKey: randomUUID(),
      requestedBy: 'ops',
    })
  ).change;
}

const context = {
  stillHolds: async () => true,
  signal: new AbortController().signal,
};

describe('attempt paths of the compliance monitor', () => {
  it('stuck: a same-nonce fee bump (SUBMIT bump), then confirmed', async () => {
    const rig = await makeRig(db.prisma, { stuckAfterSeconds: 60 }, { automine: false });
    const u = await insertUser(db.prisma);
    rig.chain.mine();
    const change = await freeze(rig, u);
    await rig.engine.tick();
    const [first] = await attemptsOfChange(change.id);
    rig.chain.setBaseFee((first?.maxFeePerGas ?? 0n) + 1n);
    rig.chain.mine();
    rig.clock.advance(61_000);
    const t = await rig.engine.tick();
    expect(t.compliance.bumped).toBe(1);
    const attempts = await attemptsOfChange(change.id);
    expect(attempts.map((a) => [a.nonce, a.bumpsSoFar])).toEqual([
      [first?.nonce, 0],
      [first?.nonce, 1],
    ]);
    expect(attempts[1]?.contractAddress).toBe(rig.chain.registryAddress);
    rig.chain.mine();
    await rig.engine.tick();
    expect((await changeRow(change.id)).status).toBe('confirmed');
  });

  it('dropped: the same bytes are rebroadcast once dropRetrySeconds passed (counted), then confirmed', async () => {
    const rig = await makeRig(db.prisma, {}, { automine: false });
    const u = await insertUser(db.prisma);
    rig.chain.mine();
    const change = await freeze(rig, u);
    await rig.engine.tick();
    const [attempt] = await attemptsOfChange(change.id);
    rig.chain.dropTransaction(attempt?.hash as `0x${string}`);
    await rig.engine.tick(); // too soon: patience is time
    expect((await changeRow(change.id)).resubmitsSoFar).toBe(0);
    rig.clock.advance(31_000);
    const t = await rig.engine.tick();
    expect(t.compliance.resubmitted).toBe(1);
    expect(rig.chain.mempoolHashes()).toEqual([attempt?.hash]);
    rig.chain.mine();
    await rig.engine.tick();
    const row = await changeRow(change.id);
    expect(row.status).toBe('confirmed');
    expect(row.resubmitsSoFar).toBe(1);
    expect(await attemptsOfChange(change.id)).toHaveLength(1);
  });

  it('dropped below the base fee: a same-nonce replacement at current fees; above the cap: nonce_stuck', async () => {
    const rig = await makeRig(db.prisma, {}, { automine: false });
    const u = await insertUser(db.prisma);
    rig.chain.mine();
    const change = await freeze(rig, u);
    await rig.engine.tick();
    const [first] = await attemptsOfChange(change.id);
    rig.chain.setBaseFee((first?.maxFeePerGas ?? 0n) * 2n);
    rig.chain.dropTransaction(first?.hash as `0x${string}`);
    rig.clock.advance(31_000);
    const t = await rig.engine.tick();
    expect(t.compliance.bumped).toBe(1);
    rig.chain.mine();
    await rig.engine.tick();
    expect((await changeRow(change.id)).status).toBe('confirmed');

    const other = await freeze(rig, await insertUser(db.prisma));
    await rig.engine.tick();
    const [a] = await attemptsOfChange(other.id);
    rig.chain.setBaseFee(10n ** 13n); // above the 10^12 fee cap
    rig.chain.dropTransaction(a?.hash as `0x${string}`);
    rig.clock.advance(31_000);
    await rig.engine.tick();
    expect(rig.alarms.ofKind('nonce_stuck').map((x) => x.complianceChangeId)).toContain(other.id);
    expect((await changeRow(other.id)).status).toBe('submitted');
  });

  it('give up: never FAILed while the nonce is not final (nonce_stuck); a nonce taken by another transaction, final: FAIL', async () => {
    const rig = await makeRig(
      db.prisma,
      { maxResubmits: 0, confirmationDepth: 2 },
      { automine: false },
    );
    const u = await insertUser(db.prisma);
    rig.chain.mine();
    const change = await freeze(rig, u);
    await rig.engine.tick();
    const [attempt] = await attemptsOfChange(change.id);
    const hash = attempt?.hash as `0x${string}`;
    rig.chain.dropTransaction(hash);
    rig.clock.advance(31_000);
    await rig.engine.tick(); // no counted resubmits: rebroadcast uncounted
    expect(rig.chain.mempoolHashes()).toEqual([hash]);
    rig.chain.dropTransaction(hash);
    rig.clock.advance(300_000);
    await rig.engine.tick();
    expect((await changeRow(change.id)).status).toBe('submitted');
    expect(rig.alarms.ofKind('nonce_stuck').map((x) => x.complianceChangeId)).toContain(change.id);
    rig.chain.dropTransaction(hash);
    // An operator's transaction from the compliance key takes the nonce.
    await rig.chain.submit({
      signer: 'compliance',
      call: {
        kind: 'setVerified',
        account: u.wallet as `0x${string}`,
        verified: true,
        ref: ref32(),
      },
      nonce: attempt?.nonce ?? 0,
      fees: { maxFeePerGas: 10n ** 10n, maxPriorityFeePerGas: 10n ** 9n },
    });
    rig.chain.mine(2);
    await rig.engine.tick();
    const row = await changeRow(change.id);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe('retries_exhausted');
    expect(rig.chain.registryReferenceUsed(change.ref as `0x${string}`)).toBe(false);
  });

  it('replaced: every nonce finally used elsewhere, the reference unused: a NEW nonce, then confirmed', async () => {
    const rig = await makeRig(db.prisma, { maxResubmits: 2 }, { automine: false });
    const u = await insertUser(db.prisma);
    rig.chain.mine();
    const change = await freeze(rig, u);
    await rig.engine.tick();
    const [attempt] = await attemptsOfChange(change.id);
    rig.chain.dropTransaction(attempt?.hash as `0x${string}`);
    await rig.chain.submit({
      signer: 'compliance',
      call: {
        kind: 'setVerified',
        account: u.wallet as `0x${string}`,
        verified: true,
        ref: ref32(),
      },
      nonce: attempt?.nonce ?? 0,
      fees: { maxFeePerGas: 10n ** 10n, maxPriorityFeePerGas: 10n ** 9n },
    });
    rig.chain.mine();
    const t = await rig.engine.tick();
    expect(t.compliance.resubmitted).toBe(1);
    const attempts = await attemptsOfChange(change.id);
    expect(attempts.map((a) => a.nonce)).toEqual([attempt?.nonce, (attempt?.nonce ?? 0) + 1]);
    rig.chain.mine();
    await rig.engine.tick();
    expect((await changeRow(change.id)).status).toBe('confirmed');
  });

  it('a final revert FAILs: reverted, or duplicate_reference escalated (never confirmed from a receipt)', async () => {
    for (const reason of ['SomethingElse', 'ReferenceAlreadyUsed']) {
      const rig = await makeRig(db.prisma);
      const u = await insertUser(db.prisma);
      const change = await freeze(rig, u);
      const original = rig.chain.getReceipt.bind(rig.chain);
      rig.chain.getReceipt = async (hash): Promise<Receipt | null> => {
        const r = await original(hash);
        return r === null ? null : { ...r, status: 'reverted', revertReason: reason };
      };
      await rig.engine.dispatcher.runOnce();
      // Index nothing: the monitor sees only the (reverted) receipt.
      await rig.engine.complianceMonitor.runOnce();
      rig.chain.getReceipt = original;
      const row = await changeRow(change.id);
      expect(row.status).toBe('failed');
      expect(row.failureReason).toBe(
        reason === 'ReferenceAlreadyUsed' ? 'duplicate_reference' : 'reverted',
      );
    }
  });

  it('a final successful receipt without an indexed event is NOT a confirmation (alarm); missing attempts are alarmed', async () => {
    const rig = await makeRig(db.prisma);
    const u = await insertUser(db.prisma);
    const change = await freeze(rig, u);
    await rig.engine.dispatcher.runOnce(); // mined, never indexed
    await rig.engine.complianceMonitor.runOnce();
    expect((await changeRow(change.id)).status).toBe('submitted');
    expect(rig.alarms.ofKind('settled_without_event').map((a) => a.complianceChangeId)).toContain(
      change.id,
    );

    const ghost = await freeze(rig, await insertUser(db.prisma));
    await db.prisma.outboxMessage.updateMany({
      where: { complianceChangeId: ghost.id },
      data: { status: 'dead' },
    });
    await db.prisma.complianceChange.update({
      where: { id: ghost.id },
      data: { status: 'submitted', version: 1 },
    });
    await rig.engine.complianceMonitor.runOnce();
    expect(rig.alarms.ofKind('missing_attempts').map((a) => a.complianceChangeId)).toContain(
      ghost.id,
    );
  });

  it('a failed change with a conflicting event stays failed and is alarmed again (escalation, never reversed or confirmed)', async () => {
    const rig = await makeRig(db.prisma, {}, { automine: false });
    const u = await insertUser(db.prisma);
    const victim = await insertUser(db.prisma);
    rig.chain.mine();
    const change = await freeze(rig, u);
    await rig.engine.tick();
    const [ours] = await attemptsOfChange(change.id);
    await rig.chain.submit({
      signer: 'compliance',
      call: {
        kind: 'setFrozen',
        account: victim.wallet as `0x${string}`,
        frozen: true,
        ref: change.ref as `0x${string}`,
      },
      nonce: ours?.nonce ?? 0,
      fees: { maxFeePerGas: 10n ** 11n, maxPriorityFeePerGas: 10n ** 10n },
    });
    rig.chain.mine();
    await rig.engine.tick();
    expect((await changeRow(change.id)).status).toBe('failed');
    const before = rig.alarms.ofKind('compliance_escalation').length;
    await rig.engine.tick();
    expect((await changeRow(change.id)).status).toBe('failed');
    expect(rig.alarms.ofKind('compliance_escalation').length).toBe(before + 1);
  });

  it('an orphan (requested, its outbox row dead, nothing signed) is FAILed rejected after orphanAfterSeconds', async () => {
    const rig = await makeRig(db.prisma);
    const u = await insertUser(db.prisma);
    const change = await freeze(rig, u);
    await db.prisma.outboxMessage.updateMany({
      where: { complianceChangeId: change.id },
      data: { status: 'dead' },
    });
    await rig.engine.tick();
    expect((await changeRow(change.id)).status).toBe('requested'); // too young
    rig.clock.advance(601_000);
    const t = await rig.engine.tick();
    expect(t.compliance.failed).toBe(1);
    const row = await changeRow(change.id);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe('rejected');
    expect(rig.alarms.ofKind('orphan_released').map((a) => a.complianceChangeId)).toContain(
      change.id,
    );
  });

  it('chain view: an unreachable node, another chain id or a rotated compliance key decide nothing', async () => {
    const rig = await makeRig(db.prisma);
    const u = await insertUser(db.prisma);
    const change = await freeze(rig, u);
    await rig.engine.dispatcher.runOnce();
    await rig.engine.indexer.runOnce();
    rig.chain.setUnavailable(true);
    expect((await rig.engine.complianceMonitor.runOnce()).ran).toBe(false);
    rig.chain.setUnavailable(false);
    const getChainId = rig.chain.getChainId.bind(rig.chain);
    rig.chain.getChainId = async () => 1;
    expect((await rig.engine.complianceMonitor.runOnce()).ran).toBe(false);
    rig.chain.getChainId = getChainId;
    expect(rig.alarms.ofKind('chain_mismatch').length).toBeGreaterThan(0);
    const signerAddress = rig.chain.signerAddress.bind(rig.chain);
    rig.chain.signerAddress = (s) =>
      s === 'compliance' ? `0x${'ee'.repeat(20)}` : signerAddress(s);
    expect((await rig.engine.complianceMonitor.runOnce()).ran).toBe(false);
    rig.chain.signerAddress = signerAddress;
    expect(rig.alarms.ofKind('signer_mismatch').length).toBeGreaterThan(0);
    expect((await changeRow(change.id)).status).toBe('submitted');
    expect((await rig.engine.complianceMonitor.runOnce()).confirmed).toBe(1);
  });

  it('a change whose evidence read keeps failing is skipped and alarmed (operation_skipped)', async () => {
    const rig = await makeRig(db.prisma, { skipAlarmPasses: 2 }, { automine: false });
    const u = await insertUser(db.prisma);
    rig.chain.mine();
    const change = await freeze(rig, u);
    await rig.engine.tick();
    const original = rig.chain.getReceipt.bind(rig.chain);
    rig.chain.getReceipt = async () => {
      throw new ChainUnavailableError('flaky');
    };
    const first = await rig.engine.complianceMonitor.runOnce();
    expect(first.skipped).toBe(1);
    await rig.engine.complianceMonitor.runOnce();
    rig.chain.getReceipt = original;
    expect(rig.alarms.ofKind('operation_skipped').map((a) => a.complianceChangeId)).toContain(
      change.id,
    );
  });
});

describe('ComplianceSubmitter refusals', () => {
  it('refuses a non-compliance row, a call that is not the change, an undecodable call; waits on a signer mismatch or the fee cap', async () => {
    const rig = await makeRig(db.prisma);
    const u = await insertUser(db.prisma);
    const change = await freeze(rig, u);
    const row: OutboxMessage = await db.prisma.outboxMessage.findFirstOrThrow({
      where: { complianceChangeId: change.id },
    });
    const s = rig.engine.complianceSubmitter;
    expect(await s.handle({ ...row, signer: 'settlement' }, context)).toEqual({
      failed: 'not_a_compliance_row',
    });
    expect(
      await s.handle(
        { ...row, call: { ...(row.call as object), account: `0x${'99'.repeat(20)}` } },
        context,
      ),
    ).toEqual({ failed: 'call_mismatch' });
    expect(
      await s.handle({ ...row, call: { ...(row.call as object), kind: 'setVerified' } }, context),
    ).toMatchObject({ failed: 'invalid_call' });
    expect(await s.handle({ ...row, ref: ref32() }, context)).toEqual({ failed: 'call_mismatch' });

    const signerAddress = rig.chain.signerAddress.bind(rig.chain);
    rig.chain.signerAddress = (x) =>
      x === 'compliance' ? `0x${'ee'.repeat(20)}` : signerAddress(x);
    expect(await s.handle(row, context)).toHaveProperty('retryAt');
    rig.chain.signerAddress = signerAddress;
    expect(rig.alarms.ofKind('signer_mismatch').map((a) => a.complianceChangeId)).toContain(
      change.id,
    );

    const capped = new ComplianceSubmitter({
      prisma: db.prisma,
      gateway: rig.chain,
      inspector: new FakeTransactionInspector(rig.chain),
      clock: rig.clock,
      fees: { marginBps: 2_000, feeCap: 1n, feeWaitMs: 5_000 },
    });
    expect(await capped.handle(row, context)).toHaveProperty('retryAt');
    expect(await attemptsOfChange(change.id)).toHaveLength(0);
  });
});

describe('ComplianceSubmitter: lease fence and FAIL racing the attempt commit (review L-B)', () => {
  it('a lease taken over while signing rolls the attempt back and sends nothing', async () => {
    const rig = await makeRig(db.prisma);
    const change = await freeze(rig, await insertUser(db.prisma));
    await db.prisma.outboxMessage.updateMany({
      where: { complianceChangeId: change.id },
      data: { status: 'processing', lockedBy: 'me/1', lockedAt: rig.clock.now() },
    });
    const row = await db.prisma.outboxMessage.findFirstOrThrow({
      where: { complianceChangeId: change.id },
    });
    await db.prisma.outboxMessage.updateMany({
      where: { id: row.id },
      data: { lockedBy: 'other/2' },
    });
    await expect(rig.engine.complianceSubmitter.handle(row, context)).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    expect(await attemptsOfChange(change.id)).toHaveLength(0);
    expect((await changeRow(change.id)).status).toBe('requested');
    expect(rig.signer.broadcasts).toHaveLength(0);
  });

  it('a FAIL committed while the bytes were being signed: the fence sees the cancelled row, nothing stored or sent', async () => {
    const rig = await makeRig(db.prisma);
    const change = await freeze(rig, await insertUser(db.prisma));
    await db.prisma.outboxMessage.updateMany({
      where: { complianceChangeId: change.id },
      data: { status: 'processing', lockedBy: 'me/1', lockedAt: rig.clock.now() },
    });
    const row = await db.prisma.outboxMessage.findFirstOrThrow({
      where: { complianceChangeId: change.id },
    });
    rig.signer.onSign = async () => {
      await db.prisma.$transaction((tx) =>
        moveComplianceChange(tx, {
          changeId: change.id,
          from: 'requested',
          version: 0,
          move: { event: 'FAIL', reason: 'rejected' },
          at: rig.clock.now(),
          note: 'operator cancelled',
        }),
      );
    };
    await expect(rig.engine.complianceSubmitter.handle(row, context)).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    expect(await attemptsOfChange(change.id)).toHaveLength(0);
    expect((await changeRow(change.id)).status).toBe('failed');
    expect(rig.signer.broadcasts).toHaveLength(0);
  });
});

describe('moveComplianceChange: the domain table and the evidence gate', () => {
  it('refuses forged confirmations, illegal edges and stale versions, before or at the write', async () => {
    const rig = await makeRig(db.prisma);
    const change = await freeze(rig, await insertUser(db.prisma));
    const at = rig.clock.now();
    const move = (input: Parameters<typeof moveComplianceChange>[1]) =>
      db.prisma.$transaction((tx) => moveComplianceChange(tx, input));
    await expect(
      move({
        changeId: change.id,
        from: 'submitted',
        version: 0,
        move: { event: 'CONFIRM', judgement: { verdict: 'wait' }, confirmedBlock: 1n },
        at,
        note: 'forged',
      }),
    ).rejects.toBeInstanceOf(EvidenceRefusedError);
    await expect(
      move({
        changeId: change.id,
        from: 'requested',
        version: 0,
        move: {
          event: 'CONFIRM',
          judgement: { verdict: 'confirm', event: 'CONFIRM' },
          confirmedBlock: 1n,
        },
        at,
        note: 'skip',
      }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    await expect(
      move({
        changeId: change.id,
        from: 'submitted',
        version: 0,
        move: { event: 'SUBMIT', kind: 'first' },
        at,
        note: 'x',
      }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    await expect(
      move({
        changeId: change.id,
        from: 'submitted',
        version: 0,
        move: {
          event: 'CONFIRM_LATE',
          judgement: { verdict: 'confirm', event: 'CONFIRM' },
          confirmedBlock: 1n,
        },
        at,
        note: 'late from submitted',
      }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    await expect(
      move({
        changeId: change.id,
        from: 'failed',
        version: 0,
        move: { event: 'CONFIRM_LATE', judgement: { verdict: 'conflict' }, confirmedBlock: 1n },
        at,
        note: 'late conflict',
      }),
    ).rejects.toBeInstanceOf(EvidenceRefusedError);
    await expect(
      move({
        changeId: change.id,
        from: 'requested',
        version: 7,
        move: { event: 'FAIL', reason: 'rejected' },
        at,
        note: 'stale',
      }),
    ).rejects.toBeInstanceOf(ComplianceVersionConflictError);
    // A FAIL before anything was signed kills the live outbox row in the same transaction.
    await move({
      changeId: change.id,
      from: 'requested',
      version: 0,
      move: { event: 'FAIL', reason: 'rejected' },
      at,
      note: 'operator cancelled',
    });
    const [row] = await db.prisma.outboxMessage.findMany({
      where: { complianceChangeId: change.id },
    });
    expect(row?.status).toBe('dead');
    expect(row?.lastError).toMatch(/cancelled/);
  });
});

describe('SignerRouter', () => {
  it('routes by signer and fails closed for a signer without a handler', async () => {
    const seen: string[] = [];
    const handler = (name: string): OutboxHandler => ({
      handle: async () => {
        seen.push(name);
        return 'done';
      },
    });
    const router = new SignerRouter({ settlement: handler('s'), compliance: handler('c') });
    const row = { signer: 'compliance' } as OutboxMessage;
    expect(await router.handle(row, context)).toBe('done');
    expect(await router.handle({ ...row, signer: 'settlement' }, context)).toBe('done');
    expect(seen).toEqual(['c', 's']);
    const partial = new SignerRouter({ settlement: handler('s') } as never);
    expect(await partial.handle(row, context)).toEqual({ failed: 'no_handler_for_signer' });
  });
});
