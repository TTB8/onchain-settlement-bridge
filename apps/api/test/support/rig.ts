/**
 * Test rig for the API: a fresh Postgres database per test FILE (migrated with the db package's
 * own `prisma migrate deploy`, so every SQL guard is live), a `FakeChainGateway` with its
 * deployment row and signer rows, the API built on both, and a `BridgeEngine` on the same
 * database and chain to tick operations along (standing in for the worker process).
 *
 * The shared Postgres on localhost:5434 (docker-compose, DEV ONLY credentials `bridge`) is used by
 * other suites at the same time, so only per-file databases named `bridge_api_test_<hex>` are
 * created and only those are ever dropped.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import {
  type Address,
  type ContractCall,
  FakeChainGateway,
  type FakeChainOptions,
  type Hex,
  SIGNER_FOR_CALL,
  type SignerName,
} from '@bridge/chain';
import { createPrismaClient, ensureFiatClearingAccount, type PrismaClient } from '@bridge/db';
import {
  AlarmLog,
  BridgeEngine,
  type Clock,
  type DecodedTransaction,
  type IdSource,
  type RawTransactionInspector,
} from '@bridge/engine';
import { type ApiConfig, loadApiConfig } from '@bridge/engine/env';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { hexToString } from 'viem';

import { createApiApp } from '../../src/app';
import { JsonLogger } from '../../src/core/logger';

/** DEV-ONLY default: the throwaway docker-compose Postgres. */
const DEFAULT_ADMIN_URL = 'postgresql://bridge:bridge@localhost:5434/postgres';
const NAME = /^bridge_api_test_[0-9a-f]{16}$/;
const DB_PACKAGE_DIR = resolve(__dirname, '..', '..', '..', '..', 'packages', 'db');

/** The two test tokens (well above the minimum length; test-only values). */
export const PLATFORM = 'test-platform-token-0123456789abcdefghij';
/** The admin test token. */
export const ADMIN = 'test-admin-token-0123456789abcdefghijklmn';

function adminUrl(): string {
  return process.env.DB_TEST_ADMIN_URL ?? DEFAULT_ADMIN_URL;
}

function urlFor(name: string): string {
  const u = new URL(adminUrl());
  u.pathname = `/${name}`;
  u.searchParams.set('connection_limit', '10');
  return u.toString();
}

async function asAdmin(fn: (c: PrismaClient) => Promise<unknown>): Promise<void> {
  const c = createPrismaClient(adminUrl());
  try {
    await fn(c);
  } finally {
    await c.$disconnect();
  }
}

/** A migrated, seeded, throwaway database. */
export interface TestDatabase {
  /** Name. */
  readonly name: string;
  /** Connection string (DEV ONLY credentials). */
  readonly url: string;
  /** A client. */
  readonly prisma: PrismaClient;
  /** Disconnects and drops it. */
  drop(): Promise<void>;
}

/** Creates, migrates and seeds a fresh database. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `bridge_api_test_${randomBytes(8).toString('hex')}`;
  await asAdmin((c) => c.$executeRawUnsafe(`CREATE DATABASE "${name}"`));
  const url = urlFor(name);
  const prisma = createPrismaClient(url);
  const drop = async (): Promise<void> => {
    await prisma.$disconnect().catch(() => undefined);
    if (!NAME.test(name)) throw new Error(`refusing to drop ${name}`);
    await asAdmin((c) => c.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
  };
  try {
    execFileSync(resolve(DB_PACKAGE_DIR, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
      cwd: DB_PACKAGE_DIR,
      env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      stdio: 'pipe',
    });
    await ensureFiatClearingAccount(prisma);
    return { name, url, prisma, drop };
  } catch (err) {
    await drop();
    throw err;
  }
}

const RAW_PREFIX = 'fake-eip1559-tx:';

/**
 * Decodes the fake gateway's documented signed encoding (`fake-eip1559-tx:` + JSON, bigints as
 * `"<n>n"`). The fake's bytes carry no target address; the contract is implied by the call kind.
 */
export class FakeInspector implements RawTransactionInspector {
  /** @param chain The fake. */
  constructor(private readonly chain: FakeChainGateway) {}

  async decode(raw: Hex): Promise<DecodedTransaction> {
    const text = hexToString(raw);
    if (!text.startsWith(RAW_PREFIX)) throw new TypeError('not a fake signed transaction');
    const d = JSON.parse(text.slice(RAW_PREFIX.length), (_k, v: unknown) =>
      typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
    ) as {
      chainId: number;
      from: Address;
      nonce: number;
      call: ContractCall;
      fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    };
    const dep = this.chain.deployment();
    const signer: SignerName = SIGNER_FOR_CALL[d.call.kind];
    return {
      type: 'eip1559',
      chainId: d.chainId,
      nonce: d.nonce,
      to: signer === 'settlement' ? dep.token : dep.registry,
      call: d.call,
      maxFeePerGas: d.fees.maxFeePerGas,
      maxPriorityFeePerGas: d.fees.maxPriorityFeePerGas,
      from: d.from,
      value: 0n,
      gas: null,
    };
  }
}

/** A clock that moves only when told to. */
export class TestClock implements Clock {
  private t = Date.UTC(2026, 10, 23, 12, 0, 0);
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Random v4 UUIDs. */
export const testIds: IdSource = { uuid: () => randomUUID() };

/** The environment the rig's API is configured from (local chain, DEV values only). */
export function testEnv(chain: FakeChainGateway, url: string): Record<string, string> {
  return {
    DATABASE_URL: url,
    RPC_URL: 'http://127.0.0.1:8545',
    CHAIN_ID: String(chain.chainId),
    TOKEN_ADDRESS: chain.tokenAddress,
    REGISTRY_ADDRESS: chain.registryAddress,
    CONFIRMATION_DEPTH: '1',
    API_PLATFORM_TOKEN: PLATFORM,
    API_ADMIN_TOKEN: ADMIN,
    API_MAX_AMOUNT: '1000000000000',
    API_BODY_LIMIT_BYTES: '2048',
    LOG_LEVEL: 'error',
  };
}

/** Everything an HTTP test needs. */
export interface Rig {
  /** The database. */
  readonly db: TestDatabase;
  /** The fake chain. */
  readonly chain: FakeChainGateway;
  /** The deployment row id. */
  readonly deploymentId: string;
  /** The API (initialised, not listening). */
  readonly app: NestExpressApplication;
  /** The API's configuration. */
  readonly config: ApiConfig;
  /** An engine on the same database and chain (the worker's role). */
  readonly engine: BridgeEngine;
  /** Its alarms. */
  readonly alarms: AlarmLog;
  /** The shared clock. */
  readonly clock: TestClock;
  /** Every log line the API wrote. */
  readonly logs: string[];
  /** Closes the app and drops the database. */
  close(): Promise<void>;
}

/** Inserts the deployment row (active) and its signer rows for `chain`. */
export async function registerDeployment(
  prisma: PrismaClient,
  chain: FakeChainGateway,
): Promise<string> {
  const d = await prisma.deployment.create({
    data: {
      chainId: BigInt(chain.chainId),
      tokenAddress: chain.tokenAddress,
      registryAddress: chain.registryAddress,
      deploymentBlock: 0n,
      active: true,
    },
  });
  await prisma.signerState.createMany({
    data: [
      { deploymentId: d.id, signer: 'settlement', address: chain.signerAddress('settlement') },
      { deploymentId: d.id, signer: 'compliance', address: chain.signerAddress('compliance') },
    ],
  });
  return d.id;
}

/**
 * A database, a fake chain with its deployment registered, the API and an engine.
 *
 * @param options `register`: insert the deployment row (default true); chain options.
 */
export async function makeRig(
  options: { register?: boolean; chain?: FakeChainOptions; env?: Record<string, string> } = {},
): Promise<Rig> {
  const db = await createTestDatabase();
  const chain = new FakeChainGateway({ chainId: 31337, ...options.chain });
  const deploymentId = options.register === false ? '' : await registerDeployment(db.prisma, chain);
  const config = loadApiConfig({ ...testEnv(chain, db.url), ...options.env });
  const logs: string[] = [];
  const logger = new JsonLogger({
    level: 'debug',
    secrets: [PLATFORM, ADMIN, db.url],
    service: 'api-test',
    write: (l) => logs.push(l),
  });
  const clock = new TestClock();
  const alarms = new AlarmLog();
  const app = await createApiApp({
    config,
    prisma: db.prisma,
    gateway: chain,
    clock,
    ids: testIds,
    logger,
    alarms,
  });
  await app.init();
  const engine = new BridgeEngine(
    {
      prisma: db.prisma,
      gateway: chain,
      inspector: new FakeInspector(chain),
      clock,
      ids: testIds,
      alarms,
    },
    {
      workerId: 'api-test-worker',
      confirmationDepth: 1,
      feeCap: 10n ** 12n,
      reconcileEveryTicks: 1_000_000,
    },
  );
  return {
    db,
    chain,
    deploymentId,
    app,
    config,
    engine,
    alarms,
    clock,
    logs,
    close: async () => {
      await app.close();
      await db.drop();
    },
  };
}

/** Sets a registry flag directly on the fake chain (as the compliance signer) and mines it. */
export async function setVerifiedOnChain(chain: FakeChainGateway, account: string): Promise<void> {
  const { pending } = await chain.getNonce('compliance');
  const fees = await chain.estimateFees();
  await chain.submit({
    signer: 'compliance',
    call: {
      kind: 'setVerified',
      account: account as Address,
      verified: true,
      ref: `0x${randomBytes(32).toString('hex')}`,
    },
    nonce: pending,
    fees,
  });
  chain.mine();
}

/** Ticks the engine `n` times, mining a block after each (depth 1 means one block is final). */
export async function settle(rig: Rig, n = 4): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await rig.engine.tick();
    rig.chain.mine();
    rig.clock.advance(1_000);
  }
}

/** A random lowercase wallet address. */
export const wallet = (): string => `0x${randomBytes(20).toString('hex')}`;
