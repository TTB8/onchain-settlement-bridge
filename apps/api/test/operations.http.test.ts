/**
 * HTTP tests on a real Postgres (fresh database for this file) with the fake chain: users,
 * deposits, withdrawals, transfers, balances after engine ticks, idempotency, amount rules and
 * the problem+json errors of the operation routes.
 */

import request from 'supertest';

import { makeRig, PLATFORM, type Rig, setVerifiedOnChain, settle, wallet } from './support/rig';

let rig: Rig;

beforeAll(async () => {
  rig = await makeRig();
});

afterAll(async () => {
  await rig.close();
});

const auth = { Authorization: `Bearer ${PLATFORM}` };
const http = () => request(rig.app.getHttpServer());

async function createUser(verified = true): Promise<{ id: string; walletAddress: string }> {
  const w = wallet();
  const res = await http().post('/v1/users').set(auth).send({ walletAddress: w });
  expect(res.status).toBe(201);
  if (verified) await setVerifiedOnChain(rig.chain, w);
  return res.body as { id: string; walletAddress: string };
}

async function deposit(userId: string, amount: string, key: string) {
  return http()
    .post(`/v1/users/${userId}/deposits`)
    .set(auth)
    .set('Idempotency-Key', key)
    .send({ amount });
}

async function balances(userId: string) {
  const res = await http().get(`/v1/users/${userId}/balances`).set(auth);
  expect(res.status).toBe(200);
  return res.body as Record<string, string | number>;
}

describe('users', () => {
  it('creates a user (wallet stored lowercase) and reads it back', async () => {
    const w = `0x${'AbCdEf0123'.repeat(4)}`;
    const res = await http().post('/v1/users').set(auth).send({ walletAddress: w });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      walletAddress: w.toLowerCase(),
      createdAt: expect.stringMatching(/Z$/),
    });
    const read = await http().get(`/v1/users/${res.body.id}`).set(auth);
    expect(read.status).toBe(200);
    expect(read.body).toEqual(res.body);
    const accounts = await rig.db.prisma.account.findMany({ where: { userId: res.body.id } });
    expect(accounts.map((a) => a.kind).sort()).toEqual([
      'user_available',
      'user_held',
      'user_incoming',
    ]);
  });

  it('registering the same wallet again (any case) returns the same user: 200, replayed, nothing written', async () => {
    const w = wallet();
    const first = await http().post('/v1/users').set(auth).send({ walletAddress: w });
    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const users = await rig.db.prisma.user.count();
    const accounts = await rig.db.prisma.account.count();
    const res = await http()
      .post('/v1/users')
      .set(auth)
      .send({ walletAddress: w.toUpperCase().replace('0X', '0x') });
    expect(res.status).toBe(200);
    expect(res.headers['idempotent-replayed']).toBe('true');
    expect(res.body).toEqual(first.body);
    expect(await rig.db.prisma.user.count()).toBe(users);
    expect(await rig.db.prisma.account.count()).toBe(accounts);
  });

  it('concurrent registrations of one wallet create exactly one user', async () => {
    const w = wallet();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        http().post('/v1/users').set(auth).send({ walletAddress: w }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await rig.db.prisma.user.count({ where: { walletAddress: w } })).toBe(1);
  });

  it('refuses a malformed wallet, unknown properties, and an unknown user', async () => {
    const bad = await http().post('/v1/users').set(auth).send({ walletAddress: '0x123' });
    expect(bad.status).toBe(400);
    expect(bad.body.errors).toEqual([
      { field: 'walletAddress', message: 'walletAddress must be 0x followed by 40 hex characters' },
    ]);
    const extra = await http()
      .post('/v1/users')
      .set(auth)
      .send({ walletAddress: wallet(), verified: true });
    expect(extra.status).toBe(400);
    expect(extra.body.errors).toEqual([
      { field: 'verified', message: 'property verified should not exist' },
    ]);
    const missing = await http()
      .get(`/v1/users/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`)
      .set(auth);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('USER_NOT_FOUND');
    const notUuid = await http().get('/v1/users/not-a-uuid').set(auth);
    expect(notUuid.status).toBe(400);
    expect(notUuid.body.errors).toEqual([{ field: 'userId', message: 'must be a UUID' }]);
  });
});

describe('deposit -> withdrawal -> transfer through the engine', () => {
  it('moves the balances exactly, derived on every read', async () => {
    const alice = await createUser();
    const bob = await createUser();

    const dep = await deposit(alice.id, '5000000', 'dep-1');
    expect(dep.status).toBe(201);
    expect(dep.headers['idempotent-replayed']).toBeUndefined();
    expect(dep.body).toMatchObject({
      type: 'deposit',
      status: 'ledger_reserved',
      userId: alice.id,
      counterpartyUserId: null,
      amount: '5000000',
      failureReason: null,
      confirmedBlock: null,
      deploymentId: rig.deploymentId,
    });
    expect(await balances(alice.id)).toEqual({
      userId: alice.id,
      available: '0',
      held: '0',
      incoming: '5000000',
      expectedOnChain: '0',
      decimals: 6,
    });

    await settle(rig);
    const settled = await http().get(`/v1/operations/${dep.body.id}`).set(auth);
    expect(settled.body.status).toBe('confirmed');
    expect(settled.body.confirmedBlock).toMatch(/^[0-9]+$/);
    expect(await balances(alice.id)).toMatchObject({
      available: '5000000',
      held: '0',
      incoming: '0',
      expectedOnChain: '5000000',
    });
    expect(rig.chain.balanceOf(alice.walletAddress as `0x${string}`)).toBe(5_000_000n);

    const wd = await http()
      .post(`/v1/users/${alice.id}/withdrawals`)
      .set(auth)
      .set('Idempotency-Key', 'wd-1')
      .send({ amount: '1000000' });
    expect(wd.status).toBe(201);
    expect(wd.body.type).toBe('withdrawal');
    // Reserved: available -> held; still on chain until the burn.
    expect(await balances(alice.id)).toMatchObject({
      available: '4000000',
      held: '1000000',
      expectedOnChain: '5000000',
    });

    const tr = await http()
      .post(`/v1/users/${alice.id}/transfers`)
      .set(auth)
      .set('Idempotency-Key', 'tr-1')
      .send({ amount: '1500000', toUserId: bob.id });
    expect(tr.status).toBe(201);
    expect(tr.body).toMatchObject({
      type: 'transfer',
      userId: alice.id,
      counterpartyUserId: bob.id,
    });
    // A transfer reserves only on the sender's side (available -> held); the recipient is
    // credited at settlement (held(sender) -> available(recipient)).
    expect(await balances(bob.id)).toMatchObject({ available: '0', incoming: '0' });
    expect(await balances(alice.id)).toMatchObject({ available: '2500000', held: '2500000' });

    await settle(rig, 6);
    expect(await balances(alice.id)).toMatchObject({
      available: '2500000',
      held: '0',
      incoming: '0',
      expectedOnChain: '2500000',
    });
    expect(await balances(bob.id)).toMatchObject({
      available: '1500000',
      incoming: '0',
      expectedOnChain: '1500000',
    });
    expect(rig.chain.balanceOf(alice.walletAddress as `0x${string}`)).toBe(2_500_000n);
    expect(rig.chain.balanceOf(bob.walletAddress as `0x${string}`)).toBe(1_500_000n);

    const listA = await http().get(`/v1/users/${alice.id}/operations`).set(auth);
    expect(listA.status).toBe(200);
    expect(listA.body.items.map((o: { id: string }) => o.id).sort()).toEqual(
      [dep.body.id, wd.body.id, tr.body.id].sort(),
    );
    expect(listA.body.items.every((o: { status: string }) => o.status === 'confirmed')).toBe(true);
    // Bob sees the transfer he received.
    const listB = await http().get(`/v1/users/${bob.id}/operations`).set(auth);
    expect(listB.body.items.map((o: { id: string }) => o.id)).toEqual([tr.body.id]);
  });

  it('an operation shows its chain transactions: none before signing, then each attempt with its hash', async () => {
    const erin = await createUser();
    const dep = await deposit(erin.id, '700', 'dep-tx-1');
    expect(dep.status).toBe(201);
    expect(dep.body.transactions).toEqual([]);

    await settle(rig);
    const attempts = await rig.db.prisma.chainAttempt.findMany({
      where: { outbox: { operationId: dep.body.id } },
    });
    expect(attempts).toHaveLength(1);
    const attempt = attempts[0]!;
    const read = await http().get(`/v1/operations/${dep.body.id}`).set(auth);
    expect(read.body.status).toBe('confirmed');
    expect(read.body.transactions).toEqual([
      {
        hash: attempt.hash,
        nonce: attempt.nonce,
        status: attempt.status,
        blockNumber: attempt.blockNumber === null ? null : attempt.blockNumber.toString(),
      },
    ]);
    expect(read.body.transactions[0].hash).toMatch(/^0x[0-9a-f]{64}$/);
    // The confirming transaction is recorded as mined at the operation's confirmed block.
    expect(read.body.transactions[0]).toMatchObject({
      status: 'mined',
      blockNumber: read.body.confirmedBlock,
    });
    expect(read.body.confirmedBlock).toMatch(/^[0-9]+$/);

    // The list shows the same, and only this operation's attempts (one query for the page).
    const other = await deposit(erin.id, '5', 'dep-tx-2');
    await settle(rig);
    const list = await http().get(`/v1/users/${erin.id}/operations`).set(auth);
    const byId = new Map(
      list.body.items.map((o: { id: string; transactions: { hash: string }[] }) => [o.id, o]),
    );
    const first = byId.get(dep.body.id) as { transactions: { hash: string }[] };
    const second = byId.get(other.body.id) as { transactions: { hash: string }[] };
    expect(first.transactions.map((t) => t.hash)).toEqual([attempt.hash]);
    expect(second.transactions).toHaveLength(1);
    expect(second.transactions[0]!.hash).not.toBe(attempt.hash);
    // A replay returns the stored operation with its transactions too.
    const replay = await deposit(erin.id, '700', 'dep-tx-1');
    expect(replay.status).toBe(200);
    expect(replay.body.transactions.map((t: { hash: string }) => t.hash)).toEqual([attempt.hash]);
  });

  it('insufficient funds is 422 and writes nothing', async () => {
    const carol = await createUser();
    const before = await rig.db.prisma.operation.count();
    const res = await http()
      .post(`/v1/users/${carol.id}/withdrawals`)
      .set(auth)
      .set('Idempotency-Key', 'wd-too-much')
      .send({ amount: '1' });
    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toEqual({
      type: 'urn:bridge:problem:insufficient-funds',
      title: 'Insufficient funds',
      status: 422,
      detail: 'The available balance does not cover the amount.',
      code: 'INSUFFICIENT_FUNDS',
      instance: `urn:request:${res.headers['x-request-id']}`,
    });
    expect(await rig.db.prisma.operation.count()).toBe(before);
  });

  it('a transfer to oneself is 400, to an unknown user 404', async () => {
    const dave = await createUser();
    const self = await http()
      .post(`/v1/users/${dave.id}/transfers`)
      .set(auth)
      .set('Idempotency-Key', 'self-1')
      .send({ amount: '1', toUserId: dave.id });
    expect(self.status).toBe(400);
    expect(self.body.code).toBe('SELF_TRANSFER');
    const unknown = await http()
      .post(`/v1/users/${dave.id}/transfers`)
      .set(auth)
      .set('Idempotency-Key', 'unknown-1')
      .send({ amount: '1', toUserId: '7d0b6f0e-2f8e-4a51-9a8c-7a3b3b9a1c11' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('USER_NOT_FOUND');
    expect(JSON.stringify(unknown.body)).not.toContain('7d0b6f0e');
    const depositUnknown = await deposit('7d0b6f0e-2f8e-4a51-9a8c-7a3b3b9a1c11', '1', 'x-1');
    expect(depositUnknown.status).toBe(404);
  });
});

describe('UUID spelling', () => {
  it('an uppercase user id is the same user: same operation on replay, self transfer refused', async () => {
    const user = await createUser();
    const upper = user.id.toUpperCase();
    const first = await deposit(upper, '50', 'upper-1');
    expect(first.status).toBe(201);
    expect(first.body.userId).toBe(user.id);
    const replay = await deposit(user.id, '50', 'upper-1');
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    const self = await http()
      .post(`/v1/users/${upper}/transfers`)
      .set(auth)
      .set('Idempotency-Key', 'upper-self')
      .send({ amount: '1', toUserId: user.id });
    expect(self.status).toBe(400);
    expect(self.body.code).toBe('SELF_TRANSFER');
    const read = await http()
      .get(`/v1/operations/${String(first.body.id).toUpperCase()}`)
      .set(auth);
    expect(read.body.id).toBe(first.body.id);
  });
});

describe('idempotency', () => {
  it('a replay returns the same operation (200, Idempotent-Replayed) and writes nothing', async () => {
    const erin = await createUser();
    const first = await deposit(erin.id, '700', 'same-key');
    expect(first.status).toBe(201);
    const count = await rig.db.prisma.operation.count();
    const again = await deposit(erin.id, '700', 'same-key');
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(await rig.db.prisma.operation.count()).toBe(count);
  });

  it('the same key with another body is 409 naming only the caller own operation', async () => {
    const frank = await createUser();
    const first = await deposit(frank.id, '700', 'key-409');
    const other = await deposit(frank.id, '701', 'key-409');
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(other.body.existingOperationId).toBe(first.body.id);
    expect(JSON.stringify(other.body)).not.toContain('key-409');
  });

  it('concurrent copies of one request create exactly one operation', async () => {
    const gina = await createUser();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => deposit(gina.id, '900', 'parallel-key')),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await rig.db.prisma.operation.count({ where: { userId: gina.id } })).toBe(1);
  });

  it('a missing Idempotency-Key is 400 and writes nothing; a malformed one too', async () => {
    const hank = await createUser();
    const before = await rig.db.prisma.operation.count();
    const missing = await http()
      .post(`/v1/users/${hank.id}/deposits`)
      .set(auth)
      .send({ amount: '1' });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('IDEMPOTENCY_KEY_MISSING');
    const spaced = await http()
      .post(`/v1/users/${hank.id}/deposits`)
      .set(auth)
      .set('Idempotency-Key', 'has a space')
      .send({ amount: '1' });
    expect(spaced.status).toBe(400);
    expect(spaced.body.code).toBe('IDEMPOTENCY_KEY_INVALID');
    const long = await deposit(hank.id, '1', 'k'.repeat(256));
    expect(long.body.code).toBe('IDEMPOTENCY_KEY_INVALID');
    for (const path of ['withdrawals', 'transfers']) {
      const res = await http()
        .post(`/v1/users/${hank.id}/${path}`)
        .set(auth)
        .send({ amount: '1', toUserId: hank.id });
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_MISSING');
    }
    expect(await rig.db.prisma.operation.count()).toBe(before);
  });
});

describe('amounts', () => {
  let userId: string;
  beforeAll(async () => {
    userId = (await createUser()).id;
  });

  it.each([
    ['a JSON number', 1000000],
    ['a JSON number that is an integer-valued float', 1e6],
    ['a float string', '1.5'],
    ['a negative', '-5'],
    ['zero', '0'],
    ['a leading zero', '0100'],
    ['an exponent', '1e6'],
    ['a sign', '+5'],
    ['whitespace', ' 5'],
    ['hex', '0x10'],
    ['an empty string', ''],
    ['a boolean', true],
    ['null', null],
    ['an object', { value: '5' }],
    ['more than 19 digits', '1'.repeat(20)],
  ])('%s is refused with 400', async (_label, amount) => {
    const res = await deposit(
      userId,
      amount as string,
      `amount-${String(_label).replace(/\W/g, '-')}`,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.errors[0].field).toBe('amount');
  });

  it('a missing amount is refused', async () => {
    const res = await http()
      .post(`/v1/users/${userId}/deposits`)
      .set(auth)
      .set('Idempotency-Key', 'no-amount')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.errors.map((e: { field: string }) => e.field)).toContain('amount');
  });

  it('above the configured cap is 400 AMOUNT_ABOVE_LIMIT; at the cap it is accepted', async () => {
    const over = await deposit(userId, '1000000000001', 'cap-over');
    expect(over.status).toBe(400);
    expect(over.body.code).toBe('AMOUNT_ABOVE_LIMIT');
    expect(over.body.limit).toBe('1000000000000');
    const at = await deposit(userId, '1000000000000', 'cap-at');
    expect(at.status).toBe(201);
  });

  it('nothing was written by any refused amount', async () => {
    const ops = await rig.db.prisma.operation.findMany({ where: { userId } });
    expect(ops.map((o) => o.amount)).toEqual([1_000_000_000_000n]);
  });
});

describe('listing', () => {
  it('pages newest first with an opaque cursor, and refuses bad limits and cursors', async () => {
    const ivy = await createUser();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      rig.clock.advance(1_000);
      ids.push((await deposit(ivy.id, String(100 + i), `page-${i}`)).body.id);
    }
    const p1 = await http().get(`/v1/users/${ivy.id}/operations?limit=2`).set(auth);
    expect(p1.body.items.map((o: { id: string }) => o.id)).toEqual([ids[4], ids[3]]);
    const p2 = await http()
      .get(`/v1/users/${ivy.id}/operations?limit=2&cursor=${p1.body.nextCursor}`)
      .set(auth);
    expect(p2.body.items.map((o: { id: string }) => o.id)).toEqual([ids[2], ids[1]]);
    const p3 = await http()
      .get(`/v1/users/${ivy.id}/operations?limit=2&cursor=${p2.body.nextCursor}`)
      .set(auth);
    expect(p3.body.items.map((o: { id: string }) => o.id)).toEqual([ids[0]]);
    expect(p3.body.nextCursor).toBeNull();

    for (const q of [
      'limit=0',
      'limit=101',
      'limit=abc',
      'cursor=!!',
      'cursor=Zm9v',
      'cursor=a&cursor=b',
    ]) {
      const res = await http().get(`/v1/users/${ivy.id}/operations?${q}`).set(auth);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
    const unknown = await http()
      .get('/v1/users/7d0b6f0e-2f8e-4a51-9a8c-7a3b3b9a1c11/operations')
      .set(auth);
    expect(unknown.status).toBe(404);
    const op404 = await http().get('/v1/operations/7d0b6f0e-2f8e-4a51-9a8c-7a3b3b9a1c11').set(auth);
    expect(op404.body.code).toBe('OPERATION_NOT_FOUND');
    const bal404 = await http()
      .get('/v1/users/7d0b6f0e-2f8e-4a51-9a8c-7a3b3b9a1c11/balances')
      .set(auth);
    expect(bal404.body.code).toBe('USER_NOT_FOUND');
  });
});
