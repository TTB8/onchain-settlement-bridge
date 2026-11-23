/**
 * The API's startup sequence (`startApi`): refuses an invalid environment before connecting
 * anything, refuses a node on another chain (and disconnects the database), and otherwise
 * listens, answers, and closes its own database client on shutdown.
 */

import { createServer } from 'node:net';

import { FakeChainGateway } from '@bridge/chain';
import { createPrismaClient, type PrismaClient } from '@bridge/db';
import { ChainIdMismatchConfigError, ConfigError } from '@bridge/engine/env';

import request from 'supertest';

import { createApiApp, DatabaseUnreachableError, startApi } from '../src/app';
import { JsonLogger } from '../src/core/logger';
import {
  createTestDatabase,
  registerDeployment,
  TestClock,
  type TestDatabase,
  testEnv,
  testIds,
  PLATFORM,
} from './support/rig';
import { loadApiConfig } from '@bridge/engine/env';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const address = s.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      s.close(() => resolve(port));
    });
  });
}

describe('startApi', () => {
  it('refuses an invalid environment before creating any client, naming every variable', async () => {
    const createPrisma = jest.fn();
    const createGateway = jest.fn();
    const err = await startApi(
      { CHAIN_ID: '1', API_PLATFORM_TOKEN: 'short' },
      { createPrisma, createGateway },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).problems.map((p) => p.variable)).toEqual(
      expect.arrayContaining(['DATABASE_URL', 'CHAIN_ID', 'API_PLATFORM_TOKEN', 'API_ADMIN_TOKEN']),
    );
    expect((err as Error).message).not.toContain('short');
    expect(createPrisma).not.toHaveBeenCalled();
    expect(createGateway).not.toHaveBeenCalled();
  });

  it('refuses a node on another chain and disconnects the database', async () => {
    const configured = new FakeChainGateway({ chainId: 31337 });
    const disconnect = jest.fn(async () => undefined);
    const prisma = {
      $disconnect: disconnect,
      $queryRaw: async () => [{ ok: 1 }],
    } as unknown as PrismaClient;
    const err = await startApi(testEnv(configured, 'postgresql://u:p@localhost:5434/x'), {
      createPrisma: () => prisma,
      createGateway: () => new FakeChainGateway({ chainId: 1337 }),
      write: () => undefined,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainIdMismatchConfigError);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  describe('with a database', () => {
    let db: TestDatabase;
    beforeAll(async () => {
      db = await createTestDatabase();
    });
    afterAll(async () => {
      await db.drop();
    });

    it('listens, is ready, and closes its own client on shutdown', async () => {
      const chain = new FakeChainGateway({ chainId: 31337 });
      await registerDeployment(db.prisma, chain);
      const port = await freePort();
      const lines: string[] = [];
      let owned: PrismaClient | undefined;
      const { app, url } = await startApi(
        { ...testEnv(chain, db.url), API_PORT: String(port), LOG_LEVEL: 'log' },
        {
          createPrisma: (u) => {
            // A client of its own (the app disconnects it), on the same test database.
            owned = createPrismaClient(u);
            return owned;
          },
          createGateway: () => chain,
          write: (l) => lines.push(l),
        },
      );
      try {
        expect(url).toBe(`http://127.0.0.1:${port}`);
        const ready = await fetch(`${url}/ready`);
        expect(ready.status).toBe(200);
        expect(await ready.json()).toEqual({
          status: 'ready',
          checks: { database: 'ok', node: 'ok', deployment: 'ok' },
        });
        expect(lines.some((l) => l.includes('"msg":"api listening"'))).toBe(true);
        expect(lines.join('\n')).not.toContain(db.url);
      } finally {
        const disconnect = jest.spyOn(owned as PrismaClient, '$disconnect');
        await app.close();
        expect(disconnect).toHaveBeenCalled();
      }
    });
  });

  it('refuses to start when the database is down, before touching the node, naming no URL', async () => {
    const createGateway = jest.fn();
    const down = 'postgresql://bridge:secret-pw@127.0.0.1:1/nothing';
    const err = await startApi(testEnv(new FakeChainGateway(), down), {
      createPrisma: createPrismaClient,
      createGateway,
      write: () => undefined,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatabaseUnreachableError);
    expect((err as Error).message).toBe(
      'the database is not reachable: check DATABASE_URL and that Postgres is up',
    );
    expect((err as Error).message).not.toContain('secret-pw');
    expect(createGateway).not.toHaveBeenCalled();
  });
});

describe('the database going down while serving', () => {
  it('answers 503 NOT_READY + Retry-After (never 500) and logs a warn line, not an unhandled error', async () => {
    const chain = new FakeChainGateway({ chainId: 31337 });
    const url = 'postgresql://bridge:bridge@127.0.0.1:1/nothing';
    const prisma = createPrismaClient(url);
    const lines: string[] = [];
    const app = await createApiApp({
      config: loadApiConfig(testEnv(chain, url)),
      prisma,
      gateway: chain,
      clock: new TestClock(),
      ids: testIds,
      logger: new JsonLogger({
        level: 'debug',
        secrets: [url],
        service: 't',
        write: (l) => lines.push(l),
      }),
    });
    await app.init();
    try {
      const http = () => request(app.getHttpServer());
      const auth = { Authorization: `Bearer ${PLATFORM}` };
      const id = '7d0b6f0e-2f8e-4a51-9a8c-7a3b3b9a1c11';
      for (const res of [
        await http().get(`/v1/users/${id}`).set(auth),
        await http()
          .post('/v1/users')
          .set(auth)
          .send({ walletAddress: `0x${'ab'.repeat(20)}` }),
        await http()
          .post(`/v1/users/${id}/deposits`)
          .set(auth)
          .set('Idempotency-Key', 'db-down')
          .send({ amount: '5' }),
      ]) {
        expect(res.status).toBe(503);
        expect(res.headers['retry-after']).toBe('5');
        expect(res.body.code).toBe('NOT_READY');
        expect(res.text).not.toContain('127.0.0.1');
      }
      const ready = await http().get('/ready');
      expect(ready.status).toBe(503);
      expect(ready.body.checks.database).toBe('fail');
      expect(lines.some((l) => l.includes('"msg":"database unavailable"'))).toBe(true);
      expect(lines.some((l) => l.includes('unhandled error'))).toBe(false);
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });
});
