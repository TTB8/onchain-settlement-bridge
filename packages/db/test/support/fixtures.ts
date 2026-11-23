/**
 * Raw-SQL fixtures for the guard tests. They write rows exactly as the engine will (an entry and
 * its postings in one transaction, reserve first, then settle or reverse), so a test that uses them
 * proves the guards do not block valid use.
 *
 * The posting table below is written out by hand (the same table as @bridge/domain ledger.ts), so
 * the expected balances in the tests are hand-computed, not derived from code under test.
 */

import { randomBytes } from 'node:crypto';

import type { Client } from 'pg';

/** Anything with pg's `query`. */
export type Sql = Pick<Client, 'query'>;

/** Random lowercase 0x hex of `bytes` bytes. */
export function hex(bytes: number): string {
  return `0x${randomBytes(bytes).toString('hex')}`;
}

/** A random 20-byte address. */
export const address = (): string => hex(20);
/** A random non-zero 32-byte reference / hash. */
export const ref = (): string => hex(32);

/** The zero reference the contracts reject. */
export const ZERO_REF = `0x${'0'.repeat(64)}`;

/** Inserts a deployment (active by default) and returns its id and contract addresses. */
export async function insertDeployment(
  sql: Sql,
  opts: { active?: boolean; chainId?: number } = {},
): Promise<{ id: string; token: string; registry: string }> {
  const token = address();
  const registry = address();
  const r = await sql.query<{ id: string }>(
    `INSERT INTO deployment (chain_id, token_address, registry_address, deployment_block, active)
     VALUES ($1, $2, $3, 1, $4) RETURNING id`,
    [opts.chainId ?? 31337 + Math.floor(Math.random() * 1e6), token, registry, opts.active ?? true],
  );
  return { id: r.rows[0]!.id, token, registry };
}

/** The system account id, created if missing. */
export async function fiatClearing(sql: Sql): Promise<string> {
  await sql.query(
    `INSERT INTO account (kind) VALUES ('fiat_clearing')
     ON CONFLICT (kind) WHERE kind = 'fiat_clearing' DO NOTHING`,
  );
  const r = await sql.query<{ id: string }>(`SELECT id FROM account WHERE kind = 'fiat_clearing'`);
  return r.rows[0]!.id;
}

/** A user and its three ledger accounts. */
export interface TestUser {
  id: string;
  wallet: string;
  available: string;
  held: string;
  incoming: string;
}

/** Inserts a user with its available, held and incoming accounts. */
export async function insertUser(sql: Sql): Promise<TestUser> {
  const wallet = address();
  const u = await sql.query<{ id: string }>(
    `INSERT INTO app_user (wallet_address, verified) VALUES ($1, true) RETURNING id`,
    [wallet],
  );
  const id = u.rows[0]!.id;
  const accounts: Record<string, string> = {};
  for (const kind of ['user_available', 'user_held', 'user_incoming']) {
    const a = await sql.query<{ id: string }>(
      `INSERT INTO account (kind, user_id) VALUES ($1, $2) RETURNING id`,
      [kind, id],
    );
    accounts[kind] = a.rows[0]!.id;
  }
  return {
    id,
    wallet,
    available: accounts.user_available!,
    held: accounts.user_held!,
    incoming: accounts.user_incoming!,
  };
}

/** Operation types. */
export type OpType = 'deposit' | 'withdrawal' | 'transfer';
/** Journal kinds. */
export type Kind = 'reserve' | 'settle' | 'reverse';
/** One posting as [accountId, side]. */
export type Line = readonly [string, 'debit' | 'credit'];

/**
 * THE posting table (hand-written; mirrors @bridge/domain ledger.ts):
 *
 * | operation  | reserve                  | settle                   | reverse                  |
 * | deposit    | Dr fiat / Cr incoming(U) | Dr incoming(U) / Cr av(U)| Dr incoming(U) / Cr fiat |
 * | withdrawal | Dr av(U) / Cr held(U)    | Dr held(U) / Cr fiat     | Dr held(U) / Cr av(U)    |
 * | transfer   | Dr av(F) / Cr held(F)    | Dr held(F) / Cr av(T)    | Dr held(F) / Cr av(F)    |
 */
export function linesFor(
  type: OpType,
  kind: Kind,
  fiat: string,
  user: TestUser,
  counterparty?: TestUser,
): [Line, Line] {
  const dr = (a: string): Line => [a, 'debit'];
  const cr = (a: string): Line => [a, 'credit'];
  switch (`${type}:${kind}`) {
    case 'deposit:reserve':
      return [dr(fiat), cr(user.incoming)];
    case 'deposit:settle':
      return [dr(user.incoming), cr(user.available)];
    case 'deposit:reverse':
      return [dr(user.incoming), cr(fiat)];
    case 'withdrawal:reserve':
      return [dr(user.available), cr(user.held)];
    case 'withdrawal:settle':
      return [dr(user.held), cr(fiat)];
    case 'withdrawal:reverse':
      return [dr(user.held), cr(user.available)];
    case 'transfer:reserve':
      return [dr(user.available), cr(user.held)];
    case 'transfer:settle':
      return [dr(user.held), cr(counterparty!.available)];
    case 'transfer:reverse':
      return [dr(user.held), cr(user.available)];
    default:
      throw new Error(`no lines for ${type}:${kind}`);
  }
}

/** Inserts an operation (no ledger entries) and returns its id. */
export async function insertOperation(
  sql: Sql,
  o: {
    deploymentId: string;
    type: OpType;
    userId: string;
    counterpartyUserId?: string | null;
    amount: bigint;
    status?: string;
    ref?: string;
    idempotencyKey?: string | null;
  },
): Promise<string> {
  const r = await sql.query<{ id: string }>(
    `INSERT INTO operation (deployment_id, type, status, user_id, counterparty_user_id, amount, ref, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      o.deploymentId,
      o.type,
      o.status ?? 'requested',
      o.userId,
      o.counterpartyUserId ?? null,
      o.amount.toString(),
      o.ref ?? ref(),
      o.idempotencyKey ?? null,
    ],
  );
  return r.rows[0]!.id;
}

/** Inserts a journal entry and its postings (no BEGIN/COMMIT: the caller owns the transaction). */
export async function insertEntry(
  sql: Sql,
  operationId: string,
  kind: Kind,
  lines: readonly Line[],
  amount: bigint | readonly bigint[],
): Promise<string> {
  const e = await sql.query<{ id: string }>(
    `INSERT INTO journal_entry (operation_id, kind) VALUES ($1, $2) RETURNING id`,
    [operationId, kind],
  );
  const entryId = e.rows[0]!.id;
  for (const [i, [account, side]] of lines.entries()) {
    const a = Array.isArray(amount) ? (amount as readonly bigint[])[i]! : (amount as bigint);
    await sql.query(
      `INSERT INTO posting (entry_id, account_id, side, amount) VALUES ($1, $2, $3, $4)`,
      [entryId, account, side, a.toString()],
    );
  }
  return entryId;
}

/** Moves an operation to `status`, bumping version as the guard requires. */
export async function setStatus(
  sql: Sql,
  operationId: string,
  status: string,
  extra: { failureReason?: string; confirmedBlock?: bigint } = {},
): Promise<void> {
  await sql.query(
    `UPDATE operation SET status = $2, version = version + 1, updated_at = now(),
            failure_reason = COALESCE($3::failure_reason, failure_reason),
            confirmed_block = $4
      WHERE id = $1`,
    [
      operationId,
      status,
      extra.failureReason ?? null,
      status === 'confirmed' ? (extra.confirmedBlock ?? 100n).toString() : null,
    ],
  );
}

/** Runs `fn` inside BEGIN/COMMIT on `c`; rolls back if `fn` throws. The COMMIT error propagates. */
export async function tx<T>(c: Sql, fn: () => Promise<T>): Promise<T> {
  await c.query('BEGIN');
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  }
  await c.query('COMMIT');
  return result;
}

/**
 * The engine's write pattern, end to end, for one operation:
 *   tx 1: insert the operation, write the reserve entry, move to ledger_reserved;
 *   tx 2: submitted;
 *   tx 3: confirmed + settle entry   (outcome 'settle')
 *      or failed, then tx 4: reversed + reverse entry   (outcome 'reverse').
 */
export async function runLifecycle(
  c: Sql,
  p: {
    deploymentId: string;
    type: OpType;
    fiat: string;
    user: TestUser;
    counterparty?: TestUser;
    amount: bigint;
    outcome: 'settle' | 'reverse' | 'reserve-only';
  },
): Promise<string> {
  const lines = (kind: Kind) => linesFor(p.type, kind, p.fiat, p.user, p.counterparty);
  const opId = await tx(c, async () => {
    const id = await insertOperation(c, {
      deploymentId: p.deploymentId,
      type: p.type,
      userId: p.user.id,
      counterpartyUserId: p.counterparty?.id ?? null,
      amount: p.amount,
    });
    await insertEntry(c, id, 'reserve', lines('reserve'), p.amount);
    await setStatus(c, id, 'ledger_reserved');
    return id;
  });
  if (p.outcome === 'reserve-only') return opId;
  await tx(c, () => setStatus(c, opId, 'submitted'));
  if (p.outcome === 'settle') {
    await tx(c, async () => {
      await setStatus(c, opId, 'confirmed');
      await insertEntry(c, opId, 'settle', lines('settle'), p.amount);
    });
  } else {
    await tx(c, () => setStatus(c, opId, 'failed', { failureReason: 'reverted' }));
    await tx(c, async () => {
      await setStatus(c, opId, 'reversed');
      await insertEntry(c, opId, 'reverse', lines('reverse'), p.amount);
    });
  }
  return opId;
}

/** Balance of one account from the view. */
export async function balance(sql: Sql, accountId: string): Promise<bigint> {
  const r = await sql.query<{ balance: string }>(
    `SELECT balance::text AS balance FROM account_balance WHERE account_id = $1`,
    [accountId],
  );
  return BigInt(r.rows[0]!.balance);
}

/** Asserts `p` rejects with a Postgres error whose message contains `needle`. */
export async function expectPgError(p: Promise<unknown>, needle: string | RegExp): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  if (caught === undefined) {
    throw new Error(`expected an error matching ${String(needle)}, but it succeeded`);
  }
  const msg = caught instanceof Error ? caught.message : String(caught);
  const ok = typeof needle === 'string' ? msg.includes(needle) : needle.test(msg);
  if (!ok) {
    throw new Error(`expected an error matching ${String(needle)}, got: ${msg}`);
  }
}
