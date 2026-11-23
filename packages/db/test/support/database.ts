/**
 * Test databases. Each test FILE gets a fresh database `bridge_db_test_<random>`, migrated with
 * `prisma migrate deploy` (the same, non-destructive command production uses), and drops it in
 * `afterAll`, also when tests failed. It never touches `bridge` or `bridge_test`.
 *
 * DEV ONLY: the default admin URL is the throwaway local Postgres from docker-compose.yml.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { Client, type ClientConfig } from 'pg';

import { createPrismaClient, type PrismaClient } from '../../src';

/** DEV-ONLY default: user/password `bridge`, the local docker-compose Postgres. */
const DEFAULT_ADMIN_URL = 'postgresql://bridge:bridge@localhost:5434/postgres';

const NAME = /^bridge_db_test_[0-9a-f]{16}$/;
const PACKAGE_DIR = resolve(__dirname, '..', '..');

function adminUrl(): string {
  return process.env.DB_TEST_ADMIN_URL ?? DEFAULT_ADMIN_URL;
}

function urlFor(name: string): string {
  const u = new URL(adminUrl());
  u.pathname = `/${name}`;
  return u.toString();
}

async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: adminUrl() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** A migrated, throwaway database. */
export interface TestDatabase {
  /** The database name. */
  readonly name: string;
  /** Its connection URL (dev credentials). */
  readonly url: string;
  /** A Prisma client on it. */
  readonly prisma: PrismaClient;
  /** A new raw `pg` client (connected); the caller ends it. Used for transactions that must fail at COMMIT. */
  pg(extra?: Partial<ClientConfig>): Promise<Client>;
  /** Disconnects everything and drops the database. */
  drop(): Promise<void>;
}

/** Creates and migrates a fresh database. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `bridge_db_test_${randomBytes(8).toString('hex')}`;
  await admin((c) => c.query(`CREATE DATABASE "${name}"`));
  const url = urlFor(name);
  const clients: Client[] = [];
  let prisma: PrismaClient | undefined;
  const drop = async (): Promise<void> => {
    await prisma?.$disconnect();
    await Promise.allSettled(clients.map((c) => c.end()));
    if (!NAME.test(name)) throw new Error(`refusing to drop ${name}`);
    await admin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
  };
  try {
    execFileSync(resolve(PACKAGE_DIR, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
      cwd: PACKAGE_DIR,
      env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      stdio: 'pipe',
    });
    prisma = createPrismaClient(url);
  } catch (err) {
    await drop();
    throw err;
  }
  return {
    name,
    url,
    prisma,
    async pg(extra) {
      const c = new Client({ connectionString: url, ...extra });
      await c.connect();
      clients.push(c);
      return c;
    },
    drop,
  };
}

/** Names of every leftover test database (for the "nothing left behind" check). */
export async function listTestDatabases(): Promise<string[]> {
  return admin(async (c) => {
    const r = await c.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'bridge_db_test_%' ORDER BY datname`,
    );
    return r.rows.map((x) => x.datname);
  });
}
