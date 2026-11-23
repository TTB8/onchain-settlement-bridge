/**
 * @file Row locks for the engine: `SELECT ... FOR UPDATE` in a stable order.
 *
 * Two transactions that lock the same rows in different orders can deadlock. Locking by id list
 * sorted ascending (and letting Postgres return the rows in that order, which is the order it
 * locks them in) means every caller takes the locks in the same order.
 *
 * A row lock only lasts until the end of its transaction. Outside a transaction each statement
 * commits on its own and the lock is gone before the next query, so these helpers check that they
 * run inside one and throw otherwise.
 */

import type { SignerName } from '@prisma/client';

import type { DbClient } from './client';
import { toSortedUniqueUuids, toUuid } from './values';

/** The tables `lockRows` may lock (all have a uuid `id` primary key). */
export const LOCKABLE_TABLES = [
  'account',
  'app_user',
  'operation',
  'outbox_message',
  'compliance_change',
  'chain_attempt',
] as const;

/** A table `lockRows` may lock. */
export type LockableTable = (typeof LOCKABLE_TABLES)[number];

/** Thrown when a lock helper is used wrongly or its rows do not exist. */
export class LockError extends Error {
  /** @param message What went wrong. */
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

async function assertInTransaction(client: DbClient, what: string): Promise<void> {
  // A row lock assigns the transaction an id. If the lock statement ran in its own implicit
  // transaction, this statement runs in a fresh one that has none: the lock was already released.
  const [row] = await client.$queryRaw<{ in_tx: boolean }[]>`
    SELECT pg_current_xact_id_if_assigned() IS NOT NULL AS in_tx`;
  if (!row?.in_tx) {
    throw new LockError(
      `${what} must run inside a transaction (prisma.$transaction(async tx => ...))`,
    );
  }
}

/**
 * Locks the rows of `table` with the given ids `FOR UPDATE`, in ascending id order, and returns
 * the locked ids in that order. Throws `LockError` if any id has no row (fail closed: a caller
 * that thinks it holds a lock it does not is the bug this prevents) or if called outside a
 * transaction. Duplicate ids are locked once. An empty list locks nothing.
 *
 * @param tx The transaction client from `prisma.$transaction(async (tx) => ...)`.
 * @param table One of `LOCKABLE_TABLES` (never user input: the name is checked against the list).
 * @param ids The row ids (UUIDs).
 */
export async function lockRows(
  tx: DbClient,
  table: LockableTable,
  ids: readonly string[],
): Promise<string[]> {
  if (!(LOCKABLE_TABLES as readonly string[]).includes(table)) {
    throw new LockError(`table ${JSON.stringify(table)} is not lockable`);
  }
  const sorted = toSortedUniqueUuids(ids);
  if (sorted.length === 0) return [];
  // The table name comes from the fixed list above, never from input; the ids are a parameter.
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id::text AS id FROM "${table}" WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    sorted,
  );
  const locked = rows.map((r) => r.id);
  if (locked.length !== sorted.length) {
    const missing = sorted.filter((id) => !locked.includes(id));
    throw new LockError(`${table}: no row for ${missing.join(', ')}`);
  }
  await assertInTransaction(tx, 'lockRows');
  return locked;
}

/** The locked signer row: the address whose nonces the caller may now allocate. */
export interface LockedSigner {
  /** The deployment. */
  readonly deploymentId: string;
  /** Which signer. */
  readonly signer: SignerName;
  /** The signer's address (lowercase hex). */
  readonly address: string;
}

/**
 * Locks the `signer_state` row of (deployment, signer) `FOR UPDATE`. Hold it while allocating a
 * nonce and inserting the attempt, so two workers never hand out the same nonce. Throws
 * `LockError` if the row does not exist or if called outside a transaction.
 *
 * @param tx The transaction client.
 * @param deploymentId The deployment id (UUID).
 * @param signer `settlement` or `compliance`.
 */
export async function lockSignerState(
  tx: DbClient,
  deploymentId: string,
  signer: SignerName,
): Promise<LockedSigner> {
  const id = toUuid(deploymentId);
  const rows = await tx.$queryRaw<{ address: string }[]>`
    SELECT address FROM signer_state
     WHERE deployment_id = ${id}::uuid AND signer = ${signer}::signer_name
       FOR UPDATE`;
  const row = rows[0];
  if (!row) {
    throw new LockError(`signer_state: no ${signer} signer for deployment ${id}`);
  }
  await assertInTransaction(tx, 'lockSignerState');
  return { deploymentId: id, signer, address: row.address };
}
