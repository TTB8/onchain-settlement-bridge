/**
 * The whole worker process (`runWorker`) on a real Postgres with the fake chain: it refuses a bad
 * environment, a node on another chain, a missing or foreign deployment and mismatched signers
 * (exit 1, database closed), runs the real engine loop until SIGTERM (exit 0), and exits 1 when
 * the deployment is deactivated under it.
 */

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { FakeChainGateway } from '@bridge/chain';
import { createPrismaClient, type PrismaClient } from '@bridge/db';

import { DEFAULT_WORKER_DEPS, runWorker, viemGateway, type WorkerDeps } from '../src/worker';
import { ViemTransactionInspector } from '@bridge/engine';
import { loadWorkerConfig } from '@bridge/engine/env';
import {
  createTestDatabase,
  FakeInspector,
  registerDeployment,
  type TestDatabase,
  workerEnv,
} from './support/support';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.drop();
});

afterEach(async () => {
  // Deployments are never deleted (a database guard); each test uses its own token and registry
  // addresses, and the next one starts with none active.
  await db.prisma.deployment.updateMany({ where: { active: true }, data: { active: false } });
});

const addr = () => `0x${randomBytes(20).toString('hex')}` as `0x${string}`;

/** A fake chain 31337 with fresh token and registry addresses. */
const newChain = (chainId = 31337) =>
  new FakeChainGateway({ chainId, tokenAddress: addr(), registryAddress: addr() });

/** Every client `runWorker` created, with a spy on its disconnect. */
const disconnects: jest.SpyInstance[] = [];

function deps(
  chain: FakeChainGateway,
  lines: string[],
  signals: EventEmitter,
  clients: PrismaClient[],
): WorkerDeps {
  return {
    createPrisma: (url) => {
      const c = createPrismaClient(url);
      clients.push(c);
      disconnects.push(jest.spyOn(c, '$disconnect'));
      return c;
    },
    createGateway: () => chain,
    createInspector: (g) => new FakeInspector(g as FakeChainGateway),
    write: (l) => lines.push(l),
    signals,
  };
}

const msgsOf = (lines: string[]) => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('runWorker', () => {
  it('refuses an invalid environment (exit 1), listing every variable and no value', async () => {
    const lines: string[] = [];
    const createPrisma = jest.fn();
    const code = await runWorker(
      { CHAIN_ID: '1', SETTLEMENT_SIGNER_KEY: '0xdeadbeef-not-a-key' },
      {
        createPrisma,
        createGateway: jest.fn(),
        createInspector: jest.fn(),
        write: (l) => lines.push(l),
      },
    );
    expect(code).toBe(1);
    expect(createPrisma).not.toHaveBeenCalled();
    const text = lines.join('\n');
    for (const v of [
      'DATABASE_URL',
      'RPC_URL',
      'CHAIN_ID',
      'FEE_CAP_WEI',
      'SETTLEMENT_SIGNER_KEY',
      'ALLOW_MAINNET',
    ]) {
      expect(text).toContain(v);
    }
    expect(text).not.toContain('deadbeef');
  });

  it('refuses a node on another chain (exit 1) and closes the database', async () => {
    const chain = newChain();
    const lines: string[] = [];
    const clients: PrismaClient[] = [];
    const d = deps(newChain(1337), lines, new EventEmitter(), clients);
    const code = await runWorker(workerEnv(chain, db.url), d);
    expect(code).toBe(1);
    expect(disconnects.at(-1)).toHaveBeenCalled();
    expect(lines.join('\n')).toContain('ChainIdMismatchConfigError');
    expect(lines.join('\n')).not.toContain('test-rpc-key');
  });

  it('refuses to run when no deployment is registered (exit 1, obvious log line)', async () => {
    const chain = newChain();
    const lines: string[] = [];
    const code = await runWorker(
      workerEnv(chain, db.url),
      deps(chain, lines, new EventEmitter(), []),
    );
    expect(code).toBe(1);
    const msgs = msgsOf(lines);
    expect(msgs.some((m) => m.msg === 'alarm' && m.kind === 'deployment_mismatch')).toBe(true);
    expect(
      msgs.some((m) => m.msg === 'refusing to run: the deployment binding does not match'),
    ).toBe(true);
    expect(msgs.some((m) => m.msg === 'engine loop started')).toBe(false);
  });

  it('refuses to run when another token is the active deployment', async () => {
    const chain = newChain();
    await registerDeployment(db.prisma, newChain());
    const lines: string[] = [];
    expect(
      await runWorker(workerEnv(chain, db.url), deps(chain, lines, new EventEmitter(), [])),
    ).toBe(1);
  });

  it('refuses to run when the recorded signer is not the configured key', async () => {
    const chain = newChain();
    await registerDeployment(db.prisma, chain, { compliance: `0x${'99'.repeat(20)}` });
    const lines: string[] = [];
    expect(
      await runWorker(workerEnv(chain, db.url), deps(chain, lines, new EventEmitter(), [])),
    ).toBe(1);
    expect(lines.join('\n')).toContain('the compliance signer of the active deployment');
  });

  it('runs the real engine loop until SIGTERM, then exits 0 and closes the database', async () => {
    const chain = newChain();
    await registerDeployment(db.prisma, chain);
    const lines: string[] = [];
    const signals = new EventEmitter();
    const clients: PrismaClient[] = [];
    const done = runWorker(workerEnv(chain, db.url), deps(chain, lines, signals, clients));
    // The indexer writes its cursor on the first tick: proof the loop really runs.
    await waitFor(() => lines.some((l) => l.includes('engine loop started')));
    const deploymentId = (await db.prisma.deployment.findFirstOrThrow({ where: { active: true } }))
      .id;
    const ticked = async () =>
      (await db.prisma.indexerState.count({ where: { deploymentId } })) === 1;
    for (let i = 0; i < 100 && !(await ticked()); i += 1)
      await new Promise((r) => setTimeout(r, 50));
    expect(await ticked()).toBe(true);
    signals.emit('SIGTERM');
    expect(await done).toBe(0);
    const msgs = msgsOf(lines);
    expect(msgs.find((m) => m.msg === 'worker starting')).toMatchObject({
      workerId: 'worker-test',
      chainId: 31337,
      chainClass: 'local',
      settlementSigner: chain.signerAddress('settlement'),
    });
    expect(msgs.at(-1)).toMatchObject({ msg: 'engine loop stopped', exitCode: 0 });
    // Keys and the RPC key never appear in any line.
    const text = lines.join('\n');
    expect(text).not.toContain('1'.repeat(64));
    expect(text).not.toContain('2'.repeat(64));
    expect(text).not.toContain('test-rpc-key');
    // The application context closed the one client the worker created.
    expect(clients).toHaveLength(1);
    expect(disconnects.at(-1)).toHaveBeenCalled();
  });

  it('exits 1 when the deployment is deactivated while it runs (fatal alarm)', async () => {
    const chain = newChain();
    const deploymentId = await registerDeployment(db.prisma, chain);
    const lines: string[] = [];
    const done = runWorker(workerEnv(chain, db.url), deps(chain, lines, new EventEmitter(), []));
    await waitFor(() => lines.some((l) => l.includes('engine loop started')));
    await db.prisma.deployment.update({ where: { id: deploymentId }, data: { active: false } });
    expect(await done).toBe(1);
    const msgs = msgsOf(lines);
    expect(
      msgs.some(
        (m) =>
          m.msg === 'stopping' && String(m.reason).startsWith('fatal alarm deployment_mismatch'),
      ),
    ).toBe(true);
  });
});

describe('runWorker edge paths', () => {
  it('writes a config refusal to stderr by default, and reports a non-config failure redacted', async () => {
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await runWorker({}, { ...DEFAULT_WORKER_DEPS })).toBe(1);
      const env = new Proxy(
        {},
        {
          get: () => {
            throw new TypeError('env read failed');
          },
        },
      );
      expect(await runWorker(env, { ...DEFAULT_WORKER_DEPS })).toBe(1);
      const text = write.mock.calls.map((c) => String(c[0])).join('');
      expect(text).toContain('invalid configuration');
      expect(text).toContain('TypeError: env read failed');
    } finally {
      write.mockRestore();
    }
  });

  it('a failing disconnect after a refused start is swallowed (exit 1 stays the answer)', async () => {
    const chain = newChain();
    const prisma = {
      $disconnect: jest.fn(async () => {
        throw new Error('already closed');
      }),
    } as unknown as PrismaClient;
    const code = await runWorker(workerEnv(chain, db.url), {
      createPrisma: () => prisma,
      createGateway: () => newChain(1337),
      createInspector: (g) => new FakeInspector(g as FakeChainGateway),
      write: () => undefined,
    });
    expect(code).toBe(1);
    expect(prisma.$disconnect).toHaveBeenCalled();
  });

  it('derives the worker id from host and pid when WORKER_ID is unset', async () => {
    const chain = newChain();
    await registerDeployment(db.prisma, chain);
    const lines: string[] = [];
    const signals = new EventEmitter();
    const env = workerEnv(chain, db.url);
    delete env.WORKER_ID;
    const done = runWorker(env, deps(chain, lines, signals, []));
    await waitFor(() => lines.some((l) => l.includes('engine loop started')));
    signals.emit('SIGINT');
    expect(await done).toBe(0);
    const start = msgsOf(lines).find((m) => m.msg === 'worker starting');
    expect(String(start?.workerId)).toMatch(new RegExp(`:${process.pid}$`));
  });

  it('the production factories use the viem inspector', () => {
    expect(DEFAULT_WORKER_DEPS.createInspector(newChain())).toBeInstanceOf(
      ViemTransactionInspector,
    );
  });
});

describe('viemGateway', () => {
  it('builds a viem gateway bound to the configured deployment with both keys', () => {
    const chain = newChain();
    const config = loadWorkerConfig(workerEnv(chain, 'postgresql://u:p@localhost:5434/x'));
    const gw = viemGateway(config);
    expect(gw.deployment()).toEqual({
      chainId: 31337,
      token: chain.tokenAddress,
      registry: chain.registryAddress,
    });
    expect(gw.signerAddress('settlement')).toMatch(/^0x[0-9a-f]{40}$/);
    expect(gw.signerAddress('settlement')).not.toBe(gw.signerAddress('compliance'));
    expect(JSON.stringify(gw)).not.toContain('1'.repeat(64));
  });
});
