/**
 * HTTP tests of the security surface: the 401/403 matrix on EVERY route (checked against the
 * OpenAPI document, so a new route without an entry here fails), problem+json shape with no
 * leaks, body-parser errors, security headers, and the OpenAPI document itself.
 */

import request from 'supertest';

import { buildOpenApiDocument } from '../src/app';
import { ADMIN, makeRig, PLATFORM, type Rig, wallet } from './support/rig';

let rig: Rig;
const http = () => request(rig.app.getHttpServer());
const ID = '7d0b6f0e-2f8e-4a51-9a8c-7a3b3b9a1c11';

beforeAll(async () => {
  rig = await makeRig();
});

afterAll(async () => {
  await rig.close();
});

type Method = 'get' | 'post';

/** Every route, its scope, and a request that would pass validation. */
const ROUTES: readonly {
  method: Method;
  path: string;
  doc: string;
  scope: 'platform' | 'admin';
}[] = [
  { method: 'post', path: '/v1/users', doc: '/v1/users', scope: 'platform' },
  { method: 'get', path: `/v1/users/${ID}`, doc: '/v1/users/{userId}', scope: 'platform' },
  {
    method: 'post',
    path: `/v1/users/${ID}/deposits`,
    doc: '/v1/users/{userId}/deposits',
    scope: 'platform',
  },
  {
    method: 'post',
    path: `/v1/users/${ID}/withdrawals`,
    doc: '/v1/users/{userId}/withdrawals',
    scope: 'platform',
  },
  {
    method: 'post',
    path: `/v1/users/${ID}/transfers`,
    doc: '/v1/users/{userId}/transfers',
    scope: 'platform',
  },
  {
    method: 'get',
    path: `/v1/users/${ID}/operations`,
    doc: '/v1/users/{userId}/operations',
    scope: 'platform',
  },
  {
    method: 'get',
    path: `/v1/users/${ID}/balances`,
    doc: '/v1/users/{userId}/balances',
    scope: 'platform',
  },
  {
    method: 'get',
    path: `/v1/operations/${ID}`,
    doc: '/v1/operations/{operationId}',
    scope: 'platform',
  },
  {
    method: 'post',
    path: '/v1/admin/compliance-changes',
    doc: '/v1/admin/compliance-changes',
    scope: 'admin',
  },
  {
    method: 'get',
    path: `/v1/admin/compliance-changes/${ID}`,
    doc: '/v1/admin/compliance-changes/{changeId}',
    scope: 'admin',
  },
  {
    method: 'post',
    path: '/v1/admin/reconciliations',
    doc: '/v1/admin/reconciliations',
    scope: 'admin',
  },
  {
    method: 'get',
    path: '/v1/admin/reconciliations',
    doc: '/v1/admin/reconciliations',
    scope: 'admin',
  },
];

const PUBLIC = [
  { method: 'get' as const, doc: '/health' },
  { method: 'get' as const, doc: '/ready' },
];

function send(method: Method, path: string, headers: Record<string, string>) {
  const req = method === 'get' ? http().get(path) : http().post(path).send({});
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  return req;
}

describe('the route table', () => {
  it('lists exactly the routes of the OpenAPI document', () => {
    const doc = buildOpenApiDocument(rig.app);
    const documented = Object.entries(doc.paths)
      .flatMap(([path, item]) =>
        (['get', 'post', 'put', 'patch', 'delete'] as const)
          .filter((m) => item[m] !== undefined)
          .map((m) => `${m} ${path}`),
      )
      .sort();
    const tested = [
      ...ROUTES.map((r) => `${r.method} ${r.doc}`),
      ...PUBLIC.map((r) => `${r.method} ${r.doc}`),
    ].sort();
    expect(documented).toEqual(tested);
  });
});

describe('401 / 403 matrix', () => {
  const wrong = (scope: 'platform' | 'admin') => (scope === 'platform' ? ADMIN : PLATFORM);

  it.each(ROUTES.map((r) => [`${r.method.toUpperCase()} ${r.doc}`, r] as const))(
    '%s',
    async (_name, route) => {
      const cases: [Record<string, string>, number, string][] = [
        [{}, 401, 'UNAUTHENTICATED'],
        [{ Authorization: '' }, 401, 'UNAUTHENTICATED'],
        [{ Authorization: 'Basic dXNlcjpwYXNz' }, 401, 'UNAUTHENTICATED'],
        [{ Authorization: 'Bearer' }, 401, 'UNAUTHENTICATED'],
        [{ Authorization: 'Bearer not-the-token' }, 401, 'UNAUTHENTICATED'],
        // One character short of / longer than the real token: never a prefix match.
        [{ Authorization: `Bearer ${PLATFORM.slice(0, -1)}` }, 401, 'UNAUTHENTICATED'],
        [{ Authorization: `Bearer ${ADMIN}x` }, 401, 'UNAUTHENTICATED'],
        [{ Authorization: `Bearer ${PLATFORM} ${ADMIN}` }, 401, 'UNAUTHENTICATED'],
        // The OTHER scope's valid token: 403, never silently accepted.
        [{ Authorization: `Bearer ${wrong(route.scope)}` }, 403, 'FORBIDDEN'],
      ];
      for (const [headers, status, code] of cases) {
        const res = await send(route.method, route.path, headers);
        expect({ headers, status: res.status, code: res.body.code }).toEqual({
          headers,
          status,
          code,
        });
        if (status === 401) expect(res.headers['www-authenticate']).toBe('Bearer');
        else expect(res.headers['www-authenticate']).toBeUndefined();
      }
      // The right token gets past auth (whatever validation or lookup says next).
      const right = route.scope === 'platform' ? PLATFORM : ADMIN;
      const ok = await send(route.method, route.path, { Authorization: `Bearer ${right}` });
      expect([401, 403]).not.toContain(ok.status);
      // The scheme is case-insensitive (RFC 9110).
      const lower = await send(route.method, route.path, { Authorization: `bearer ${right}` });
      expect([401, 403]).not.toContain(lower.status);
    },
  );

  it('/ready is computed at most once per 2 s, and concurrent probes share one run', async () => {
    rig.clock.advance(10_000);
    const spy = jest.spyOn(rig.chain, 'getChainId');
    try {
      const burst = await Promise.all(Array.from({ length: 20 }, () => http().get('/ready')));
      expect(burst.every((r) => r.status === 200)).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      rig.clock.advance(1_999);
      await http().get('/ready');
      expect(spy).toHaveBeenCalledTimes(1);
      rig.clock.advance(1);
      await http().get('/ready');
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('public routes need no credential', async () => {
    expect((await http().get('/health')).status).toBe(200);
    expect((await http().get('/ready')).status).toBe(200);
  });

  it('refused requests write nothing', async () => {
    const before = await rig.db.prisma.user.count();
    await http()
      .post('/v1/users')
      .set('Authorization', `Bearer ${ADMIN}`)
      .send({ walletAddress: wallet() });
    await http().post('/v1/users').send({ walletAddress: wallet() });
    expect(await rig.db.prisma.user.count()).toBe(before);
  });

  it('tokens never reach the logs', () => {
    const all = rig.logs.join('\n');
    expect(all).not.toContain(PLATFORM);
    expect(all).not.toContain(ADMIN);
    expect(all).toContain('"msg":"request"');
  });
});

describe('problem+json', () => {
  const auth = { Authorization: `Bearer ${PLATFORM}` };

  it('malformed JSON is a 400 problem, not an HTML page', async () => {
    const res = await http()
      .post('/v1/users')
      .set(auth)
      .set('Content-Type', 'application/json')
      .send('{"walletAddress": ');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body.code).toBe('MALFORMED_JSON');
    expect(res.text).not.toMatch(/SyntaxError|at JSON|Unexpected/);
  });

  it('a non-JSON body is a 400 problem, never a 500', async () => {
    const user = await http().post('/v1/users').set(auth).send({ walletAddress: wallet() });
    for (const [type, body] of [
      ['text/plain', 'amount=5'],
      ['application/x-www-form-urlencoded', 'amount=5'],
    ] as const) {
      const res = await http()
        .post(`/v1/users/${user.body.id}/deposits`)
        .set(auth)
        .set('Idempotency-Key', `ctype-${type.length}`)
        .set('Content-Type', type)
        .send(body);
      expect({ type, status: res.status, code: res.body.code }).toEqual({
        type,
        status: 400,
        code: 'VALIDATION_FAILED',
      });
    }
    const array = await http()
      .post('/v1/users')
      .set(auth)
      .send([{ walletAddress: wallet() }]);
    expect(array.status).toBe(400);
  });

  it.each([
    ['an unsupported charset', { 'Content-Type': 'application/json; charset=koi8-r' }],
    [
      'an unsupported content encoding',
      { 'Content-Type': 'application/json', 'Content-Encoding': 'compress' },
    ],
  ])('%s is a 415 problem, never a 500 or an unhandled-error log', async (_name, headers) => {
    const before = rig.logs.filter((l) => l.includes('unhandled error')).length;
    const req = http().post('/v1/users').set(auth);
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    const res = await req.send(JSON.stringify({ walletAddress: wallet() }));
    expect(res.status).toBe(415);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(rig.logs.filter((l) => l.includes('unhandled error')).length).toBe(before);
  });

  it('a body above the limit is a 413 problem', async () => {
    const res = await http()
      .post('/v1/users')
      .set(auth)
      .send({ walletAddress: wallet(), padding: 'x'.repeat(4_000) });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('an unknown route is a 404 problem', async () => {
    const res = await http().get('/v1/nothing-here').set(auth);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', type: 'urn:bridge:problem:not-found' });
  });

  it('an unexpected error is a bare 500 with the request id, logged redacted, no stack or SQL', async () => {
    const boom = new Error(
      `connect failed: ${rig.db.url} SELECT * FROM app_user WHERE id = '${ID}'`,
    );
    boom.stack = 'Error: connect failed\n    at secretFrame (/srv/app.js:1:1)';
    const spy = jest.spyOn(rig.db.prisma.user, 'findUnique').mockRejectedValueOnce(boom);
    try {
      const res = await http().get(`/v1/users/${ID}`).set(auth);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        type: 'urn:bridge:problem:internal',
        title: 'Internal error',
        status: 500,
        detail: 'The request failed unexpectedly. Quote the request id when reporting it.',
        code: 'INTERNAL',
        instance: `urn:request:${res.headers['x-request-id']}`,
      });
      for (const leak of [
        'SELECT',
        'app_user',
        ID,
        'secretFrame',
        'bridge_api_test',
        'postgresql',
      ]) {
        expect(res.text).not.toContain(leak);
      }
      const logged = rig.logs.filter((l) => l.includes('unhandled error')).join('\n');
      expect(logged).toContain(String(res.headers['x-request-id']));
      expect(logged).not.toContain(rig.db.url);
      expect(logged).not.toContain('bridge_api_test');
      // The class and the (redacted) message are logged; the stack never is.
      expect(logged).toContain('Error: connect failed');
      expect(logged).not.toContain('secretFrame');
    } finally {
      spy.mockRestore();
    }
  });

  it('an engine error never passes its message through', async () => {
    const user = await http().post('/v1/users').set(auth).send({ walletAddress: wallet() });
    const res = await http()
      .post(`/v1/users/${user.body.id}/withdrawals`)
      .set(auth)
      .set('Idempotency-Key', 'leak-check')
      .send({ amount: '5' });
    expect(res.status).toBe(422);
    // The engine's message names the available balance and the amount: none of it is echoed.
    expect(res.text).not.toMatch(/available 0|requested 5/);
  });

  it('every response carries security headers and no X-Powered-By', async () => {
    const res = await http().get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('OpenAPI', () => {
  it('serves the document at /docs/openapi.json with schemas, both auth schemes and the problem schema', async () => {
    const res = await http().get('/docs/openapi.json');
    expect(res.status).toBe(200);
    const doc = res.body as {
      paths: Record<
        string,
        Record<string, { security?: unknown[]; responses: Record<string, unknown> }>
      >;
      components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
    };
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual([
      'admin-token',
      'platform-token',
    ]);
    for (const schema of [
      'ProblemDto',
      'OperationDto',
      'AmountDto',
      'TransferDto',
      'BalancesDto',
      'RunDto',
      'ComplianceRequestDto',
      'UserDto',
      'CreateUserDto',
    ]) {
      expect(doc.components.schemas[schema]).toBeDefined();
    }
    const deposit = doc.paths['/v1/users/{userId}/deposits']?.post;
    expect(deposit?.security).toEqual([{ 'platform-token': [] }]);
    expect(Object.keys(deposit?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '201', '400', '401', '403', '409', '503']),
    );
    const amount = (
      doc.components.schemas.AmountDto as {
        properties: { amount: { type: string; example: string } };
      }
    ).properties.amount;
    expect(amount.type).toBe('string');
    expect(amount.example).toBe('1500000');
    // An operation documents its chain transactions (hash per signed attempt).
    const operation = doc.components.schemas.OperationDto as {
      properties: { transactions: { type: string; items: { $ref: string } } };
      required: string[];
    };
    expect(operation.properties.transactions.type).toBe('array');
    expect(operation.properties.transactions.items.$ref).toBe(
      '#/components/schemas/TransactionDto',
    );
    expect(operation.required).toContain('transactions');
    const tx = doc.components.schemas.TransactionDto as { properties: Record<string, unknown> };
    expect(Object.keys(tx.properties).sort()).toEqual(['blockNumber', 'hash', 'nonce', 'status']);
    expect(doc.paths['/v1/admin/reconciliations']?.post?.security).toEqual([{ 'admin-token': [] }]);
    // The deposit route says plainly that it mints and when it may be called.
    const depositDoc = deposit as unknown as { summary: string; description: string };
    expect(depositDoc.summary).toContain('MINT');
    expect(depositDoc.description).toMatch(/^MINT AUTHORITY\./);
    expect(depositDoc.description).toContain('ONLY after the platform has confirmed');
    expect(depositDoc.description).toMatch(/mint cap.*proof-of-reserve/);
  });

  it('is not served by default off a local chain, and is when explicitly enabled', async () => {
    const testnet = { chain: { chainId: 11155111 }, env: { ALLOW_TESTNET: 'true' } };
    const off = await makeRig(testnet);
    try {
      expect((await request(off.app.getHttpServer()).get('/docs/openapi.json')).status).toBe(404);
      expect((await request(off.app.getHttpServer()).get('/docs')).status).toBe(404);
    } finally {
      await off.close();
    }
    const on = await makeRig({ ...testnet, env: { ...testnet.env, API_DOCS_ENABLED: 'true' } });
    try {
      expect((await request(on.app.getHttpServer()).get('/docs/openapi.json')).status).toBe(200);
    } finally {
      await on.close();
    }
  });

  it('is not served when API_DOCS_ENABLED=false', async () => {
    const off = await makeRig({ env: { API_DOCS_ENABLED: 'false' } });
    try {
      const res = await request(off.app.getHttpServer()).get('/docs/openapi.json');
      expect(res.status).toBe(404);
    } finally {
      await off.close();
    }
  });
});
