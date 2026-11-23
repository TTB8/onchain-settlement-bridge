/**
 * @file The few database writes every money path shares: resolving the domain's account names to
 * account rows, writing a journal entry with its postings, writing an audit row, and turning an
 * operation row into the record the engine returns.
 *
 * Why one place: the posting table lives in `@bridge/domain` (`buildEntry`). The engine must write
 * exactly what that function returns, never its own idea of which accounts a step touches, and
 * keeping the translation here means there is one function to review for that.
 */

import type { Operation } from '@bridge/db';
import {
  type AccountRef,
  type AuditEntry,
  type JournalEntry,
  type LedgerOperation,
} from '@bridge/domain';

import { LedgerSetupError, UnknownUserError } from './errors';
import type { Tx } from './transaction';

/** The ledger accounts and wallet of one user. */
export interface UserLedger {
  /** The user. */
  readonly userId: string;
  /** The user's wallet address (lowercase hex), as the contracts see them. */
  readonly wallet: `0x${string}`;
  /** `user_available` account id. */
  readonly available: string;
  /** `user_held` account id. */
  readonly held: string;
  /** `user_incoming` account id. */
  readonly incoming: string;
}

/**
 * The ledger accounts and wallets of the given users. Throws `UnknownUserError` when a user or any
 * of their three accounts is missing (fail closed: never post to an account we could not name).
 *
 * @param tx The transaction client.
 * @param userIds The users to load.
 */
export async function loadUserLedgers(
  tx: Tx,
  userIds: readonly string[],
): Promise<Map<string, UserLedger>> {
  const unique = [...new Set(userIds)];
  const users = await tx.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, walletAddress: true, accounts: { select: { id: true, kind: true } } },
  });
  const out = new Map<string, UserLedger>();
  for (const u of users) {
    const byKind = new Map(u.accounts.map((a) => [a.kind, a.id]));
    const available = byKind.get('user_available');
    const held = byKind.get('user_held');
    const incoming = byKind.get('user_incoming');
    if (available === undefined || held === undefined || incoming === undefined) {
      throw new UnknownUserError(`user ${u.id} is missing a ledger account`);
    }
    out.set(u.id, {
      userId: u.id,
      wallet: u.walletAddress as `0x${string}`,
      available,
      held,
      incoming,
    });
  }
  for (const id of unique) {
    if (!out.has(id)) throw new UnknownUserError(`no user ${id}`);
  }
  return out;
}

/**
 * The id of the single `fiat_clearing` account. Throws `LedgerSetupError` if the seed never ran.
 *
 * @param tx The transaction client.
 */
export async function fiatClearingId(tx: Tx): Promise<string> {
  const row = await tx.account.findFirst({
    where: { kind: 'fiat_clearing' },
    select: { id: true },
  });
  if (row === null) throw new LedgerSetupError('no fiat_clearing account: run the db seed');
  return row.id;
}

/**
 * The account row id for a domain account name.
 *
 * @param ref The domain's account reference.
 * @param users The loaded ledgers of the operation's users.
 * @param fiatId The `fiat_clearing` account id.
 */
export function accountIdFor(
  ref: AccountRef,
  users: ReadonlyMap<string, UserLedger>,
  fiatId: string,
): string {
  if (ref.kind === 'fiat_clearing') return fiatId;
  const user = users.get(ref.userId);
  if (user === undefined) throw new UnknownUserError(`no ledger loaded for user ${ref.userId}`);
  switch (ref.kind) {
    case 'user_available':
      return user.available;
    case 'user_held':
      return user.held;
    case 'user_incoming':
      return user.incoming;
  }
}

/**
 * Inserts a journal entry built by the domain and all its postings. Must run in the transaction
 * that also moves the operation's status (the database checks the two agree at COMMIT).
 *
 * @param tx The transaction client.
 * @param entry The entry from `buildEntry` (already validated as balanced).
 * @param users The loaded ledgers of the operation's users.
 * @param fiatId The `fiat_clearing` account id.
 * @param at The time to stamp on the rows.
 */
export async function writeEntry(
  tx: Tx,
  entry: JournalEntry,
  users: ReadonlyMap<string, UserLedger>,
  fiatId: string,
  at: Date,
): Promise<void> {
  const created = await tx.journalEntry.create({
    data: { operationId: entry.operationId, kind: entry.kind, createdAt: at },
    select: { id: true },
  });
  await tx.posting.createMany({
    data: entry.postings.map((p) => ({
      entryId: created.id,
      accountId: accountIdFor(p.account, users, fiatId),
      side: p.side,
      amount: p.amount,
      createdAt: at,
    })),
  });
}

/** JSON-safe extra fields stored next to the domain's audit text. */
export type AuditDetail = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Appends one audit row for a validated domain `AuditEntry`. Runs in the same transaction as the
 * change it describes, so the trail cannot miss (or invent) a change.
 *
 * @param tx The transaction client.
 * @param entry The entry from `auditEntryFor`.
 * @param extra Structured fields (ids, amounts as decimal strings); never secrets or PII.
 */
export async function writeAudit(
  tx: Tx,
  entry: AuditEntry,
  extra: AuditDetail = {},
): Promise<void> {
  await tx.auditLog.create({
    data: {
      at: entry.at,
      entity: entry.entity,
      entityId: entry.entityId,
      fromState: entry.fromState,
      toState: entry.toState,
      txHash: entry.txHash ?? null,
      detail: { ...extra, note: entry.detail },
    },
  });
}

/**
 * The domain's view of an operation row, for `buildEntry`.
 *
 * @param op The operation row.
 */
export function ledgerOperationOf(op: Operation): LedgerOperation {
  if (op.type === 'transfer') {
    if (op.counterpartyUserId === null) {
      // The database CHECK makes this impossible; refuse rather than guess a recipient.
      throw new UnknownUserError(`transfer ${op.id} has no counterparty`);
    }
    return {
      type: 'transfer',
      operationId: op.id,
      fromUserId: op.userId,
      toUserId: op.counterpartyUserId,
      amount: op.amount,
    };
  }
  return { type: op.type, operationId: op.id, userId: op.userId, amount: op.amount };
}

/** The users an operation's ledger entries can touch. */
export function partiesOf(op: Operation): string[] {
  return op.counterpartyUserId === null ? [op.userId] : [op.userId, op.counterpartyUserId];
}
