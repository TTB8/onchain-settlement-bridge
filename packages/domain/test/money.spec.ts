import {
  AmountOverflowError,
  AmountUnderflowError,
  assertPositiveAmount,
  checkedAdd,
  checkedSub,
  DomainError,
  InvalidAmountError,
  MAX_LEDGER_AMOUNT,
} from '../src';

describe('MAX_LEDGER_AMOUNT', () => {
  it('is the largest Postgres bigint, 2^63 - 1', () => {
    expect(MAX_LEDGER_AMOUNT).toBe(9223372036854775807n);
  });
});

describe('assertPositiveAmount', () => {
  it.each([1n, 2n, 1_000_000n, MAX_LEDGER_AMOUNT])('accepts %s', (n) => {
    expect(() => assertPositiveAmount(n)).not.toThrow();
  });

  it.each([0n, -1n, -MAX_LEDGER_AMOUNT])('rejects non-positive %s', (n) => {
    expect(() => assertPositiveAmount(n)).toThrow(InvalidAmountError);
  });

  it('rejects an overflowing amount one above the cap', () => {
    const err = captured(() => assertPositiveAmount(MAX_LEDGER_AMOUNT + 1n));
    expect(err).toBeInstanceOf(InvalidAmountError);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as InvalidAmountError).code).toBe('INVALID_AMOUNT');
    expect((err as InvalidAmountError).amount).toBe(MAX_LEDGER_AMOUNT + 1n);
  });

  it.each([1, 1.5, '1', null, undefined])('rejects non-bigint %p', (n) => {
    expect(() => assertPositiveAmount(n)).toThrow(/must be a bigint/);
  });
});

describe('checkedAdd', () => {
  it('adds within range, including up to exactly the cap', () => {
    expect(checkedAdd(2n, 3n)).toBe(5n);
    expect(checkedAdd(0n, 0n)).toBe(0n);
    expect(checkedAdd(MAX_LEDGER_AMOUNT - 1n, 1n)).toBe(MAX_LEDGER_AMOUNT);
  });

  it('throws AmountOverflowError one past the cap', () => {
    expect(() => checkedAdd(MAX_LEDGER_AMOUNT, 1n)).toThrow(AmountOverflowError);
    expect(() => checkedAdd(MAX_LEDGER_AMOUNT, MAX_LEDGER_AMOUNT)).toThrow(AmountOverflowError);
  });

  it('rejects negative or out-of-range operands', () => {
    expect(() => checkedAdd(-1n, 5n)).toThrow(InvalidAmountError);
    expect(() => checkedAdd(5n, -1n)).toThrow(InvalidAmountError);
    expect(() => checkedAdd(MAX_LEDGER_AMOUNT + 1n, 0n)).toThrow(InvalidAmountError);
    expect(() => checkedAdd(1 as unknown as bigint, 0n)).toThrow(InvalidAmountError);
  });
});

describe('checkedSub', () => {
  it('subtracts down to exactly zero', () => {
    expect(checkedSub(5n, 3n)).toBe(2n);
    expect(checkedSub(5n, 5n)).toBe(0n);
  });

  it('throws AmountUnderflowError below zero', () => {
    const err = captured(() => checkedSub(3n, 4n));
    expect(err).toBeInstanceOf(AmountUnderflowError);
    expect((err as AmountUnderflowError).code).toBe('AMOUNT_UNDERFLOW');
  });

  it('rejects negative operands', () => {
    expect(() => checkedSub(-1n, 0n)).toThrow(InvalidAmountError);
    expect(() => checkedSub(0n, -1n)).toThrow(InvalidAmountError);
  });
});

function captured(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}
