/**
 * Test databases for the engine. Each test FILE gets a fresh database `bridge_engine_test_<random>`,
 * migrated with the db package's own `prisma migrate deploy` (so the engine is tested against the
 * real SQL guards), and dropped in `afterAll`, also when tests failed. It never touches `bridge`.
 *
 * Same approach as packages/db/test/support/database.ts (not exported from that package), but with
 * Prisma as the admin client so the engine needs no extra driver.
 *
 * DEV ONLY: the default admin URL is the throwaway local Postgres from docker-compose.yml.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { createPrismaClient, ensureFiatClearingAccount, type PrismaClient } from '@bridge/db';

/** DEV-ONLY default: user/password `bridge`, the local docker-compose Postgres. */
const DEFAULT_ADMIN_URL = 'postgresql://bridge:bridge@localhost:5434/postgres';
const NAME = /^bridge_engine_test_[0-9a-f]{16}$/;
const DB_PACKAGE_DIR = resolve(__dirname, '..', '..', '..', 'db');

function adminUrl(): string {
  return process.env.DB_TEST_ADMIN_URL ?? DEFAULT_ADMIN_URL;
}

function urlFor(name: string, params: Record<string, string> = {}): string {
  const u = new URL(adminUrl());
  u.pathname = `/${name}`;
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

async function admin<T>(fn: (c: PrismaClient) => Promise<T>): Promise<T> {
  const c = createPrismaClient(adminUrl());
  try {
    return await fn(c);
  } finally {
    await c.$disconnect();
  }
}

/** A migrated, seeded, throwaway database. */
export interface TestDatabase {
  /** The database name. */
  readonly name: string;
  /** A Prisma client on it (pool large enough for the concurrency tests). */
  readonly prisma: PrismaClient;
  /** The fiat_clearing account id. */
  readonly fiatId: string;
  /** Another, independent client (its own pool), e.g. to hold a lock while the engine runs. */
  client(): PrismaClient;
  /** Disconnects everything and drops the database. */
  drop(): Promise<void>;
}

/** Creates, migrates and seeds a fresh database. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `bridge_engine_test_${randomBytes(8).toString('hex')}`;
  await admin((c) => c.$executeRawUnsafe(`CREATE DATABASE "${name}"`));
  const clients: PrismaClient[] = [];
  const drop = async (): Promise<void> => {
    await Promise.allSettled(clients.map((c) => c.$disconnect()));
    if (!NAME.test(name)) throw new Error(`refusing to drop ${name}`);
    await admin((c) => c.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
  };
  const client = (): PrismaClient => {
    const c = createPrismaClient(urlFor(name, { connection_limit: '25' }));
    clients.push(c);
    return c;
  };
  try {
    execFileSync(resolve(DB_PACKAGE_DIR, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
      cwd: DB_PACKAGE_DIR,
      env: { ...process.env, DATABASE_URL: urlFor(name), PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      stdio: 'pipe',
    });
    const prisma = client();
    const fiatId = await ensureFiatClearingAccount(prisma);
    return { name, prisma, fiatId, client, drop };
  } catch (err) {
    await drop();
    throw err;
  }
}
