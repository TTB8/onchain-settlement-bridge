/**
 * HTTP tests of the admin routes on a real Postgres with the fake chain: compliance requests
 * carried to the chain by the engine, reconciliation runs (clean, with a rogue transfer, unknown
 * when the node fails), readiness, and the deployment-binding refusals (503 + Retry-After).
 */

import { randomBytes } from 'node:crypto';

import request from 'supertest';

import { ADMIN, makeRig, PLATFORM, type Rig, settle, wallet } from './support/rig';

const platform = { Authorization: `Bearer ${PLATFORM}` };
const admin = { Authorization: `Bearer ${ADMIN}` };

describe('compliance and reconciliation', () => {
  let rig: Rig;
  const http = () => request(rig.app.getHttpServer());

  beforeAll(async () => {
    rig = await makeRig();
  });

  afterAll(async () => {
    await rig.close();
  });

  async function allowedUser(): Promise<{ id: string; walletAddress: string }> {
    const res = await http().post('/v1/users').set(platform).send({ walletAddress: wallet() });
    const change = await http()
      .post('/v1/admin/compliance-changes')
      .set(admin)
      .set('Idempotency-Key', `allow-${res.body.id}`)
      .send({ action: 'allow', walletAddress: res.body.walletAddress, reason: 'kyc passed' });
    expect(change.status).toBe(201);
    return res.body;
  }

  /** Ticks until settled, then once more without mining so the index reaches the final block. */
  async function settleAndIndex(): Promise<void> {
    await settle(rig, 5);
    await rig.engine.tick();
  }

  it('a compliance request is recorded, carried to the registry and confirmed', async () => {
    const res = await http().post('/v1/users').set(platform).send({ walletAddress: wallet() });
    const change = await http()
      .post('/v1/admin/compliance-changes')
      .set(admin)
      .set('Idempotency-Key', 'freeze-1')
      .send({
        action: 'allow',
        walletAddress: res.body.walletAddress.toUpperCase().replace('0X', '0x'),
        reason: 'kyc passed',
      });
    expect(change.status).toBe(201);
    expect(change.body).toMatchObject({
      action: 'verify',
      walletAddress: res.body.walletAddress,
      userId: res.body.id,
      status: 'requested',
      confirmedBlock: null,
      reason: 'kyc passed',
      requestedBy: 'admin-token',
    });
    const replay = await http()
      .post('/v1/admin/compliance-changes')
      .set(admin)
      .set('Idempotency-Key', 'freeze-1')
      .send({ action: 'allow', walletAddress: res.body.walletAddress, reason: 'kyc passed' });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(change.body.id);
    const conflict = await http()
      .post('/v1/admin/compliance-changes')
      .set(admin)
      .set('Idempotency-Key', 'freeze-1')
      .send({ action: 'freeze', walletAddress: res.body.walletAddress, reason: 'kyc passed' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.existingComplianceChangeId).toBe(change.body.id);

    await settleAndIndex();
    const read = await http().get(`/v1/admin/compliance-changes/${change.body.id}`).set(admin);
    expect(read.status).toBe(200);
    expect(read.body.status).toBe('confirmed');
    expect(read.body.confirmedBlock).toMatch(/^[0-9]+$/);
    expect(rig.chain.complianceOf(res.body.walletAddress).verified).toBe(true);
  });

  it('refuses malformed compliance requests and unknown accounts', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ action: 'ban', walletAddress: wallet(), reason: 'x' }, 'action'],
      [{ action: 'freeze', walletAddress: '0x12', reason: 'x' }, 'walletAddress'],
      [{ action: 'freeze', walletAddress: wallet(), reason: '' }, 'reason'],
      [{ action: 'freeze', walletAddress: wallet(), reason: 'r'.repeat(501) }, 'reason'],
      [
        { action: 'freeze', walletAddress: wallet(), reason: 'x', requestedBy: 'me' },
        'requestedBy',
      ],
    ];
    for (const [body, field] of cases) {
      const res = await http()
        .post('/v1/admin/compliance-changes')
        .set(admin)
        .set('Idempotency-Key', `bad-${randomBytes(4).toString('hex')}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.errors.map((e: { field: string }) => e.field)).toContain(field);
    }
    const unknown = await http()
      .post('/v1/admin/compliance-changes')
      .set(admin)
      .set('Idempotency-Key', 'unknown-account')
      .send({ action: 'freeze', walletAddress: wallet(), reason: 'x' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('USER_NOT_FOUND');
    const missingKey = await http()
      .post('/v1/admin/compliance-changes')
      .set(admin)
      .send({ action: 'freeze', walletAddress: wallet(), reason: 'x' });
    expect(missingKey.body.code).toBe('IDEMPOTENCY_KEY_MISSING');
    const notFound = await http()
      .get('/v1/admin/compliance-changes/7d0b6f0e-2f8e-4a51-9a8c-7a3b3b9a1c11')
      .set(admin);
    expect(notFound.status).toBe(404);
    expect(notFound.body.code).toBe('COMPLIANCE_CHANGE_NOT_FOUND');
  });

  it('a clean run, then a rogue transfer shows mismatches, then a node failure is unknown (never ok)', async () => {
    const alice = await allowedUser();
    const bob = await allowedUser();
    await settleAndIndex();
    const dep = await http()
      .post(`/v1/users/${alice.id}/deposits`)
      .set(platform)
      .set('Idempotency-Key', 'rec-dep')
      .send({ amount: '1000' });
    expect(dep.status).toBe(201);
    await settleAndIndex();

    const clean = await http().post('/v1/admin/reconciliations').set(admin);
    expect(clean.status).toBe(200);
    expect(clean.body).toMatchObject({
      status: 'ok',
      clean: true,
      mismatchCount: 0,
      mismatches: [],
      error: null,
      deploymentId: rig.deploymentId,
    });
    expect(clean.body.finalBlock).toMatch(/^[0-9]+$/);

    rig.chain.setHolderTransfersEnabled(true);
    rig.chain.injectTransfer(
      alice.walletAddress as `0x${string}`,
      bob.walletAddress as `0x${string}`,
      300n,
    );
    await rig.engine.tick(); // indexed (the transfer's block is final at depth 1)
    rig.clock.advance(1_000); // runs are listed by start time
    const dirty = await http().post('/v1/admin/reconciliations').set(admin);
    expect(dirty.status).toBe(200);
    expect(dirty.body.status).toBe('mismatch');
    expect(dirty.body.clean).toBe(false);
    const kinds = dirty.body.mismatches.map((m: { kind: string }) => m.kind);
    expect(kinds).toEqual(expect.arrayContaining(['unexplained_transfer', 'balance_mismatch']));
    expect(dirty.body.mismatchCount).toBe(kinds.length);
    expect(dirty.body.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'balance_mismatch',
          detail: expect.objectContaining({
            address: alice.walletAddress,
            expected: '1000',
            observed: '700',
          }),
        }),
      ]),
    );

    rig.clock.advance(1_000);
    rig.chain.setUnavailable(true);
    try {
      const unknown = await http().post('/v1/admin/reconciliations').set(admin);
      expect(unknown.status).toBe(200);
      expect(unknown.body.status).toBe('unknown');
      expect(unknown.body.clean).toBe(false);
      expect(unknown.body.error).toMatch(/^read_failed/);
      expect(unknown.body.error).not.toMatch(/https?:\/\//);

      const ready = await http().get('/ready');
      expect(ready.status).toBe(503);
      expect(ready.headers['retry-after']).toBe('5');
      expect(ready.body).toMatchObject({
        code: 'NOT_READY',
        checks: { database: 'ok', node: 'fail', deployment: 'ok' },
      });
    } finally {
      rig.chain.setUnavailable(false);
    }
    expect((await http().get('/ready')).status).toBe(200);

    const list = await http().get('/v1/admin/reconciliations?limit=3').set(admin);
    expect(list.status).toBe(200);
    expect(list.body.map((r: { status: string }) => r.status)).toEqual([
      'unknown',
      'mismatch',
      'ok',
    ]);
    expect(list.body[0].id).not.toBe(list.body[1].id);
    const bad = await http().get('/v1/admin/reconciliations?limit=500').set(admin);
    expect(bad.status).toBe(400);
  });
});

describe('deployment binding', () => {
  it('with no deployment row: requests 503 + Retry-After, reconciliation 503, not ready', async () => {
    const rig = await makeRig({ register: false });
    const http = () => request(rig.app.getHttpServer());
    try {
      const user = await http().post('/v1/users').set(platform).send({ walletAddress: wallet() });
      const dep = await http()
        .post(`/v1/users/${user.body.id}/deposits`)
        .set(platform)
        .set('Idempotency-Key', 'no-deployment')
        .send({ amount: '10' });
      expect(dep.status).toBe(503);
      expect(dep.body.code).toBe('NO_ACTIVE_DEPLOYMENT');
      expect(dep.headers['retry-after']).toBe('5');
      const run = await http().post('/v1/admin/reconciliations').set(admin);
      expect(run.status).toBe(503);
      expect(run.body.code).toBe('DEPLOYMENT_NOT_REGISTERED');
      expect((await http().get('/v1/admin/reconciliations').set(admin)).body).toEqual([]);
      const ready = await http().get('/ready');
      expect(ready.status).toBe(503);
      expect(ready.body.checks).toEqual({ database: 'ok', node: 'ok', deployment: 'fail' });
    } finally {
      await rig.close();
    }
  });

  it('with ANOTHER token active on the chain: 503 DEPLOYMENT_MISMATCH, nothing written', async () => {
    const rig = await makeRig({ register: false });
    const http = () => request(rig.app.getHttpServer());
    try {
      await rig.db.prisma.deployment.create({
        data: {
          chainId: BigInt(rig.chain.chainId),
          tokenAddress: wallet(),
          registryAddress: wallet(),
          deploymentBlock: 0n,
          active: true,
        },
      });
      const user = await http().post('/v1/users').set(platform).send({ walletAddress: wallet() });
      const dep = await http()
        .post(`/v1/users/${user.body.id}/deposits`)
        .set(platform)
        .set('Idempotency-Key', 'mismatch')
        .send({ amount: '10' });
      expect(dep.status).toBe(503);
      expect(dep.body.code).toBe('DEPLOYMENT_MISMATCH');
      expect(dep.headers['retry-after']).toBe('30');
      expect(dep.text).not.toContain(rig.chain.tokenAddress);
      expect(await rig.db.prisma.operation.count()).toBe(0);
      const ready = await http().get('/ready');
      expect(ready.body.checks.deployment).toBe('fail');
    } finally {
      await rig.close();
    }
  });
});
