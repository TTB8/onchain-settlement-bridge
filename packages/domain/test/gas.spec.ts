import {
  bumpFees,
  bumpValue,
  FeeCapExceededError,
  type Fees,
  initialFees,
  InvalidInputError,
} from '../src';
import { prng, randInt } from './support/fixtures';

const BIG_CAP = 10n ** 30n;

/** True when `next` is strictly above `prev * 1.125`, i.e. `next * 8 > prev * 9`. */
function strictlyAboveMinimum(prev: bigint, next: bigint): boolean {
  return next * 8n > prev * 9n;
}

describe('bumpFees', () => {
  it('raises both fields by 12.5% and then strictly above it when the result is exact', () => {
    // 1000 * 1.125 = 1125 exactly, which a node would refuse as "not strictly more".
    expect(bumpFees({ maxFeePerGas: 1000n, maxPriorityFeePerGas: 80n }, { cap: BIG_CAP })).toEqual({
      maxFeePerGas: 1126n,
      maxPriorityFeePerGas: 91n,
    });
  });

  it('rounds up so a tiny value still rises: 1 wei -> 2 wei, 0 wei -> 1 wei', () => {
    expect(bumpFees({ maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }, { cap: BIG_CAP })).toEqual({
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });
    expect(bumpValue(7n, 1250n)).toBe(8n); // 7.875 rounds up to 8
    expect(bumpValue(8n, 1250n)).toBe(10n); // 9 exactly is not enough; 10
  });

  it('uses a larger bump when configured', () => {
    expect(
      bumpFees(
        { maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n },
        { bumpBps: 5000, cap: BIG_CAP },
      ),
    ).toEqual({ maxFeePerGas: 1500n, maxPriorityFeePerGas: 150n });
  });

  it('is always strictly above the 12.5% minimum and keeps priority <= max (seeded)', () => {
    const rand = prng(7);
    for (let i = 0; i < 5000; i += 1) {
      const maxFee = BigInt(randInt(rand, 1_000_000)) * BigInt(1 + randInt(rand, 1000));
      const prio = maxFee === 0n ? 0n : BigInt(randInt(rand, Number(maxFee % 1_000_000n) + 1));
      const prev: Fees = { maxFeePerGas: maxFee, maxPriorityFeePerGas: prio };
      const bps = 1250 + randInt(rand, 3000);
      const next = bumpFees(prev, { bumpBps: bps, cap: BIG_CAP });
      expect(strictlyAboveMinimum(prev.maxFeePerGas, next.maxFeePerGas)).toBe(true);
      expect(strictlyAboveMinimum(prev.maxPriorityFeePerGas, next.maxPriorityFeePerGas)).toBe(true);
      expect(next.maxPriorityFeePerGas <= next.maxFeePerGas).toBe(true);
    }
  });

  it('throws FeeCapExceededError past the cap, and allows exactly the cap', () => {
    expect(() =>
      bumpFees({ maxFeePerGas: 1000n, maxPriorityFeePerGas: 1n }, { cap: 1125n }),
    ).toThrow(FeeCapExceededError);
    expect(
      bumpFees({ maxFeePerGas: 1000n, maxPriorityFeePerGas: 1n }, { cap: 1126n }).maxFeePerGas,
    ).toBe(1126n);
  });

  it('refuses a bump below the replacement minimum and a missing or negative cap', () => {
    const fees = { maxFeePerGas: 10n, maxPriorityFeePerGas: 1n };
    expect(() => bumpFees(fees, { bumpBps: 1249, cap: BIG_CAP })).toThrow(InvalidInputError);
    expect(() => bumpFees(fees, { bumpBps: 1250.5, cap: BIG_CAP })).toThrow(InvalidInputError);
    expect(() => bumpFees(fees, {} as { cap: bigint })).toThrow(/cap/);
    expect(() => bumpFees(fees, { cap: -1n })).toThrow(/cap/);
  });

  it('refuses malformed previous fees', () => {
    expect(() =>
      bumpFees({ maxFeePerGas: 1n, maxPriorityFeePerGas: 2n }, { cap: BIG_CAP }),
    ).toThrow(/priority fee exceeds max fee/);
    expect(() =>
      bumpFees({ maxFeePerGas: -1n, maxPriorityFeePerGas: 0n }, { cap: BIG_CAP }),
    ).toThrow(InvalidInputError);
    expect(() =>
      bumpFees({ maxFeePerGas: 1n, maxPriorityFeePerGas: -1n }, { cap: BIG_CAP }),
    ).toThrow(InvalidInputError);
    expect(() =>
      bumpFees(
        { maxFeePerGas: 1 as unknown as bigint, maxPriorityFeePerGas: 0n },
        { cap: BIG_CAP },
      ),
    ).toThrow(InvalidInputError);
    expect(() =>
      bumpFees(
        { maxFeePerGas: 1n, maxPriorityFeePerGas: 0 as unknown as bigint },
        { cap: BIG_CAP },
      ),
    ).toThrow(InvalidInputError);
  });
});

describe('initialFees', () => {
  const estimate = { maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n };

  it('adds the margin to the max fee only, rounding up', () => {
    expect(initialFees(estimate, { marginBps: 2000 })).toEqual({
      maxFeePerGas: 1200n,
      maxPriorityFeePerGas: 100n,
    });
    expect(initialFees({ maxFeePerGas: 3n, maxPriorityFeePerGas: 1n }, { marginBps: 1 })).toEqual({
      maxFeePerGas: 4n,
      maxPriorityFeePerGas: 1n,
    });
    expect(initialFees(estimate, { marginBps: 0 })).toEqual(estimate);
  });

  it('enforces an optional cap', () => {
    expect(() => initialFees(estimate, { marginBps: 2000, cap: 1199n })).toThrow(
      FeeCapExceededError,
    );
    expect(initialFees(estimate, { marginBps: 2000, cap: 1200n }).maxFeePerGas).toBe(1200n);
    expect(() => initialFees(estimate, { marginBps: 0, cap: -1n })).toThrow(InvalidInputError);
    expect(() => initialFees(estimate, { marginBps: 0, cap: 5 as unknown as bigint })).toThrow(
      InvalidInputError,
    );
  });

  it('refuses a negative margin and malformed estimates', () => {
    expect(() => initialFees(estimate, { marginBps: -1 })).toThrow(InvalidInputError);
    expect(() =>
      initialFees({ maxFeePerGas: 1n, maxPriorityFeePerGas: 5n }, { marginBps: 0 }),
    ).toThrow(InvalidInputError);
  });
});
