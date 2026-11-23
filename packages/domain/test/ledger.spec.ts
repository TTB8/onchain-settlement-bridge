import {
  assertBalanced,
  assertCanReserve,
  availableOf,
  balanceOf,
  buildEntry,
  deriveBalances,
  FIAT_CLEARING,
  heldOf,
  incomingOf,
  InsufficientFundsError,
  InvalidAmountError,
  InvalidInputError,
  type JournalEntry,
  type JournalKind,
  type LedgerOperation,
  MAX_LEDGER_AMOUNT,
  onChainEffect,
  type Posting,
  SelfTransferError,
  UnbalancedEntryError,
  AmountOverflowError,
} from '../src';
import { addr } from './support/fixtures';

const dep: LedgerOperation = { type: 'deposit', operationId: 'd1', userId: 'u1', amount: 100n };
const wd: LedgerOperation = { type: 'withdrawal', operationId: 'w1', userId: 'u1', amount: 40n };
const tr: LedgerOperation = {
  type: 'transfer',
  operationId: 't1',
  fromUserId: 'u1',
  toUserId: 'u2',
  amount: 25n,
};

function entry(postings: Posting[], operationId = 'op'): JournalEntry {
  return { operationId, kind: 'reserve', postings };
}

describe('assertBalanced', () => {
  it('accepts a two-line balanced entry and a multi-line balanced entry', () => {
    expect(() =>
      assertBalanced(
        entry([
          { account: FIAT_CLEARING, side: 'debit', amount: 10n },
          { account: incomingOf('u1'), side: 'credit', amount: 10n },
        ]),
      ),
    ).not.toThrow();
    expect(() =>
      assertBalanced(
        entry([
          { account: FIAT_CLEARING, side: 'debit', amount: 10n },
          { account: incomingOf('u1'), side: 'credit', amount: 4n },
          { account: incomingOf('u2'), side: 'credit', amount: 6n },
        ]),
      ),
    ).not.toThrow();
  });

  it('rejects an unbalanced journal, reporting both totals', () => {
    const bad = entry([
      { account: FIAT_CLEARING, side: 'debit', amount: 10n },
      { account: incomingOf('u1'), side: 'credit', amount: 9n },
    ]);
    let err: unknown;
    try {
      assertBalanced(bad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnbalancedEntryError);
    expect((err as UnbalancedEntryError).totalDebits).toBe(10n);
    expect((err as UnbalancedEntryError).totalCredits).toBe(9n);
    expect((err as UnbalancedEntryError).operationId).toBe('op');
  });

  it('rejects an entry that is all debits (balanced count, not balanced sides)', () => {
    expect(() =>
      assertBalanced(
        entry([
          { account: FIAT_CLEARING, side: 'debit', amount: 10n },
          { account: incomingOf('u1'), side: 'debit', amount: 10n },
        ]),
      ),
    ).toThrow(UnbalancedEntryError);
  });

  it('rejects fewer than two postings', () => {
    expect(() => assertBalanced(entry([]))).toThrow(UnbalancedEntryError);
    expect(() =>
      assertBalanced(entry([{ account: FIAT_CLEARING, side: 'debit', amount: 10n }])),
    ).toThrow(/at least 2/);
  });

  it('rejects a zero, negative or over-cap amount even if the sides balance', () => {
    for (const amount of [0n, -5n, MAX_LEDGER_AMOUNT + 1n]) {
      expect(() =>
        assertBalanced(
          entry([
            { account: FIAT_CLEARING, side: 'debit', amount },
            { account: incomingOf('u1'), side: 'credit', amount },
          ]),
        ),
      ).toThrow(InvalidAmountError);
    }
  });

  it('rejects an entry whose totals overflow the ledger, instead of wrapping', () => {
    expect(() =>
      assertBalanced(
        entry([
          { account: FIAT_CLEARING, side: 'debit', amount: MAX_LEDGER_AMOUNT },
          { account: FIAT_CLEARING, side: 'debit', amount: 1n },
          { account: incomingOf('u1'), side: 'credit', amount: MAX_LEDGER_AMOUNT },
          { account: incomingOf('u1'), side: 'credit', amount: 1n },
        ]),
      ),
    ).toThrow(AmountOverflowError);
  });

  it('rejects a posting with an unknown side', () => {
    expect(() =>
      assertBalanced(
        entry([
          { account: FIAT_CLEARING, side: 'debit', amount: 1n },
          { account: incomingOf('u1'), side: 'sideways' as 'credit', amount: 1n },
        ]),
      ),
    ).toThrow(InvalidInputError);
  });
});

describe('buildEntry: the ledger table', () => {
  const cases: Array<[LedgerOperation, JournalKind, string, string]> = [
    [dep, 'reserve', 'fiat_clearing', 'user_incoming:u1'],
    [dep, 'settle', 'user_incoming:u1', 'user_available:u1'],
    [dep, 'reverse', 'user_incoming:u1', 'fiat_clearing'],
    [wd, 'reserve', 'user_available:u1', 'user_held:u1'],
    [wd, 'settle', 'user_held:u1', 'fiat_clearing'],
    [wd, 'reverse', 'user_held:u1', 'user_available:u1'],
    [tr, 'reserve', 'user_available:u1', 'user_held:u1'],
    [tr, 'settle', 'user_held:u1', 'user_available:u2'],
    [tr, 'reverse', 'user_held:u1', 'user_available:u1'],
  ];

  it.each(cases)('%o %s = Dr %s / Cr %s', (op, kind, dr, cr) => {
    const e = buildEntry(op, kind);
    expect(e.operationId).toBe(op.operationId);
    expect(e.kind).toBe(kind);
    expect(e.postings).toHaveLength(2);
    const [debit, credit] = e.postings;
    expect(debit?.side).toBe('debit');
    expect(credit?.side).toBe('credit');
    const key = (p: Posting | undefined) =>
      p?.account.kind === 'fiat_clearing'
        ? 'fiat_clearing'
        : `${p?.account.kind}:${p?.account.userId}`;
    expect(key(debit)).toBe(dr);
    expect(key(credit)).toBe(cr);
    expect(debit?.amount).toBe(op.amount);
    expect(credit?.amount).toBe(op.amount);
  });

  it('rejects a self-transfer', () => {
    expect(() => buildEntry({ ...tr, toUserId: 'u1' }, 'reserve')).toThrow(SelfTransferError);
  });

  it('rejects an overflowing or non-positive amount', () => {
    expect(() => buildEntry({ ...dep, amount: MAX_LEDGER_AMOUNT + 1n }, 'reserve')).toThrow(
      InvalidAmountError,
    );
    expect(() => buildEntry({ ...dep, amount: 0n }, 'reserve')).toThrow(InvalidAmountError);
    expect(buildEntry({ ...dep, amount: MAX_LEDGER_AMOUNT }, 'reserve').postings[0]?.amount).toBe(
      MAX_LEDGER_AMOUNT,
    );
  });

  it('rejects an empty operation id and an unknown journal kind', () => {
    expect(() => buildEntry({ ...dep, operationId: '' }, 'reserve')).toThrow(InvalidInputError);
    expect(() => buildEntry(dep, 'refund' as JournalKind)).toThrow(/unknown journal kind/);
  });
});

describe('deriveBalances', () => {
  it('derives every balance after a deposit, withdrawal and transfer settle', () => {
    const entries = [
      buildEntry(dep, 'reserve'),
      buildEntry(dep, 'settle'),
      buildEntry(wd, 'reserve'),
      buildEntry(tr, 'reserve'),
      buildEntry(wd, 'settle'),
      buildEntry(tr, 'settle'),
    ];
    const b = deriveBalances(entries);
    expect(balanceOf(b, FIAT_CLEARING)).toBe(60n);
    expect(balanceOf(b, incomingOf('u1'))).toBe(0n);
    expect(balanceOf(b, availableOf('u1'))).toBe(35n);
    expect(balanceOf(b, heldOf('u1'))).toBe(0n);
    expect(balanceOf(b, availableOf('u2'))).toBe(25n);
    expect(balanceOf(b, availableOf('nobody'))).toBe(0n);
  });

  it('returns held funds to available on reverse', () => {
    const b = deriveBalances([
      buildEntry(dep, 'reserve'),
      buildEntry(dep, 'settle'),
      buildEntry(wd, 'reserve'),
      buildEntry(wd, 'reverse'),
    ]);
    expect(balanceOf(b, availableOf('u1'))).toBe(100n);
    expect(balanceOf(b, heldOf('u1'))).toBe(0n);
  });

  it('refuses to derive anything from an unbalanced entry (fail closed)', () => {
    const bad = entry([
      { account: FIAT_CLEARING, side: 'debit', amount: 10n },
      { account: incomingOf('u1'), side: 'credit', amount: 11n },
    ]);
    expect(() => deriveBalances([buildEntry(dep, 'reserve'), bad])).toThrow(UnbalancedEntryError);
  });
});

describe('assertCanReserve', () => {
  it('lets a withdrawal or transfer reserve up to exactly the available balance', () => {
    expect(() => assertCanReserve(40n, 40n, 'withdrawal')).not.toThrow();
    expect(() => assertCanReserve(41n, 40n, 'transfer')).not.toThrow();
  });

  it('rejects insufficient funds with the balances in the error', () => {
    let err: unknown;
    try {
      assertCanReserve(39n, 40n, 'withdrawal');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InsufficientFundsError);
    expect((err as InsufficientFundsError).available).toBe(39n);
    expect(() => assertCanReserve(0n, 1n, 'transfer')).toThrow(InsufficientFundsError);
  });

  it('never checks funds for a deposit', () => {
    expect(() => assertCanReserve(0n, 1_000n, 'deposit')).not.toThrow();
  });

  it('still validates the amount', () => {
    expect(() => assertCanReserve(100n, 0n, 'deposit')).toThrow(InvalidAmountError);
  });
});

describe('onChainEffect', () => {
  const a = addr(1);
  const b = addr(2);

  it('mints to the depositor, burns from the withdrawer, moves for a transfer', () => {
    expect(onChainEffect({ type: 'deposit', to: a }, 7n)).toEqual([{ address: a, delta: 7n }]);
    expect(onChainEffect({ type: 'withdrawal', from: a }, 7n)).toEqual([
      { address: a, delta: -7n },
    ]);
    expect(onChainEffect({ type: 'transfer', from: a, to: b }, 7n)).toEqual([
      { address: a, delta: -7n },
      { address: b, delta: 7n },
    ]);
  });

  it('rejects a self-transfer by address', () => {
    expect(() => onChainEffect({ type: 'transfer', from: a, to: a }, 7n)).toThrow(
      SelfTransferError,
    );
  });

  it('rejects a malformed address and a bad amount', () => {
    const upper = `0x${'A'.repeat(40)}` as `0x${string}`;
    expect(() => onChainEffect({ type: 'deposit', to: upper }, 7n)).toThrow(InvalidInputError);
    expect(() => onChainEffect({ type: 'withdrawal', from: upper }, 7n)).toThrow(InvalidInputError);
    expect(() => onChainEffect({ type: 'transfer', from: upper, to: b }, 7n)).toThrow(
      InvalidInputError,
    );
    expect(() => onChainEffect({ type: 'transfer', from: a, to: upper }, 7n)).toThrow(
      InvalidInputError,
    );
    expect(() => onChainEffect({ type: 'deposit', to: a }, 0n)).toThrow(InvalidAmountError);
  });
});
