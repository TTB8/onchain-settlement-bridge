import { InvalidInputError, nextNonce } from '../src';
import { prng, randInt } from './support/fixtures';

describe('nextNonce', () => {
  it("uses the chain's pending count when nothing is reserved", () => {
    expect(nextNonce({ chainPending: 0, reservedLocally: [] })).toBe(0);
    expect(nextNonce({ chainPending: 7, reservedLocally: [] })).toBe(7);
  });

  it('skips nonces reserved locally', () => {
    expect(nextNonce({ chainPending: 5, reservedLocally: [5, 6] })).toBe(7);
    expect(nextNonce({ chainPending: 5, reservedLocally: [6, 5, 5] })).toBe(7);
  });

  it('fills a gap in the reservations first', () => {
    expect(nextNonce({ chainPending: 5, reservedLocally: [5, 7, 8] })).toBe(6);
  });

  it("never goes below the chain's pending count, ignoring stale reservations", () => {
    expect(nextNonce({ chainPending: 10, reservedLocally: [1, 2, 3] })).toBe(10);
    expect(nextNonce({ chainPending: 10, reservedLocally: [3, 10, 12] })).toBe(11);
  });

  it('is never reserved and never below pending (seeded)', () => {
    const rand = prng(99);
    for (let i = 0; i < 2000; i += 1) {
      const chainPending = randInt(rand, 50);
      const reservedLocally = Array.from({ length: randInt(rand, 20) }, () => randInt(rand, 70));
      const n = nextNonce({ chainPending, reservedLocally });
      expect(n).toBeGreaterThanOrEqual(chainPending);
      expect(reservedLocally).not.toContain(n);
      for (let m = chainPending; m < n; m += 1) expect(reservedLocally).toContain(m);
    }
  });

  it('rejects negative or non-integer inputs', () => {
    expect(() => nextNonce({ chainPending: -1, reservedLocally: [] })).toThrow(InvalidInputError);
    expect(() => nextNonce({ chainPending: 1.5, reservedLocally: [] })).toThrow(InvalidInputError);
    expect(() => nextNonce({ chainPending: 1, reservedLocally: [-2] })).toThrow(InvalidInputError);
    expect(() => nextNonce({ chainPending: 1, reservedLocally: [Number.NaN] })).toThrow(
      InvalidInputError,
    );
  });
});
