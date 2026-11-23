/**
 * Property test: thousands of random, valid operation sequences through the ledger builders.
 *
 * Each sequence starts a random mix of deposits, withdrawals and transfers among a few users, and
 * settles or reverses in-flight operations in a random order. After every step it checks:
 * - every entry balances (debits == credits);
 * - for every user, available + held == the chain balance implied by settled operations;
 * - fiat_clearing == the sum of every user's liabilities (available + held + incoming);
 * - the supply the chain should show == the sum of available + held over users;
 * - no account is negative.
 * Uses a seeded PRNG, so a failure names a seed that replays it exactly.
 */

import {
  type Address,
  assertCanReserve,
  availableOf,
  balanceOf,
  buildEntry,
  deriveBalances,
  FIAT_CLEARING,
  heldOf,
  incomingOf,
  type JournalEntry,
  type LedgerOperation,
  onChainEffect,
  type OperationParties,
  InsufficientFundsError,
} from '../src';
import { addr, prng, randInt } from './support/fixtures';

const USERS = ['u0', 'u1', 'u2', 'u3'] as const;
const ADDRESS: Record<string, Address> = Object.fromEntries(USERS.map((u, i) => [u, addr(i + 1)]));

function partiesOf(op: LedgerOperation): OperationParties {
  switch (op.type) {
    case 'deposit':
      return { type: 'deposit', to: ADDRESS[op.userId] as Address };
    case 'withdrawal':
      return { type: 'withdrawal', from: ADDRESS[op.userId] as Address };
    case 'transfer':
      return {
        type: 'transfer',
        from: ADDRESS[op.fromUserId] as Address,
        to: ADDRESS[op.toUserId] as Address,
      };
  }
}

function checkInvariants(entries: JournalEntry[], chain: Map<Address, bigint>, seed: number): void {
  for (const e of entries) {
    let dr = 0n;
    let cr = 0n;
    for (const p of e.postings) {
      if (p.side === 'debit') dr += p.amount;
      else cr += p.amount;
    }
    if (dr !== cr) throw new Error(`seed ${seed}: entry ${e.operationId}/${e.kind} unbalanced`);
  }
  const b = deriveBalances(entries);
  let liabilities = 0n;
  let onChainSupply = 0n;
  for (const u of USERS) {
    const available = balanceOf(b, availableOf(u));
    const held = balanceOf(b, heldOf(u));
    const incoming = balanceOf(b, incomingOf(u));
    if (available < 0n || held < 0n || incoming < 0n) {
      throw new Error(`seed ${seed}: negative balance for ${u}`);
    }
    const expectedOnChain = chain.get(ADDRESS[u] as Address) ?? 0n;
    if (available + held !== expectedOnChain) {
      throw new Error(
        `seed ${seed}: ${u} available+held ${available + held} != chain ${expectedOnChain}`,
      );
    }
    liabilities += available + held + incoming;
    onChainSupply += available + held;
  }
  const fiat = balanceOf(b, FIAT_CLEARING);
  if (fiat !== liabilities) {
    throw new Error(`seed ${seed}: fiat_clearing ${fiat} != liabilities ${liabilities}`);
  }
  const chainSupply = [...chain.values()].reduce((s, v) => s + v, 0n);
  if (chainSupply !== onChainSupply) {
    throw new Error(`seed ${seed}: chain supply ${chainSupply} != ledger ${onChainSupply}`);
  }
}

function runSequence(seed: number): { ops: number; settled: number; reversed: number } {
  const rand = prng(seed);
  const entries: JournalEntry[] = [];
  const chain = new Map<Address, bigint>();
  const inFlight: LedgerOperation[] = [];
  let ops = 0;
  let settled = 0;
  let reversed = 0;
  const steps = 10 + randInt(rand, 30);

  for (let step = 0; step < steps; step += 1) {
    const roll = rand();
    if (roll < 0.55 || inFlight.length === 0) {
      // Start an operation, checking funds the way the engine must.
      const balances = deriveBalances(entries);
      const kind = randInt(rand, 3);
      const amount = BigInt(1 + randInt(rand, 1_000));
      const u = USERS[randInt(rand, USERS.length)] as string;
      const id = `s${seed}-op${ops}`;
      let op: LedgerOperation;
      if (kind === 0) {
        op = { type: 'deposit', operationId: id, userId: u, amount };
      } else if (kind === 1) {
        op = { type: 'withdrawal', operationId: id, userId: u, amount };
      } else {
        let v = USERS[randInt(rand, USERS.length)] as string;
        if (v === u)
          v = USERS[(USERS.indexOf(u as (typeof USERS)[number]) + 1) % USERS.length] as string;
        op = { type: 'transfer', operationId: id, fromUserId: u, toUserId: v, amount };
      }
      const payer = op.type === 'transfer' ? op.fromUserId : op.userId;
      try {
        assertCanReserve(balanceOf(balances, availableOf(payer)), amount, op.type);
      } catch (err) {
        if (err instanceof InsufficientFundsError) continue; // a valid sequence skips it
        throw err;
      }
      entries.push(buildEntry(op, 'reserve'));
      inFlight.push(op);
      ops += 1;
    } else {
      // Finish a random in-flight operation: settle (and apply on chain) or reverse.
      const idx = randInt(rand, inFlight.length);
      const op = inFlight.splice(idx, 1)[0] as LedgerOperation;
      if (rand() < 0.7) {
        entries.push(buildEntry(op, 'settle'));
        for (const { address, delta } of onChainEffect(partiesOf(op), op.amount)) {
          chain.set(address, (chain.get(address) ?? 0n) + delta);
        }
        settled += 1;
      } else {
        entries.push(buildEntry(op, 'reverse'));
        reversed += 1;
      }
    }
    checkInvariants(entries, chain, seed);
  }
  return { ops, settled, reversed };
}

describe('ledger conservation (seeded property test)', () => {
  it('holds across 3000 random valid operation sequences', () => {
    let totals = { ops: 0, settled: 0, reversed: 0 };
    for (let seed = 1; seed <= 3000; seed += 1) {
      const r = runSequence(seed);
      totals = {
        ops: totals.ops + r.ops,
        settled: totals.settled + r.settled,
        reversed: totals.reversed + r.reversed,
      };
    }
    // The generator really exercises every path (guards against a vacuous property).
    expect(totals.ops).toBeGreaterThan(20_000);
    expect(totals.settled).toBeGreaterThan(5_000);
    expect(totals.reversed).toBeGreaterThan(2_000);
  });

  it('detects a broken builder: a settle entry that credits the wrong user breaks the invariant', () => {
    // Sanity check that checkInvariants is not vacuous.
    const op: LedgerOperation = { type: 'deposit', operationId: 'x', userId: 'u0', amount: 5n };
    const wrong: JournalEntry = {
      operationId: 'x',
      kind: 'settle',
      postings: [
        { account: incomingOf('u0'), side: 'debit', amount: 5n },
        { account: availableOf('u1'), side: 'credit', amount: 5n },
      ],
    };
    const chain = new Map<Address, bigint>([[ADDRESS.u0 as Address, 5n]]);
    expect(() => checkInvariants([buildEntry(op, 'reserve'), wrong], chain, 0)).toThrow(
      /available\+held/,
    );
  });
});
