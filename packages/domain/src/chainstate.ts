/**
 * @file The journal checked as a whole, and the chain state it implies at a given block.
 *
 * `assertBalanced` proves one entry is a valid double entry. It cannot see that an operation was
 * reserved twice, or settled and then reversed, or that an entry moves a different amount than its
 * operation: each such entry balances on its own. `assertOperationJournal` checks the sequence.
 *
 * `expectedChainState` is what reconciliation compares the chain with. The ledger settles an
 * operation when its transaction is final, but reconciliation may look at an earlier block (to
 * compare one consistent point in history). An operation settled in the ledger whose
 * `confirmedBlock` is after `atBlock` had not happened on chain yet at that block, so its effect is
 * taken back out. The result is computed from the journal, never from stored balances.
 */

import { accountKey, availableOf, heldOf, normalSide } from './accounts';
import { InvalidInputError, JournalIntegrityError } from './errors';
import { buildEntry, type JournalEntry, type LedgerOperation, onChainEffect } from './ledger';
import type { OperationParties } from './operation';
import type { Address } from './primitives';

/** Where an operation is in the journal: nothing yet, reserved, or finished one way or the other. */
type JournalStage = 'none' | 'reserved' | 'settled' | 'reversed';

function samePostings(a: JournalEntry, b: JournalEntry): boolean {
  return (
    a.postings.length === b.postings.length &&
    a.postings.every((p, i) => {
      const q = b.postings[i];
      return (
        q !== undefined &&
        accountKey(p.account) === accountKey(q.account) &&
        p.side === q.side &&
        p.amount === q.amount
      );
    })
  );
}

/**
 * Throws `JournalIntegrityError` unless the journal, in order, is a valid history:
 *
 * - every entry belongs to a known operation and equals exactly what `buildEntry` writes for it;
 * - per operation, exactly one `reserve` comes first, then at most one of `settle` or `reverse`;
 * - no account balance is negative after any entry (so no withdrawal or transfer ever reserved
 *   funds that were not available).
 *
 * An operation with no entries at all (still `requested`) is fine.
 *
 * @param entries The journal, in the order it was written.
 * @param operations Every operation the entries may refer to, by id.
 */
export function assertOperationJournal(
  entries: readonly JournalEntry[],
  operations: ReadonlyMap<string, LedgerOperation>,
): void {
  const stage = new Map<string, JournalStage>();
  const balances = new Map<string, bigint>();
  for (const entry of entries) {
    const id = entry.operationId;
    const op = operations.get(id);
    if (op === undefined) {
      throw new JournalIntegrityError(id, `entry for unknown operation ${id}`);
    }
    const current = stage.get(id) ?? 'none';
    const allowed = entry.kind === 'reserve' ? current === 'none' : current === 'reserved';
    if (!allowed) {
      throw new JournalIntegrityError(id, `${entry.kind} entry for ${id} after stage '${current}'`);
    }
    if (!samePostings(entry, buildEntry(op, entry.kind))) {
      throw new JournalIntegrityError(
        id,
        `${entry.kind} entry for ${id} does not match the operation`,
      );
    }
    stage.set(
      id,
      entry.kind === 'reserve' ? 'reserved' : entry.kind === 'settle' ? 'settled' : 'reversed',
    );
    for (const p of entry.postings) {
      const key = accountKey(p.account);
      const next =
        (balances.get(key) ?? 0n) + (p.side === normalSide(p.account.kind) ? p.amount : -p.amount);
      balances.set(key, next);
      if (next < 0n) {
        throw new JournalIntegrityError(
          id,
          `account ${key} goes negative (${next}) at ${entry.kind} of ${id}`,
        );
      }
    }
  }
}

/** An operation as `expectedChainState` needs it: ledger terms, chain terms, and when it settled. */
export interface ChainStateOperation {
  /** The ledger description (ids, users, amount). */
  readonly op: LedgerOperation;
  /** The on-chain addresses; must be the users' addresses from `userAddresses`. */
  readonly parties: OperationParties;
  /** The block its settling transaction was mined in; required exactly when it is settled. */
  readonly confirmedBlock: bigint | null;
}

/** Inputs to `expectedChainState`. */
export interface ChainStateInput {
  /** The whole journal, in the order it was written. */
  readonly entries: readonly JournalEntry[];
  /** Every operation the journal refers to. */
  readonly operations: readonly ChainStateOperation[];
  /** Each user's on-chain address. One address per user, one user per address. */
  readonly userAddresses: ReadonlyMap<string, Address>;
  /** The block the chain state is wanted at. At most `finalBlock`. */
  readonly atBlock: bigint;
  /**
   * The newest FINAL block when the engine runs (`head - depth + 1`). Every settled operation's
   * `confirmedBlock` must be at or below it: a settlement "confirmed" in a block that is not final
   * (or does not exist yet) would otherwise be silently taken back out of the expected state.
   */
  readonly finalBlock: bigint;
}

/** The balances and supply the chain should show. */
export interface ExpectedChainState {
  /** Expected token balance per address; addresses expected to hold 0 are omitted. */
  readonly balances: ReadonlyMap<Address, bigint>;
  /** Expected total supply: the sum of `balances`. */
  readonly supply: bigint;
}

function usersOf(op: LedgerOperation): string[] {
  return op.type === 'transfer' ? [op.fromUserId, op.toUserId] : [op.userId];
}

function expectedParties(op: LedgerOperation, addressOf: (u: string) => Address): OperationParties {
  switch (op.type) {
    case 'deposit':
      return { type: 'deposit', to: addressOf(op.userId) };
    case 'withdrawal':
      return { type: 'withdrawal', from: addressOf(op.userId) };
    case 'transfer':
      return { type: 'transfer', from: addressOf(op.fromUserId), to: addressOf(op.toUserId) };
  }
}

function sameParties(a: OperationParties, b: OperationParties): boolean {
  const x: { type: string; from?: Address; to?: Address } = a;
  const y: { type: string; from?: Address; to?: Address } = b;
  return x.type === y.type && x.from === y.from && x.to === y.to;
}

/**
 * The token balance per address, and the supply, the chain should show at `atBlock`.
 *
 * For each user it starts from `available + held` (derived from the journal, which is first
 * checked with `assertOperationJournal`), then takes back the on-chain effect of every operation
 * settled in the ledger with `confirmedBlock > atBlock`.
 *
 * Throws `InvalidInputError` (or `JournalIntegrityError` from the journal check) when the inputs
 * cannot describe one consistent state: `atBlock` after `finalBlock`, duplicate operation ids or
 * user addresses, a user with funds and no address, parties that are not the users' addresses, a
 * settled operation without a `confirmedBlock` or with one after `finalBlock`, or an unsettled one
 * with one.
 *
 * Only settlements in (`atBlock`, `finalBlock`] are taken back. `reconcile` still requires their
 * settling events, so this never hides a settlement the chain did not make.
 */
export function expectedChainState(input: ChainStateInput): ExpectedChainState {
  if (input.atBlock > input.finalBlock) {
    throw new InvalidInputError(`atBlock ${input.atBlock} is after finalBlock ${input.finalBlock}`);
  }
  const byId = new Map<string, ChainStateOperation>();
  for (const o of input.operations) {
    if (byId.has(o.op.operationId)) {
      throw new InvalidInputError(`duplicate operation id ${o.op.operationId}`);
    }
    byId.set(o.op.operationId, o);
  }
  assertOperationJournal(input.entries, new Map([...byId].map(([id, o]) => [id, o.op])));

  const owner = new Map<Address, string>();
  for (const [user, address] of input.userAddresses) {
    const other = owner.get(address);
    if (other !== undefined) {
      throw new InvalidInputError(`users ${other} and ${user} share address ${address}`);
    }
    owner.set(address, user);
  }
  const addressOf = (user: string): Address => {
    const a = input.userAddresses.get(user);
    if (a === undefined) throw new InvalidInputError(`user ${user} has no on-chain address`);
    return a;
  };

  const settled = new Set(
    input.entries.filter((e) => e.kind === 'settle').map((e) => e.operationId),
  );
  const users = new Set<string>();
  for (const o of input.operations) {
    for (const u of usersOf(o.op)) users.add(u);
    if (!sameParties(o.parties, expectedParties(o.op, addressOf))) {
      throw new InvalidInputError(
        `operation ${o.op.operationId} parties are not its users' addresses`,
      );
    }
    if (o.confirmedBlock !== null && o.confirmedBlock > input.finalBlock) {
      throw new InvalidInputError(
        `operation ${o.op.operationId} confirmedBlock ${o.confirmedBlock} is after finalBlock ${input.finalBlock}`,
      );
    }
    const isSettled = settled.has(o.op.operationId);
    if (isSettled !== (o.confirmedBlock !== null)) {
      throw new InvalidInputError(
        `operation ${o.op.operationId} is ${isSettled ? 'settled without' : 'unsettled with'} a confirmedBlock`,
      );
    }
  }

  // Derive available + held per user from the (already validated) journal.
  const liabilities = new Map<string, bigint>();
  const tracked = new Set<string>();
  for (const u of users) {
    for (const acc of [availableOf(u), heldOf(u)]) {
      tracked.add(accountKey(acc));
    }
  }
  for (const e of input.entries) {
    for (const p of e.postings) {
      const key = accountKey(p.account);
      if (!tracked.has(key)) continue;
      const user = p.account.userId as string;
      const delta = p.side === 'credit' ? p.amount : -p.amount;
      liabilities.set(user, (liabilities.get(user) ?? 0n) + delta);
    }
  }

  const balances = new Map<Address, bigint>();
  for (const [user, amount] of liabilities) {
    if (amount === 0n) continue;
    const a = addressOf(user);
    balances.set(a, amount);
  }
  for (const o of input.operations) {
    if (o.confirmedBlock === null || o.confirmedBlock <= input.atBlock) continue;
    // Settled in the ledger, not yet on chain at atBlock: take its effect back out.
    for (const { address, delta } of onChainEffect(o.parties, o.op.amount)) {
      balances.set(address, (balances.get(address) ?? 0n) - delta);
    }
  }

  let supply = 0n;
  for (const [address, amount] of [...balances]) {
    if (amount < 0n) {
      throw new InvalidInputError(
        `address ${address} would hold ${amount} at block ${input.atBlock}`,
      );
    }
    if (amount === 0n) balances.delete(address);
    supply += amount;
  }
  return { balances, supply };
}
