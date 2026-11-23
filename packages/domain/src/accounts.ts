/**
 * @file The chart of accounts: which ledger accounts exist, which side each grows on, and how a
 * balance is derived from postings.
 *
 * Accounts:
 * - `fiat_clearing` (one, system-wide) is an ASSET: money the platform holds in the bank against
 *   tokens it owes. Debit-normal.
 * - `user_available`, `user_held`, `user_incoming` (one each per user) are LIABILITIES: what the
 *   platform owes the user, split by whether the user may spend it now, it is locked for an
 *   in-flight withdrawal or transfer, or it is a deposit not yet minted. Credit-normal.
 *
 * Balances are ALWAYS derived from postings and never stored. A stored balance is a second source
 * of truth that can drift from the journal; a derived one cannot.
 */

import { InvalidInputError } from './errors';

/** The kinds of ledger account. */
export type AccountKind = 'fiat_clearing' | 'user_available' | 'user_held' | 'user_incoming';

/** The account kinds that exist once per user. */
export type UserAccountKind = Exclude<AccountKind, 'fiat_clearing'>;

/** A side of a double entry. */
export type Side = 'debit' | 'credit';

/**
 * Names one ledger account. The system account has no user; every user account has exactly one.
 * The union makes "user account without a user" unrepresentable at compile time.
 */
export type AccountRef =
  | { readonly kind: 'fiat_clearing'; readonly userId?: undefined }
  | { readonly kind: UserAccountKind; readonly userId: string };

/** The minimal shape `balanceFrom` reads from a posting (kept here to avoid a cycle with ledger). */
export interface PostingLike {
  /** The account posted to. */
  readonly account: AccountRef;
  /** Which side of the account. */
  readonly side: Side;
  /** A positive amount in the token's smallest unit. */
  readonly amount: bigint;
}

const USER_KINDS: readonly AccountKind[] = ['user_available', 'user_held', 'user_incoming'];

/** The single system account. */
export const FIAT_CLEARING: AccountRef = Object.freeze({ kind: 'fiat_clearing' });

/**
 * Builds a validated account reference. Throws `InvalidInputError` when a user account has no
 * (or an empty) user id, or when the system account is given one.
 *
 * @param kind The account kind.
 * @param userId The owning user; required for user kinds, forbidden for `fiat_clearing`.
 */
export function accountRef(kind: AccountKind, userId?: string): AccountRef {
  if (kind === 'fiat_clearing') {
    if (userId !== undefined) {
      throw new InvalidInputError('fiat_clearing is a system account and takes no user id');
    }
    return FIAT_CLEARING;
  }
  if (!USER_KINDS.includes(kind)) {
    throw new InvalidInputError(`unknown account kind '${String(kind)}'`);
  }
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new InvalidInputError(`${kind} needs a non-empty user id`);
  }
  return Object.freeze({ kind, userId });
}

/** The user's spendable balance account. */
export function availableOf(userId: string): AccountRef {
  return accountRef('user_available', userId);
}

/** The user's account for funds locked by an in-flight withdrawal or transfer. */
export function heldOf(userId: string): AccountRef {
  return accountRef('user_held', userId);
}

/** The user's account for a deposit received in fiat but not yet minted on chain. */
export function incomingOf(userId: string): AccountRef {
  return accountRef('user_incoming', userId);
}

/**
 * A stable string key for an account, usable as a map key or a database column.
 * `fiat_clearing`, or `<kind>:<userId>`. The kind never contains `:`, so splitting at the FIRST
 * colon is unambiguous even when a user id contains colons.
 */
export function accountKey(account: AccountRef): string {
  return account.kind === 'fiat_clearing' ? 'fiat_clearing' : `${account.kind}:${account.userId}`;
}

/** The side on which an account's balance grows: debit for the asset, credit for liabilities. */
export function normalSide(kind: AccountKind): Side {
  return kind === 'fiat_clearing' ? 'debit' : 'credit';
}

/**
 * Derives an account's balance from postings: credits minus debits for a credit-normal account,
 * debits minus credits for a debit-normal one. Postings to other accounts are ignored.
 *
 * The result is signed on purpose: a negative balance is an invariant violation that the caller
 * must be able to see, not something this function should hide or throw on.
 */
export function balanceFrom(postings: Iterable<PostingLike>, account: AccountRef): bigint {
  const key = accountKey(account);
  const normal = normalSide(account.kind);
  let balance = 0n;
  for (const p of postings) {
    if (accountKey(p.account) !== key) continue;
    balance += p.side === normal ? p.amount : -p.amount;
  }
  return balance;
}
