/**
 * @file Reading derived balances from the `account_balance` view.
 *
 * Balances are never stored: the view sums each account's postings in the account's normal
 * direction. Prisma cannot model a view with our guarantees, so this helper reads it with a typed
 * raw query. To act on a balance (reserve against it), read it under `lockRows` in the same
 * transaction; see README "The engine's obligation".
 */

import { Prisma, type AccountKind } from '@prisma/client';

import type { DbClient } from './client';
import { toSortedUniqueUuids } from './values';

/** One row of the `account_balance` view. */
export interface AccountBalance {
  /** The account. */
  readonly accountId: string;
  /** Its kind. */
  readonly kind: AccountKind;
  /** Its owner; null only for `fiat_clearing`. */
  readonly userId: string | null;
  /** The derived balance in the token's smallest unit, in the account's normal direction. */
  readonly balance: bigint;
}

/** Which balances to read: by account ids, or every account of the given users. */
export type BalanceSelector =
  { readonly accountIds: readonly string[] } | { readonly userIds: readonly string[] };

interface BalanceRow {
  account_id: string;
  kind: AccountKind;
  user_id: string | null;
  balance: bigint | number | string;
}

/**
 * The balances of the selected accounts, ordered by account id. Ids that match no account are
 * simply absent. Every id is validated as a UUID first (a malformed id throws `DbValueError`).
 *
 * @param client A Prisma client or transaction client.
 * @param selector `{ accountIds }` or `{ userIds }`.
 */
export async function readBalances(
  client: DbClient,
  selector: BalanceSelector,
): Promise<AccountBalance[]> {
  const byAccount = 'accountIds' in selector;
  const ids = toSortedUniqueUuids(byAccount ? selector.accountIds : selector.userIds);
  if (ids.length === 0) return [];
  const column = byAccount ? Prisma.sql`account_id` : Prisma.sql`user_id`;
  const rows = await client.$queryRaw<BalanceRow[]>`
    SELECT account_id, kind::text AS kind, user_id, balance
      FROM account_balance
     WHERE ${column} = ANY(${ids}::uuid[])
     ORDER BY account_id`;
  return rows.map((r) => ({
    accountId: r.account_id,
    kind: r.kind,
    userId: r.user_id,
    balance: BigInt(r.balance),
  }));
}
