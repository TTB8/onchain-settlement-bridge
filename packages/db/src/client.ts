/**
 * @file Creating a Prisma client, and the client type every helper in this package accepts.
 */

import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Anything that can run queries: a `PrismaClient` or the transaction client handed to
 * `prisma.$transaction(async (tx) => ...)`. Helpers that must run inside a transaction (the lock
 * helpers) say so and check it.
 */
export type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * A Prisma client bound to `databaseUrl` (the schema's `DATABASE_URL` is not read). The URL is
 * never logged by this package. The caller owns the client and must `$disconnect()` it.
 *
 * @param databaseUrl A `postgresql://` connection string.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  if (typeof databaseUrl !== 'string' || !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    // Do not echo the value: it may contain a password.
    throw new Error('createPrismaClient: databaseUrl must be a postgresql:// connection string');
  }
  return new PrismaClient({ datasourceUrl: databaseUrl });
}
