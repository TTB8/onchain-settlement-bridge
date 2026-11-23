import {
  accountKey,
  accountRef,
  type AccountKind,
  availableOf,
  balanceFrom,
  FIAT_CLEARING,
  heldOf,
  incomingOf,
  InvalidInputError,
  normalSide,
  type PostingLike,
} from '../src';

describe('accountRef', () => {
  it('builds the single system account without a user', () => {
    expect(accountRef('fiat_clearing')).toBe(FIAT_CLEARING);
    expect(FIAT_CLEARING).toEqual({ kind: 'fiat_clearing' });
  });

  it('builds user accounts with their user id', () => {
    expect(availableOf('u1')).toEqual({ kind: 'user_available', userId: 'u1' });
    expect(heldOf('u1')).toEqual({ kind: 'user_held', userId: 'u1' });
    expect(incomingOf('u1')).toEqual({ kind: 'user_incoming', userId: 'u1' });
  });

  it('refuses a user id on the system account', () => {
    expect(() => accountRef('fiat_clearing', 'u1')).toThrow(InvalidInputError);
  });

  it('refuses a user account without a (non-empty) user id', () => {
    expect(() => accountRef('user_available')).toThrow(InvalidInputError);
    expect(() => accountRef('user_held', '')).toThrow(InvalidInputError);
  });

  it('refuses an unknown kind', () => {
    expect(() => accountRef('user_savings' as AccountKind, 'u1')).toThrow(/unknown account kind/);
  });
});

describe('accountKey', () => {
  it('is stable and distinct per account', () => {
    expect(accountKey(FIAT_CLEARING)).toBe('fiat_clearing');
    expect(accountKey(availableOf('u1'))).toBe('user_available:u1');
    expect(accountKey(heldOf('u1'))).not.toBe(accountKey(availableOf('u1')));
    expect(accountKey(availableOf('u1'))).toBe(accountKey(availableOf('u1')));
  });

  it('stays unambiguous when a user id contains a colon', () => {
    expect(accountKey(availableOf('a:b'))).toBe('user_available:a:b');
    expect(accountKey(availableOf('a:b'))).not.toBe(accountKey(availableOf('a')));
  });
});

describe('normalSide', () => {
  it('is debit for the asset and credit for every liability', () => {
    expect(normalSide('fiat_clearing')).toBe('debit');
    expect(normalSide('user_available')).toBe('credit');
    expect(normalSide('user_held')).toBe('credit');
    expect(normalSide('user_incoming')).toBe('credit');
  });
});

describe('balanceFrom', () => {
  const postings: PostingLike[] = [
    { account: FIAT_CLEARING, side: 'debit', amount: 100n },
    { account: incomingOf('u1'), side: 'credit', amount: 100n },
    { account: incomingOf('u1'), side: 'debit', amount: 30n },
    { account: availableOf('u1'), side: 'credit', amount: 30n },
    { account: FIAT_CLEARING, side: 'credit', amount: 10n },
  ];

  it('derives credit-normal balances as credits minus debits', () => {
    expect(balanceFrom(postings, incomingOf('u1'))).toBe(70n);
    expect(balanceFrom(postings, availableOf('u1'))).toBe(30n);
  });

  it('derives debit-normal balances as debits minus credits', () => {
    expect(balanceFrom(postings, FIAT_CLEARING)).toBe(90n);
  });

  it('is zero for an account with no postings and ignores other users', () => {
    expect(balanceFrom(postings, availableOf('u2'))).toBe(0n);
    expect(balanceFrom([], FIAT_CLEARING)).toBe(0n);
  });

  it('can go negative so that an invariant break is visible, not hidden', () => {
    expect(balanceFrom([{ account: heldOf('u1'), side: 'debit', amount: 5n }], heldOf('u1'))).toBe(
      -5n,
    );
  });
});
