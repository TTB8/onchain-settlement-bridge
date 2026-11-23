/**
 * The end-to-end stack of one test file, every part real:
 *
 * - Postgres: a fresh database `bridge_e2e_test_<hex>` on the shared docker-compose server
 *   (localhost:5434, DEV ONLY credentials). Other suites use that server at the same time, so only
 *   databases matching that name are ever created or dropped. `setup:local` itself creates it
 *   (and migrates it), exactly as it does the dev database.
 * - A native `anvil` on a free port (the chain package's test helper), killed in `close()` and,
 *   as a safety net, when the test process exits.
 * - The contracts deployed and promoted by `runSetupLocal` (forge script + promote-deployment.sh),
 *   which also registers the deployment and writes the `.env` this stack runs on (in a temp dir).
 * - The API started by the API's own `startApi` on a free port, from that `.env`.
 * - A `BridgeEngine` built the way the worker builds it (`loadWorkerConfig`, the worker's
 *   `viemGateway`, `ViemTransactionInspector`), ticked by the test.
 *
 * DEV ONLY: the only keys are the two labelled Anvil dev keys of `.env.example`; the only other
 * accounts are Anvil's public dev accounts, used through the node (unlocked), never by key.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createPrismaClient, type PrismaClient } from '@bridge/db';
import {
  AlarmLog,
  BridgeEngine,
  randomIds,
  systemClock,
  ViemTransactionInspector,
} from '@bridge/engine';
import { type Env, loadWorkerConfig, secretValues } from '@bridge/engine/env';

import { startApi } from '../../../apps/api/src/app';
import { buildReadOnlyGateway } from '../../../apps/api/src/chain/read-only-gateway';
import { viemGateway } from '../../../apps/worker/src/worker';
import { type AnvilNode, freePort, startAnvil } from '../../../packages/chain/test/support/anvil';
import { parseEnvFile, renderEnv } from '../../../scripts/lib/local-env';
import { Rpc } from '../../../scripts/lib/rpc';
import { runSetupLocal, type SetupResult } from '../../../scripts/lib/setup';

/** The API application as `startApi` returns it. */
type NestExpressApplication = Awaited<ReturnType<typeof startApi>>['app'];

/** The repository root. */
export const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/** DEV-ONLY default: the throwaway docker-compose Postgres. */
const DEFAULT_ADMIN_URL = 'postgresql://bridge:bridge@localhost:5434/postgres';
const NAME = /^bridge_e2e_test_[0-9a-f]{16}$/;

/** Anvil's dev accounts #4 and #5, the demo's and the suite's users (public addresses). */
export const ALICE = '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65';
/** Dev account #5. */
export const BOB = '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc';

function adminUrl(): string {
  return process.env.DB_TEST_ADMIN_URL ?? DEFAULT_ADMIN_URL;
}

/** A per-file database name and URL; nothing is created (setup:local creates it). */
export function reserveDatabase(): { name: string; url: string; drop: () => Promise<void> } {
  const name = `bridge_e2e_test_${randomBytes(8).toString('hex')}`;
  const u = new URL(adminUrl());
  u.pathname = `/${name}`;
  const drop = async (): Promise<void> => {
    if (!NAME.test(name)) throw new Error(`refusing to drop ${name}`);
    const admin = createPrismaClient(adminUrl());
    try {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await admin.$disconnect();
    }
  };
  return { name, url: u.toString(), drop };
}

/** A temp directory holding the stack's `.env`, template and deployment record. */
export interface Workdir {
  /** The directory. */
  readonly dir: string;
  /** `<dir>/.env`. */
  readonly envPath: string;
  /** `<dir>/.env.example`: the repository template pointed at this file's database and node. */
  readonly templatePath: string;
  /** `<dir>/deployments`. */
  readonly deploymentsDir: string;
  /** Removes the directory. */
  remove(): void;
}

/**
 * A temp workdir whose template is the repository's `.env.example` with DATABASE_URL and RPC_URL
 * pointed at this file's database and anvil (every other line unchanged).
 *
 * @param databaseUrl This file's database.
 * @param rpcUrl This file's anvil.
 */
export function makeWorkdir(databaseUrl: string, rpcUrl: string): Workdir {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-e2e-'));
  const templatePath = join(dir, '.env.example');
  const template = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');
  writeFileSync(templatePath, renderEnv(template, { DATABASE_URL: databaseUrl, RPC_URL: rpcUrl }));
  return {
    dir,
    envPath: join(dir, '.env'),
    templatePath,
    deploymentsDir: join(dir, 'deployments'),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Runs the real `setup:local` for a workdir (no git check: the temp dir is not in a repository).
 *
 * @param w The workdir.
 * @param flags The flags.
 * @param log Where its lines go (default: dropped).
 */
export function setupLocal(
  w: Workdir,
  flags: { force?: boolean; resetDb?: boolean } = {},
  log: (line: string) => void = () => undefined,
): Promise<SetupResult> {
  return runSetupLocal({
    repoRoot: REPO_ROOT,
    envPath: w.envPath,
    templatePath: w.templatePath,
    deploymentsDir: w.deploymentsDir,
    flags: { force: flags.force ?? false, resetDb: flags.resetDb ?? false, help: false },
    checkGitIgnore: false,
    log,
  });
}

/** Everything a scenario needs. */
export interface Stack {
  /** The anvil. */
  readonly node: AnvilNode;
  /** JSON-RPC on it. */
  readonly rpc: Rpc;
  /** The database (a client of the test's own). */
  readonly prisma: PrismaClient;
  /** The environment the API and the engine run on (the written `.env`, plus API_PORT). */
  readonly env: Env;
  /** The setup result (deployment id, addresses). */
  readonly setup: SetupResult;
  /** The API's base URL. */
  readonly apiUrl: string;
  /** The API (listening). */
  readonly app: NestExpressApplication;
  /** API log lines. */
  readonly apiLogs: string[];
  /** The engine (the worker's role), ticked by the test. */
  readonly engine: BridgeEngine;
  /** The engine's alarms. */
  readonly alarms: AlarmLog;
  /** Ticks the engine until `done` resolves true (bounded; a short pause between ticks). */
  tickUntil(done: () => Promise<boolean>, what: string, maxTicks?: number): Promise<void>;
  /** Stops everything and drops the database (safe to call twice, after a partial start). */
  close(): Promise<void>;
}

/** Reads `.env` into an Env, with overrides. */
export function envFrom(path: string, overrides: Record<string, string> = {}): Env {
  return { ...parseEnvFile(readFileSync(path, 'utf8')), ...overrides };
}

/**
 * Starts the whole stack. On any failure what was started is stopped before rethrowing.
 *
 * @param options `logLevel` for the API (default error).
 */
export async function startStack(options: { logLevel?: string } = {}): Promise<Stack> {
  const db = reserveDatabase();
  let node: AnvilNode | undefined;
  let work: Workdir | undefined;
  let prisma: PrismaClient | undefined;
  let app: NestExpressApplication | undefined;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await app?.close().catch(() => undefined);
    await prisma?.$disconnect().catch(() => undefined);
    await node?.stop().catch(() => undefined);
    work?.remove();
    await db.drop();
  };
  try {
    node = await startAnvil();
    work = makeWorkdir(db.url, node.url);
    const setup = await setupLocal(work);
    const port = await freePort();
    const env = envFrom(work.envPath, {
      API_PORT: String(port),
      LOG_LEVEL: options.logLevel ?? 'error',
    });
    prisma = createPrismaClient(env.DATABASE_URL as string);
    const apiLogs: string[] = [];
    const started = await startApi(env, {
      createPrisma: createPrismaClient,
      createGateway: (config) => buildReadOnlyGateway(config.chain),
      write: (line) => apiLogs.push(line),
    });
    app = started.app;

    const config = loadWorkerConfig(env);
    const gateway = viemGateway(config);
    const alarms = new AlarmLog();
    const engine = new BridgeEngine(
      {
        prisma,
        gateway,
        inspector: new ViemTransactionInspector(),
        clock: systemClock,
        ids: randomIds,
        alarms,
      },
      {
        chainId: BigInt(config.chain.chainId),
        tokenAddress: config.chain.tokenAddress,
        workerId: 'e2e-worker',
        confirmationDepth: config.chain.confirmationDepth,
        feeCap: config.feeCapWei,
        // Reconciliation is triggered through the API in these tests, never by the tick.
        reconcileEveryTicks: 1_000_000,
        secrets: secretValues(config),
      },
    );
    await engine.assertDeployment();

    const tickUntil = async (
      done: () => Promise<boolean>,
      what: string,
      maxTicks = 40,
    ): Promise<void> => {
      for (let i = 0; i < maxTicks; i += 1) {
        await engine.tick();
        if (await done()) return;
        // Anvil seals the block a moment after it answers the send: a bounded pause, not a sleep
        // that a test relies on for correctness.
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`${what}: not reached after ${maxTicks} ticks`);
    };

    return {
      node,
      rpc: new Rpc(node.url),
      prisma,
      env,
      setup,
      apiUrl: started.url,
      app,
      apiLogs,
      engine,
      alarms,
      tickUntil,
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

/** A JSON HTTP response. */
export interface JsonResponse {
  /** HTTP status. */
  readonly status: number;
  /** Lowercase header names. */
  readonly headers: Headers;
  /** The parsed body (null when empty). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly body: any;
}

/**
 * One request to the API with a bearer token.
 *
 * @param base The API's base URL.
 * @param token The bearer token.
 * @param method HTTP method.
 * @param path The path.
 * @param options Body and headers.
 */
export async function call(
  base: string,
  token: string | undefined,
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<JsonResponse> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text === '' ? null : JSON.parse(text) };
}
