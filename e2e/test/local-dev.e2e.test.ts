/**
 * The developer tooling end to end, as a developer runs it: `setup:local` against a real anvil
 * and a database it creates itself, then the REAL worker process code (`runWorker`, its loop
 * started) and the API (`startApi`) in-process, and `pnpm demo`'s `runDemo` driving them over
 * HTTP, clean and with `--rogue`.
 *
 * In order: the refusals that must leave everything untouched (stack down, a non-local chain),
 * the first run, an idempotent re-run, the `.env` overwrite rule, the demo, and the restarted
 * chain that setup must refuse until `--reset-db`.
 *
 * DEV ONLY: Anvil's public dev accounts; the only keys are the two labelled ones in .env.example.
 */

import { EventEmitter } from 'node:events';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPrismaClient } from '@bridge/db';
import { ViemTransactionInspector } from '@bridge/engine';

import { startApi } from '../../apps/api/src/app';
import { buildReadOnlyGateway } from '../../apps/api/src/chain/read-only-gateway';
import { runWorker, viemGateway } from '../../apps/worker/src/worker';
import { type AnvilNode, freePort, startAnvil } from '../../packages/chain/test/support/anvil';
import { runDemo } from '../../scripts/lib/demo';
import { parseEnvFile, SetupRefusal } from '../../scripts/lib/local-env';
import { Rpc } from '../../scripts/lib/rpc';
import { envFrom, makeWorkdir, reserveDatabase, setupLocal, type Workdir } from './support/stack';

const db = reserveDatabase();
let node: AnvilNode;
let work: Workdir;
const logs: string[] = [];
const log = (line: string) => logs.push(line);

/** The secrets of the template: none may appear in any line setup or the demo prints. */
function secretsOf(path: string): string[] {
  const env = parseEnvFile(readFileSync(path, 'utf8'));
  return [
    env.API_PLATFORM_TOKEN,
    env.API_ADMIN_TOKEN,
    env.SETTLEMENT_SIGNER_KEY,
    env.COMPLIANCE_SIGNER_KEY,
    (env.SETTLEMENT_SIGNER_KEY ?? '').slice(2),
    (env.COMPLIANCE_SIGNER_KEY ?? '').slice(2),
    env.DATABASE_URL,
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);
}

async function databaseExists(): Promise<boolean> {
  const admin = createPrismaClient(
    process.env.DB_TEST_ADMIN_URL ?? 'postgresql://bridge:bridge@localhost:5434/postgres',
  );
  try {
    const rows = await admin.$queryRaw<
      unknown[]
    >`SELECT 1 FROM pg_database WHERE datname = ${db.name}`;
    return rows.length === 1;
  } finally {
    await admin.$disconnect();
  }
}

async function refusal(p: Promise<unknown>): Promise<SetupRefusal> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SetupRefusal) return err;
    throw err;
  }
  throw new Error('expected a SetupRefusal, setup succeeded');
}

beforeAll(async () => {
  node = await startAnvil();
  work = makeWorkdir(db.url, node.url);
}, 60_000);

afterAll(async () => {
  await node?.stop();
  work?.remove();
  await db.drop();
});

describe('pnpm setup:local', () => {
  it('with the stack down: refuses, tells the developer to run docker compose up -d, touches nothing', async () => {
    const closedPort = await freePort();
    const down = makeWorkdir(db.url, `http://127.0.0.1:${closedPort}`);
    try {
      const r = await refusal(setupLocal(down, {}, log));
      expect(r.message).toContain(`no JSON-RPC node answers at 127.0.0.1:${closedPort}`);
      expect(r.message).toContain('docker compose up -d');
      expect(r.message).not.toContain('bridge:bridge');
      const pgDown = makeWorkdir(db.url.replace(':5434/', `:${closedPort}/`), node.url);
      try {
        const r2 = await refusal(setupLocal(pgDown, {}, log));
        expect(r2.message).toContain(`Postgres is not reachable at localhost:${closedPort}`);
      } finally {
        pgDown.remove();
      }
    } finally {
      down.remove();
    }
    expect(await databaseExists()).toBe(false);
  });

  it('refuses a node that is not chain 31337 before creating anything', async () => {
    const mainnetLike = await startAnvil(['--chain-id', '1']);
    const w = makeWorkdir(db.url, mainnetLike.url);
    try {
      const r = await refusal(setupLocal(w, {}, log));
      expect(r.message).toContain('the node reports chain id 1');
      expect(await mainnetLike.client.getBlockNumber()).toBe(0n); // nothing deployed
    } finally {
      w.remove();
      await mainnetLike.stop();
    }
    expect(await databaseExists()).toBe(false);
  });

  it('first run: creates and migrates the database, deploys, promotes, registers, writes .env', async () => {
    const result = await setupLocal(work, {}, log);
    expect(result).toMatchObject({ deployed: true, env: 'create' });
    expect(await databaseExists()).toBe(true);
    expect(logs.some((l) => l.includes(`created database ${db.name}`))).toBe(true);

    const record = JSON.parse(readFileSync(join(work.deploymentsDir, '31337.json'), 'utf8'));
    expect(record.confirmations).toBe(1);
    expect(record.settlementToken.toLowerCase()).toBe(result.token);
    expect(record.complianceRegistry.toLowerCase()).toBe(result.registry);

    const env = parseEnvFile(readFileSync(work.envPath, 'utf8'));
    expect(env.TOKEN_ADDRESS).toBe(result.token);
    expect(env.REGISTRY_ADDRESS).toBe(result.registry);
    expect(env.DATABASE_URL).toBe(db.url);
    expect(statSync(work.envPath).mode & 0o777).toBe(0o600);

    const prisma = createPrismaClient(db.url);
    try {
      const rows = await prisma.deployment.findMany({ include: { signerStates: true } });
      expect(rows).toHaveLength(1);
      const d = rows[0]!;
      expect({
        id: d.id,
        chainId: d.chainId,
        token: d.tokenAddress,
        registry: d.registryAddress,
        active: d.active,
        deploymentBlock: d.deploymentBlock,
      }).toEqual({
        id: result.deploymentId,
        chainId: 31337n,
        token: result.token,
        registry: result.registry,
        active: true,
        deploymentBlock: BigInt(record.deploymentBlock),
      });
      expect(d.signerStates.map((s) => [s.signer, s.address]).sort()).toEqual([
        ['compliance', '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'],
        ['settlement', '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'],
      ]);
      expect(await prisma.account.count({ where: { kind: 'fiat_clearing' } })).toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('a re-run changes nothing: same deployment reused, .env left byte for byte', async () => {
    const before = readFileSync(work.envPath);
    const head = await new Rpc(node.url).blockNumber();
    const again = await setupLocal(work, {}, log);
    expect(again).toMatchObject({ deployed: false, env: 'unchanged' });
    expect(readFileSync(work.envPath).equals(before)).toBe(true);
    expect(await new Rpc(node.url).blockNumber()).toBe(head); // nothing sent
    const prisma = createPrismaClient(db.url);
    try {
      expect(await prisma.deployment.count()).toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('never overwrites a .env for another deployment without --force; --force backs it up', async () => {
    const original = readFileSync(work.envPath, 'utf8');
    const edited = original.replace(
      /^TOKEN_ADDRESS=.*$/m,
      'TOKEN_ADDRESS=0x1111111111111111111111111111111111111111',
    );
    writeFileSync(work.envPath, edited);
    const r = await refusal(setupLocal(work, {}, log));
    expect(r.exitCode).toBe(2);
    expect(r.message).toContain('--force');
    expect(readFileSync(work.envPath, 'utf8')).toBe(edited);

    const forced = await setupLocal(work, { force: true }, log);
    expect(forced).toMatchObject({ deployed: false, env: 'overwrite' });
    expect(readFileSync(`${work.envPath}.bak`, 'utf8')).toBe(edited);
    expect(readFileSync(work.envPath, 'utf8')).toBe(original);
  });

  it('pnpm demo against the real worker loop and the API: CLEAN, then --rogue is caught, then a plain run is not clean (exit 1)', async () => {
    const port = await freePort();
    const env = envFrom(work.envPath, {
      API_PORT: String(port),
      LOG_LEVEL: 'error',
      POLL_INTERVAL_MS: '200',
    });
    const apiLogs: string[] = [];
    const api = await startApi(env, {
      createPrisma: createPrismaClient,
      createGateway: (config) => buildReadOnlyGateway(config.chain),
      write: (l) => apiLogs.push(l),
    });
    const signals = new EventEmitter();
    const workerLogs: string[] = [];
    const worker = runWorker(env, {
      createPrisma: createPrismaClient,
      createGateway: viemGateway,
      createInspector: () => new ViemTransactionInspector(),
      write: (l) => workerLogs.push(l),
      signals: signals as never,
    });
    const demoLogs: string[] = [];
    const demo = (rogue: boolean, runId: string) =>
      runDemo({
        apiUrl: api.url,
        platformToken: env.API_PLATFORM_TOKEN as string,
        adminToken: env.API_ADMIN_TOKEN as string,
        rpc: new Rpc(node.url),
        tokenAddress: env.TOKEN_ADDRESS as string,
        rogue,
        timeoutMs: 60_000,
        pollMs: 200,
        runId,
        log: (l) => demoLogs.push(l),
      });
    try {
      expect(await demo(false, 'clean-1')).toBe(0);
      const cleanOut = demoLogs.join('\n');
      expect(cleanOut).toContain('CLEAN: 0 mismatches');
      expect(cleanOut).toMatch(/deposit 100\.000000 to alice: ledger_reserved -> .*confirmed/);
      expect(cleanOut.match(/ {2}tx 0x[0-9a-f]{64} \(nonce \d+, \w+\)/g)).toHaveLength(3);
      expect(cleanOut).toMatch(/alice +60\.000000 \| +60\.000000 {2}equal/);
      expect(cleanOut).toMatch(/bob +25\.000000 \| +25\.000000 {2}equal/);

      demoLogs.length = 0;
      expect(await demo(true, 'rogue-1')).toBe(0);
      const rogueOut = demoLogs.join('\n');
      expect(rogueOut).toContain('CLEAN: 0 mismatches'); // before the rogue mint
      expect(rogueOut).toMatch(/MISMATCH: \d+ mismatches/);
      expect(rogueOut).toMatch(
        /- balance_mismatch \(address=0x15d34aaf54267db7d7c367839aaf71a00a2c6a65, expected=\d+, observed=\d+\)/,
      );
      expect(rogueOut).toContain('the reconciler caught the mint that bypassed the bridge.');

      // The chain is now out of line with the ledger: a plain demo must fail, not report clean.
      demoLogs.length = 0;
      expect(await demo(false, 'after-rogue')).toBe(1);
      expect(demoLogs.join('\n')).toMatch(/MISMATCH: \d+ mismatches[\s\S]*demo: FAILED/);

      for (const secret of secretsOf(work.envPath)) {
        for (const line of [...logs, ...demoLogs, ...apiLogs, ...workerLogs]) {
          expect(line.includes(secret)).toBe(false);
        }
      }
    } finally {
      signals.emit('SIGTERM');
      const code = await worker;
      await api.app.close();
      expect(code).toBe(0);
    }
  });

  it('after an Anvil restart (a fresh chain): refuses until --reset-db, which starts over cleanly', async () => {
    const port = node.port;
    await node.stop();
    node = await startAnvil([], { port });
    const r = await refusal(setupLocal(work, {}, log));
    expect(r.message).toContain('was Anvil restarted?');
    expect(r.message).toContain('pnpm setup:local --reset-db');

    const fresh = await setupLocal(work, { resetDb: true }, log);
    expect(fresh.deployed).toBe(true);
    expect(logs.some((l) => l.includes(`dropped database ${db.name} (--reset-db)`))).toBe(true);
    const prisma = createPrismaClient(db.url);
    try {
      expect(await prisma.deployment.count()).toBe(1);
      expect(await prisma.operation.count()).toBe(0);
      expect(await prisma.user.count()).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
    // Same deployer nonces on a fresh chain: the same addresses as before, so .env still fits.
    expect(fresh.env).toBe('unchanged');
  });
});
