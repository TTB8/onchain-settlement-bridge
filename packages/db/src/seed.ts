/**
 * @file The only seed data the bridge needs: the single `fiat_clearing` system account.
 */

import type { DbClient } from './client';

/**
 * Creates the `fiat_clearing` account if it does not exist and returns its id. Idempotent and
 * safe to run concurrently: the partial unique index makes a second insert a no-op.
 *
 * @param client A Prisma client or transaction client.
 */
export async function ensureFiatClearingAccount(client: DbClient): Promise<string> {
  await client.$executeRaw`
    INSERT INTO account (kind) VALUES ('fiat_clearing')
    ON CONFLICT (kind) WHERE kind = 'fiat_clearing' DO NOTHING`;
  const rows = await client.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM account WHERE kind = 'fiat_clearing'`;
  const row = rows[0];
  /* istanbul ignore next -- the insert above guarantees the row; this is a fail-closed check. */
  if (!row) throw new Error('fiat_clearing account missing after seed');
  return row.id;
}
