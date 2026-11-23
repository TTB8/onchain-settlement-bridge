/**
 * Piece C, compliance: ComplianceService -> outbox -> ComplianceSubmitter -> ComplianceMonitor,
 * on real Postgres with the FakeChainGateway, through `tick()`. Each test names the rule it pins:
 * one transaction per request with idempotency per requester; persist-before-broadcast with the
 * registry as `to`; unknown outcome = same bytes again; a rejected attempt still counts; a change
 * is confirmed ONLY by a final, canonical registry event bound to its reference (never a stale
 * event, never an event under another reference); a front-run under our reference escalates;
 * and the frozen-mid-operation rule end to end with the exact ledger.
 */

import { randomUUID } from 'node:crypto';

import { ChainUnavailableError, SubmissionRejectedError } from '@bridge/chain';
import type { ComplianceChange } from '@bridge/db';

import {
  type ComplianceRequestKind,
  ComplianceIdempotencyConflictError,
  ComplianceService,
  DeploymentMismatchError,
  InvalidRequestError,
  NoActiveDeploymentError,
  UnknownUserError,
} from '../src';
import { createTestDatabase, type TestDatabase } from './support/database';
import { balanceOf, insertUser, RecordingIds, type TestUser } from './support/fixtures';
import { makeRig, opRow, ref32, type Rig, tickUntil } from './support/bridge';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

const OPERATOR = 'ops-alice';

/** One compliance request through the engine's service. */
function request(rig: Rig, kind: ComplianceRequestKind, u: TestUser, key = randomUUID()) {
  return rig.engine.compliance.request(kind, {
    address: u.wallet,
    reason: `${kind}: case file 42`,
    idempotencyKey: key,
    requestedBy: OPERATOR,
  });
}

function changeRow(id: string): Promise<ComplianceChange> {
  return db.prisma.complianceChange.findUniqueOrThrow({ where: { id } });
}

function attemptsOfChange(id: string) {
  return db.prisma.chainAttempt.findMany({
    where: { outbox: { complianceChangeId: id } },
    orderBy: [{ nonce: 'asc' }, { bumpsSoFar: 'asc' }, { submittedAt: 'asc' }],
  });
}

/** A user allowed on chain through the bridge (request -> tick -> confirmed). */
async function allowedUser(rig: Rig): Promise<TestUser> {
  const u = await insertUser(db.prisma);
  const { change } = await request(rig, 'allow', u);
  await tickUntil(rig.engine, async () => (await changeRow(change.id)).status === 'confirmed');
  expect((await changeRow(change.id)).status).toBe('confirmed');
  return u;
}

/** A person FAILs a submitted compliance change (its attempts stay recorded). */
async function operatorFailChange(id: string): Promise<void> {
  const c = await changeRow(id);
  await db.prisma.complianceChange.update({
    where: { id },
    data: { status: 'failed', failureReason: 'retries_exhausted', version: c.version + 1 },
  });
}

describe('happy paths through tick(): allow, freeze, unfreeze, disallow', () => {
  it('each change is signed once, sent to the registry, confirmed at its FINAL event block, and the registry holds it', async () => {
    const rig = await makeRig(db.prisma, { confirmationDepth: 2 });
    const u = await insertUser(db.prisma);
    const wallet = u.wallet as `0x${string}`;

    const allow = await request(rig, 'allow', u);
    expect(allow.replayed).toBe(false);
    expect(allow.change.status).toBe('requested');
    const outbox = await db.prisma.outboxMessage.findMany({
      where: { complianceChangeId: allow.change.id },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.signer).toBe('compliance');
    expect(outbox[0]?.call).toEqual({
      kind: 'setVerified',
      account: wallet,
      verified: true,
      ref: allow.change.ref,
    });

    const t1 = await rig.engine.tick();
    expect(t1.dispatch.done).toBe(1);
    // One confirmation of two: not final yet, so not confirmed.
    expect((await changeRow(allow.change.id)).status).toBe('submitted');
    rig.chain.mine();
    const t2 = await rig.engine.tick();
    expect(t2.compliance.confirmed).toBe(1);
    const row = await changeRow(allow.change.id);
    const [event] = await db.prisma.chainEvent.findMany({ where: { ref: allow.change.ref } });
    expect(row.status).toBe('confirmed');
    expect(row.confirmedBlock).toBe(event?.blockNumber);
    expect(row.confirmedBlock).not.toBe(await rig.chain.getHeadBlock());
    expect(rig.chain.complianceOf(wallet)).toEqual({ verified: true, frozen: false });
    const [attempt] = await attemptsOfChange(allow.change.id);
    expect(attempt?.contractAddress).toBe(rig.chain.registryAddress);
    expect(attempt?.signer).toBe('compliance');
    expect(await attemptsOfChange(allow.change.id)).toHaveLength(1);

    for (const [kind, expected] of [
      ['freeze', { verified: true, frozen: true }],
      ['unfreeze', { verified: true, frozen: false }],
      ['disallow', { verified: false, frozen: false }],
    ] as const) {
      const { change } = await request(rig, kind, u);
      await tickUntil(
        rig.engine,
        async () => (await changeRow(change.id)).status === 'confirmed',
        5,
        () => {
          rig.chain.mine();
        },
      );
      expect((await changeRow(change.id)).status).toBe('confirmed');
      expect(rig.chain.complianceOf(wallet)).toEqual(expected);
    }
    const audit = await db.prisma.auditLog.findMany({
      where: { entity: 'compliance_change', entityId: allow.change.id },
      orderBy: { id: 'asc' },
    });
    expect(audit.map((a) => `${a.fromState}>${a.toState}`)).toEqual([
      'null>requested',
      'requested>submitted',
      'submitted>confirmed',
    ]);
  });
});

describe('ComplianceService: one transaction, idempotent per requester, fail closed', () => {
  it('a replay with the same key and content writes nothing; other content is a conflict; another requester may reuse the key', async () => {
    const rig = await makeRig(db.prisma);
    const u = await insertUser(db.prisma);
    const key = randomUUID();
    const first = await request(rig, 'freeze', u, key);
    const again = await request(rig, 'freeze', u, key);
    expect(again.replayed).toBe(true);
    expect(again.change.id).toBe(first.change.id);
    expect(
      await db.prisma.outboxMessage.count({ where: { complianceChangeId: first.change.id } }),
    ).toBe(1);
    await expect(request(rig, 'unfreeze', u, key)).rejects.toBeInstanceOf(
      ComplianceIdempotencyConflictError,
    );
    await expect(
      rig.engine.compliance.requestFreeze({
        address: u.wallet,
        reason: 'another reason',
        idempotencyKey: key,
        requestedBy: OPERATOR,
      }),
    ).rejects.toBeInstanceOf(ComplianceIdempotencyConflictError);
    const other = await rig.engine.compliance.requestFreeze({
      address: u.wallet.toUpperCase().replace('0X', '0x'),
      reason: 'freeze: case file 42',
      idempotencyKey: key,
      requestedBy: 'ops-bob',
    });
    expect(other.replayed).toBe(false);
    expect(other.change.account).toBe(u.wallet);
  });

  it('concurrent copies of one request create exactly one change and one outbox row', async () => {
    const rig = await makeRig(db.prisma);
    const u = await insertUser(db.prisma);
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => request(rig, 'freeze', u, key)),
    );
    expect(new Set(results.map((r) => r.change.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(
      await db.prisma.complianceChange.count({
        where: { requestedBy: OPERATOR, idempotencyKey: key },
      }),
    ).toBe(1);
  });

  it('refuses a malformed request, an unknown account, no active deployment and another deployment', async () => {
    const rig = await makeRig(db.prisma);
    const u = await insertUser(db.prisma);
    const base = { address: u.wallet, reason: 'r', idempotencyKey: 'k', requestedBy: OPERATOR };
    await expect(
      rig.engine.compliance.requestAllow({ ...base, address: 'nope' }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(
      rig.engine.compliance.requestAllow({ ...base, reason: '' }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(
      rig.engine.compliance.requestAllow({ ...base, idempotencyKey: 'x'.repeat(256) }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(
      rig.engine.compliance.requestAllow({ ...base, requestedBy: '' }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(
      rig.engine.compliance.request('nuke' as ComplianceRequestKind, base),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(
      rig.engine.compliance.requestAllow({ ...base, address: `0x${'ab'.repeat(20)}` }),
    ).rejects.toBeInstanceOf(UnknownUserError);
    await expect(rig.engine.compliance.get(randomUUID())).rejects.toThrow(/no compliance change/);

    const wrongRegistry = new ComplianceService({
      prisma: db.prisma,
      clock: rig.clock,
      ids: new RecordingIds(),
      binding: {
        chainId: BigInt(rig.chain.chainId),
        tokenAddress: rig.chain.tokenAddress,
        registryAddress: `0x${'cd'.repeat(20)}`,
      },
    });
    await expect(wrongRegistry.requestAllow(base)).rejects.toBeInstanceOf(DeploymentMismatchError);
    await db.prisma.deployment.update({ where: { id: rig.deploymentId }, data: { active: false } });
    await expect(rig.engine.compliance.requestAllow(base)).rejects.toBeInstanceOf(
      NoActiveDeploymentError,
    );
    expect(
      await db.prisma.complianceChange.count({ where: { deploymentId: rig.deploymentId } }),
    ).toBe(0);
  });
});

describe('frozen address mid-operation (domain compliance rule, end to end)', () => {
  it('a withdrawal already signed when the freeze lands reverts on chain, FAILs compliance_rejected, then REVERSE releases the funds exactly', async () => {
    const rig = await makeRig(db.prisma);
    const alice = await allowedUser(rig);
    const dep = await rig.engine.operations.requestDeposit(alice.id, 100n, randomUUID());
    await tickUntil(
      rig.engine,
      async () => (await opRow(db.prisma, dep.operation.id)).status === 'confirmed',
    );
    expect(await balanceOf(db.prisma, alice.available)).toBe(100n);

    const wd = (await rig.engine.operations.requestWithdrawal(alice.id, 60n, randomUUID()))
      .operation;
    rig.clock.advance(1); // the withdrawal's outbox row is due first (rows are claimed by time)
    const freeze = await request(rig, 'freeze', alice);
    // The withdrawal is signed and recorded, but its broadcast is lost (the worker crashed):
    // it is in flight when the freeze is sent and mined.
    rig.signer.crashNextBroadcast = new Error('worker died after the commit');
    const t1 = await rig.engine.tick();
    expect(t1.dispatch.retried).toBe(1);
    expect((await opRow(db.prisma, wd.id)).status).toBe('submitted');
    expect((await changeRow(freeze.change.id)).status).toBe('confirmed');
    expect(rig.chain.complianceOf(alice.wallet as `0x${string}`).frozen).toBe(true);

    rig.clock.advance(60_000);
    await rig.engine.tick(); // the same bytes go out, and the registry makes the token revert
    const failed = await opRow(db.prisma, wd.id);
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('compliance_rejected');
    const t3 = await rig.engine.tick();
    expect(t3.monitor.reversed).toBe(1);
    expect((await opRow(db.prisma, wd.id)).status).toBe('reversed');
    expect(await balanceOf(db.prisma, alice.available)).toBe(100n);
    expect(await balanceOf(db.prisma, alice.held)).toBe(0n);
    expect(rig.chain.balanceOf(alice.wallet as `0x${string}`)).toBe(100n);
    const reverse = await db.prisma.journalEntry.findUniqueOrThrow({
      where: { operationId_kind: { operationId: wd.id, kind: 'reverse' } },
      include: { postings: true },
    });
    expect(reverse.postings.map((p) => `${p.accountId}:${p.side}:${p.amount}`).sort()).toEqual(
      [`${alice.held}:debit:60`, `${alice.available}:credit:60`].sort(),
    );
  });
});

describe('outcomes: unknown, rejected, stale, foreign reference, front-run', () => {
  it('unknown outcome, then mined: confirmed from the event, the same bytes are rebroadcast, never re-signed', async () => {
    const rig = await makeRig(db.prisma);
    const u = await insertUser(db.prisma);
    const { change } = await request(rig, 'allow', u);
    rig.chain.failNextSubmit(new ChainUnavailableError('timeout'), { accept: true });
    const t = await rig.engine.tick();
    expect(t.dispatch.retried).toBe(1);
    expect((await changeRow(change.id)).status).toBe('confirmed');
    rig.clock.advance(60_000);
    const t2 = await rig.engine.tick();
    expect(t2.dispatch.done).toBe(1);
    const attempts = await attemptsOfChange(change.id);
    expect(attempts).toHaveLength(1);
    expect(new Set(rig.signer.broadcasts)).toEqual(new Set([attempts[0]?.hash]));
  });

  it('unknown outcome and NOT taken: the retry sends the same bytes, which then mine', async () => {
    const rig = await makeRig(db.prisma);
    const u = await insertUser(db.prisma);
    const { change } = await request(rig, 'freeze', u);
    rig.chain.failNextSubmit(new ChainUnavailableError('timeout'));
    await rig.engine.tick();
    expect((await changeRow(change.id)).status).toBe('submitted');
    expect(rig.chain.registryReferenceUsed(change.ref as `0x${string}`)).toBe(false);
    rig.clock.advance(60_000);
    await rig.engine.tick();
    expect((await changeRow(change.id)).status).toBe('confirmed');
    expect(await attemptsOfChange(change.id)).toHaveLength(1);
  });

  it('rejected by our node but mined elsewhere: the attempt still counts, a failed change confirms only through the late gate', async () => {
    const rig = await makeRig(db.prisma, {}, { automine: false });
    const u = await insertUser(db.prisma);
    rig.chain.mine();
    const { change } = await request(rig, 'allow', u);
    rig.chain.failNextSubmit(new SubmissionRejectedError('invalid sender'), { accept: true });
    const t = await rig.engine.tick();
    expect(t.dispatch.dead).toBe(1);
    const [attempt] = await attemptsOfChange(change.id);
    expect(attempt?.status).toBe('dropped');
    expect(rig.chain.mempoolSize()).toBe(1);

    await operatorFailChange(change.id);
    for (let i = 0; i < 2; i += 1) await rig.engine.tick();
    expect((await changeRow(change.id)).status).toBe('failed');

    rig.chain.mine();
    const late = await rig.engine.tick();
    expect(late.compliance.lateConfirmed).toBe(1);
    const row = await changeRow(change.id);
    expect(row.status).toBe('confirmed');
    expect(row.failureReason).toBe('retries_exhausted'); // kept as history
    expect(rig.chain.complianceOf(u.wallet as `0x${string}`).verified).toBe(true);
  });

  it('a stale event from an orphaned block never confirms a change; the rebroadcast confirms at the new block', async () => {
    const rig = await makeRig(db.prisma, { confirmationDepth: 3 });
    const u = await insertUser(db.prisma);
    const { change } = await request(rig, 'freeze', u);
    await rig.engine.tick(); // mined, indexed, 1 of 3 confirmations
    const [stale] = await db.prisma.chainEvent.findMany({ where: { ref: change.ref } });
    expect(stale).toBeDefined();
    rig.chain.reorg({ depth: 1, dropTransactions: true });
    rig.chain.setAutomine(false);
    rig.chain.mine(5); // the stale event's height is now "final", but its block is not canonical
    const pass = await rig.engine.complianceMonitor.runOnce();
    expect(pass.confirmed).toBe(0);
    expect((await changeRow(change.id)).status).toBe('submitted');

    rig.clock.advance(31_000);
    await rig.engine.tick(); // indexer rolls back; the monitor rebroadcasts the dropped bytes
    rig.chain.mine(3);
    await rig.engine.tick();
    const row = await changeRow(change.id);
    expect(row.status).toBe('confirmed');
    const [fresh] = await db.prisma.chainEvent.findMany({ where: { ref: change.ref } });
    expect(fresh?.blockHash).not.toBe(stale?.blockHash);
    expect(row.confirmedBlock).toBe(fresh?.blockNumber);
    expect(await attemptsOfChange(change.id)).toHaveLength(1);
  });

  it('a final registry event for the same account and flag under ANOTHER reference never confirms the change', async () => {
    const rig = await makeRig(db.prisma, {}, { automine: false });
    const u = await insertUser(db.prisma);
    // Someone else freezes the account first, with their own reference (mined, indexed, final).
    const { pending } = await rig.chain.getNonce('compliance');
    await rig.chain.submit({
      signer: 'compliance',
      call: { kind: 'setFrozen', account: u.wallet as `0x${string}`, frozen: true, ref: ref32() },
      nonce: pending,
      fees: await rig.chain.estimateFees(),
    });
    rig.chain.mine();
    const { change } = await request(rig, 'freeze', u);
    // Ours waits in the pool (nothing is mined); the foreign event is indexed and final.
    for (let i = 0; i < 3; i += 1) await rig.engine.tick();
    expect(await db.prisma.chainEvent.count({ where: { account: u.wallet } })).toBe(1);
    expect(rig.chain.complianceOf(u.wallet as `0x${string}`).frozen).toBe(true);
    expect((await changeRow(change.id)).status).toBe('submitted');
  });

  it('a front-run under OUR reference (another account) FAILs reference_conflict and escalates; never confirmed', async () => {
    const rig = await makeRig(db.prisma, {}, { automine: false });
    const u = await insertUser(db.prisma);
    const victim = await insertUser(db.prisma);
    rig.chain.mine();
    const { change } = await request(rig, 'freeze', u);
    await rig.engine.tick(); // ours is in the pool
    const [ours] = await attemptsOfChange(change.id);
    // A compromised compliance key replaces our pooled transaction (same nonce, higher fees) with
    // a call that uses our reference for another account.
    await rig.chain.submit({
      signer: 'compliance',
      call: {
        kind: 'setFrozen',
        account: victim.wallet as `0x${string}`,
        frozen: true,
        ref: change.ref as `0x${string}`,
      },
      nonce: ours?.nonce ?? 0,
      fees: {
        maxFeePerGas: (ours?.maxFeePerGas ?? 0n) * 2n,
        maxPriorityFeePerGas: (ours?.maxPriorityFeePerGas ?? 0n) * 2n,
      },
    });
    rig.chain.mine();
    const t = await rig.engine.tick();
    expect(t.compliance.failed).toBe(1);
    const row = await changeRow(change.id);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe('reference_conflict');
    expect(rig.alarms.ofKind('compliance_escalation').map((a) => a.complianceChangeId)).toContain(
      change.id,
    );
    const escalated = await db.prisma.auditLog.findMany({
      where: { entity: 'compliance_change', entityId: change.id, toState: 'escalated' },
    });
    expect(escalated).toHaveLength(1);
  });
});
