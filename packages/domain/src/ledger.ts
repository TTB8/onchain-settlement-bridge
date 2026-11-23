/**
 * @file The double-entry journal: what a valid entry is, which entries each operation writes, how
 * balances follow from them, and what a settled operation means on chain.
 *
 * The three entries per operation (reserve, settle, reverse) are written out as a table below so
 * that a reviewer can check every debit and credit against the chart of accounts in one place.
 *
 * The invariant that ties the ledger to the chain: for every user, `available + held` equals the
 * token balance the chain should show for that user's address. `incoming` is excluded because a
 * deposit is not on chain until it is minted. `fiat_clearing` equals the sum of every user's
 * `available + held + incoming`: every token owed is backed by fiat the platform holds.
 */

import {
  type AccountRef,
  accountKey,
  availableOf,
  FIAT_CLEARING,
  heldOf,
  incomingOf,
  normalSide,
  type Side,
} from './accounts';
import {
  InsufficientFundsError,
  InvalidInputError,
  SelfTransferError,
  UnbalancedEntryError,
} from './errors';
import { assertPositiveAmount, checkedAdd } from './money';
import type { JournalKind, OperationParties, OperationType } from './operation';
import { assertAddress, type Address } from './primitives';

/** One line of a journal entry: an amount on one side of one account. */
export interface Posting {
  /** The account posted to. */
  readonly account: AccountRef;
  /** Debit or credit. */
  readonly side: Side;
  /** A positive amount in the token's smallest unit, within the ledger cap. */
  readonly amount: bigint;
}

/** A balanced set of postings written atomically for one step of one operation. */
export interface JournalEntry {
  /** The operation this entry belongs to. With `kind`, unique in the ledger (one entry per step). */
  readonly operationId: string;
  /** Which step of the operation wrote it. */
  readonly kind: JournalKind;
  /** At least two postings whose debits equal their credits. */
  readonly postings: readonly Posting[];
}

/** The ledger-side description of an operation: who, how much, and its id. */
export type LedgerOperation =
  | {
      readonly type: 'deposit';
      readonly operationId: string;
      readonly userId: string;
      readonly amount: bigint;
    }
  | {
      readonly type: 'withdrawal';
      readonly operationId: string;
      readonly userId: string;
      readonly amount: bigint;
    }
  | {
      readonly type: 'transfer';
      readonly operationId: string;
      readonly fromUserId: string;
      readonly toUserId: string;
      readonly amount: bigint;
    };

/**
 * Throws `UnbalancedEntryError` (or `InvalidAmountError` for a bad amount) unless the entry is a
 * valid double entry: at least two postings, every amount positive and within the cap, and total
 * debits equal to total credits. Totals use checked addition, so an entry whose totals would not
 * fit the ledger is refused rather than wrapped.
 */
export function assertBalanced(entry: JournalEntry): void {
  if (entry.postings.length < 2) {
    throw new UnbalancedEntryError(
      entry.operationId,
      0n,
      0n,
      `entry for ${entry.operationId} has ${entry.postings.length} posting(s); a double entry needs at least 2`,
    );
  }
  let debits = 0n;
  let credits = 0n;
  for (const p of entry.postings) {
    assertPositiveAmount(p.amount);
    if (p.side === 'debit') {
      debits = checkedAdd(debits, p.amount);
    } else if (p.side === 'credit') {
      credits = checkedAdd(credits, p.amount);
    } else {
      throw new InvalidInputError(`posting side must be debit or credit, got ${String(p.side)}`);
    }
  }
  if (debits !== credits) {
    throw new UnbalancedEntryError(
      entry.operationId,
      debits,
      credits,
      `entry for ${entry.operationId} is unbalanced: debits ${debits}, credits ${credits}`,
    );
  }
}

/**
 * Every account's balance, keyed by `accountKey`, derived from the given entries. Each entry is
 * validated first, so an unbalanced entry can never contribute to a balance (fail closed).
 * Accounts that were never posted to are absent (their balance is 0).
 */
export function deriveBalances(entries: Iterable<JournalEntry>): ReadonlyMap<string, bigint> {
  const balances = new Map<string, bigint>();
  for (const entry of entries) {
    assertBalanced(entry);
    for (const p of entry.postings) {
      const key = accountKey(p.account);
      const delta = p.side === normalSide(p.account.kind) ? p.amount : -p.amount;
      balances.set(key, (balances.get(key) ?? 0n) + delta);
    }
  }
  return balances;
}

/** A balance from a `deriveBalances` result, 0 for an account never posted to. */
export function balanceOf(balances: ReadonlyMap<string, bigint>, account: AccountRef): bigint {
  return balances.get(accountKey(account)) ?? 0n;
}

function validateOperation(op: LedgerOperation): void {
  if (typeof op.operationId !== 'string' || op.operationId.length === 0) {
    throw new InvalidInputError('operationId must be a non-empty string');
  }
  assertPositiveAmount(op.amount);
  if (op.type === 'transfer' && op.fromUserId === op.toUserId) {
    throw new SelfTransferError(
      `transfer ${op.operationId} sends from and to user ${op.fromUserId}`,
    );
  }
}

/** Debit `dr`, credit `cr`, both for `amount`. */
function pair(dr: AccountRef, cr: AccountRef, amount: bigint): readonly Posting[] {
  return [
    { account: dr, side: 'debit', amount },
    { account: cr, side: 'credit', amount },
  ];
}

/**
 * The postings for one step of one operation. This is THE table of the ledger:
 *
 * | operation  | reserve                        | settle                         | reverse                        |
 * |------------|--------------------------------|--------------------------------|--------------------------------|
 * | deposit    | Dr fiat_clearing / Cr incoming(U) | Dr incoming(U) / Cr available(U) | Dr incoming(U) / Cr fiat_clearing |
 * | withdrawal | Dr available(U) / Cr held(U)   | Dr held(U) / Cr fiat_clearing  | Dr held(U) / Cr available(U)   |
 * | transfer   | Dr available(F) / Cr held(F)   | Dr held(F) / Cr available(T)   | Dr held(F) / Cr available(F)   |
 */
function postingsFor(op: LedgerOperation, kind: JournalKind): readonly Posting[] {
  switch (op.type) {
    case 'deposit': {
      const incoming = incomingOf(op.userId);
      if (kind === 'reserve') return pair(FIAT_CLEARING, incoming, op.amount);
      if (kind === 'settle') return pair(incoming, availableOf(op.userId), op.amount);
      return pair(incoming, FIAT_CLEARING, op.amount);
    }
    case 'withdrawal': {
      const held = heldOf(op.userId);
      if (kind === 'reserve') return pair(availableOf(op.userId), held, op.amount);
      if (kind === 'settle') return pair(held, FIAT_CLEARING, op.amount);
      return pair(held, availableOf(op.userId), op.amount);
    }
    case 'transfer': {
      const held = heldOf(op.fromUserId);
      if (kind === 'reserve') return pair(availableOf(op.fromUserId), held, op.amount);
      if (kind === 'settle') return pair(held, availableOf(op.toUserId), op.amount);
      return pair(held, availableOf(op.fromUserId), op.amount);
    }
  }
}

const JOURNAL_KINDS: readonly JournalKind[] = ['reserve', 'settle', 'reverse'];

/**
 * Builds the journal entry for one step of an operation, validated before it is returned.
 * Throws `InvalidAmountError`, `SelfTransferError` or `InvalidInputError` for a bad operation.
 *
 * @param op The operation.
 * @param kind Which step: `reserve` (on RESERVE), `settle` (on CONFIRM), `reverse` (on REVERSE).
 */
export function buildEntry(op: LedgerOperation, kind: JournalKind): JournalEntry {
  validateOperation(op);
  if (!JOURNAL_KINDS.includes(kind)) {
    throw new InvalidInputError(`unknown journal kind '${String(kind)}'`);
  }
  const entry: JournalEntry = {
    operationId: op.operationId,
    kind,
    postings: postingsFor(op, kind),
  };
  assertBalanced(entry);
  return entry;
}

/**
 * Throws `InsufficientFundsError` when a withdrawal or transfer asks for more than is available.
 * Deposits never check: money is coming in, not going out.
 *
 * This is a pure comparison. Its safety against two concurrent requests spending the same balance
 * depends on the caller reading `availableBalance` and writing the reserve entry under the same row
 * lock (or serializable transaction).
 */
export function assertCanReserve(
  availableBalance: bigint,
  amount: bigint,
  type: OperationType,
): void {
  assertPositiveAmount(amount);
  if (type === 'deposit') return;
  if (availableBalance < amount) {
    throw new InsufficientFundsError(availableBalance, amount);
  }
}

/** A signed change in one address's token balance. */
export interface BalanceDelta {
  /** The holder. */
  readonly address: Address;
  /** Positive for a credit to the holder, negative for a debit. Never zero. */
  readonly delta: bigint;
}

/**
 * The token balance changes that a SETTLED operation implies on chain: a deposit mints `+A` to its
 * recipient, a withdrawal burns `-A` from its owner, a transfer moves `-A` from the sender and `+A`
 * to the receiver (in that order). Throws `SelfTransferError` for a transfer to the same address,
 * which would make the ledger move funds that the chain does not.
 */
export function onChainEffect(parties: OperationParties, amount: bigint): readonly BalanceDelta[] {
  assertPositiveAmount(amount);
  switch (parties.type) {
    case 'deposit':
      assertAddress(parties.to, 'deposit.to');
      return [{ address: parties.to, delta: amount }];
    case 'withdrawal':
      assertAddress(parties.from, 'withdrawal.from');
      return [{ address: parties.from, delta: -amount }];
    case 'transfer':
      assertAddress(parties.from, 'transfer.from');
      assertAddress(parties.to, 'transfer.to');
      if (parties.from === parties.to) {
        throw new SelfTransferError(`transfer from and to the same address ${parties.from}`);
      }
      return [
        { address: parties.from, delta: -amount },
        { address: parties.to, delta: amount },
      ];
  }
}
