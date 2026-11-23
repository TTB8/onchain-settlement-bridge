import {
  assessAttempt,
  attemptCanStillMine,
  isFinal,
  isFinalAndCanonical,
  mayReverse,
  type AttemptObservation,
  type AttemptPolicy,
  type AttemptRecord,
  confirmationsOf,
  InvalidInputError,
  isConfirmed,
} from '../src';
import { bh } from './support/fixtures';

describe('confirmationsOf', () => {
  it('counts the mined block itself as one confirmation', () => {
    expect(confirmationsOf(100n, 100n)).toBe(1n);
    expect(confirmationsOf(100n, 111n)).toBe(12n);
  });

  it('is 0 when not mined or when the head is behind the block', () => {
    expect(confirmationsOf(null, 100n)).toBe(0n);
    expect(confirmationsOf(101n, 100n)).toBe(0n);
  });
});

describe('isConfirmed', () => {
  it('needs at least `depth` confirmations: a tx at block N is not confirmed at N + depth - 2', () => {
    expect(isConfirmed(100n, 110n, 12)).toBe(false); // 11 confirmations
    expect(isConfirmed(100n, 111n, 12)).toBe(true); // exactly 12
    expect(isConfirmed(100n, 100n, 1)).toBe(true);
    expect(isConfirmed(null, 1_000n, 1)).toBe(false);
  });

  it('rejects a depth below 1 or non-integer', () => {
    expect(() => isConfirmed(1n, 2n, 0)).toThrow(InvalidInputError);
    expect(() => isConfirmed(1n, 2n, 1.5)).toThrow(InvalidInputError);
  });
});

describe('assessAttempt', () => {
  const T0 = new Date('2026-01-01T00:00:00Z');
  const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
  const policy: AttemptPolicy = {
    confirmations: 12,
    stuckAfterSeconds: 60,
    maxBumps: 3,
    maxResubmits: 2,
    bumpFeeBps: 1250,
    feeCap: 10_000n,
  };
  const attempt: AttemptRecord = {
    nonce: 5,
    fees: { maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n },
    submittedAt: T0,
    bumpsSoFar: 0,
    resubmitsSoFar: 0,
  };
  const pending: AttemptObservation = {
    receipt: null,
    nodeKnowsTx: true,
    confirmedNonce: 5,
    finalNonce: 5,
    head: 200n,
  };

  describe('mined', () => {
    it('a confirmed-looking tx (mined, fewer confirmations than depth) is NOT confirmed', () => {
      const v = assessAttempt(
        attempt,
        { ...pending, receipt: { status: 'success', blockNumber: 190n }, confirmedNonce: 6 },
        at(10),
        policy,
      );
      expect(v).toEqual({ verdict: 'mined_unconfirmed', confirmations: 11n, status: 'success' });
    });

    it('is confirmed at exactly the depth', () => {
      expect(
        assessAttempt(
          attempt,
          { ...pending, receipt: { status: 'success', blockNumber: 189n }, confirmedNonce: 6 },
          at(10),
          policy,
        ),
      ).toEqual({ verdict: 'confirmed', blockNumber: 189n });
    });

    it('a reverted tx is only final after depth, and carries its reason', () => {
      const shallow = assessAttempt(
        attempt,
        {
          ...pending,
          receipt: { status: 'reverted', blockNumber: 195n, revertReason: 'NotAllowed' },
        },
        at(10),
        policy,
      );
      expect(shallow).toEqual({
        verdict: 'mined_unconfirmed',
        confirmations: 6n,
        status: 'reverted',
      });
      const deep = assessAttempt(
        attempt,
        {
          ...pending,
          receipt: { status: 'reverted', blockNumber: 150n, revertReason: 'NotAllowed' },
        },
        at(10),
        policy,
      );
      expect(deep).toEqual({ verdict: 'reverted', blockNumber: 150n, reason: 'NotAllowed' });
    });

    it('a reverted tx with an undecoded reason reports undefined', () => {
      expect(
        assessAttempt(
          attempt,
          { ...pending, receipt: { status: 'reverted', blockNumber: 1n } },
          at(10),
          policy,
        ),
      ).toEqual({ verdict: 'reverted', blockNumber: 1n, reason: undefined });
    });

    it('a receipt from a block above a lagging head has 0 confirmations', () => {
      expect(
        assessAttempt(
          attempt,
          { ...pending, receipt: { status: 'success', blockNumber: 201n } },
          at(1),
          policy,
        ),
      ).toMatchObject({ verdict: 'mined_unconfirmed', confirmations: 0n });
    });
  });

  describe('reorg: a mined tx whose receipt vanishes', () => {
    const minedAt = {
      ...pending,
      receipt: { status: 'success' as const, blockNumber: 195n },
      confirmedNonce: 6,
    };

    it('before the reorg it looks mined but unconfirmed', () => {
      expect(assessAttempt(attempt, minedAt, at(30), policy).verdict).toBe('mined_unconfirmed');
    });

    it('after the reorg, back in the pool: waits (or bumps once stuck), never confirmed', () => {
      const afterReorg = { ...pending, confirmedNonce: 5 };
      expect(assessAttempt(attempt, afterReorg, at(30), policy)).toEqual({ verdict: 'wait' });
      expect(assessAttempt(attempt, afterReorg, at(61), policy).verdict).toBe('stuck_bump');
    });

    it('after the reorg, forgotten by the node with the nonce free: dropped', () => {
      expect(
        assessAttempt(
          attempt,
          { ...pending, nodeKnowsTx: false, confirmedNonce: 5 },
          at(30),
          policy,
        ),
      ).toEqual({ verdict: 'dropped' });
    });

    it('after the reorg, the nonce consumed FINALLY by another tx: replaced_or_lost', () => {
      expect(
        assessAttempt(
          attempt,
          { ...pending, nodeKnowsTx: false, confirmedNonce: 6, finalNonce: 6 },
          at(30),
          policy,
        ),
      ).toEqual({ verdict: 'replaced_or_lost' });
    });

    it('the nonce consumed only at the head (not final): wait, never replaced_or_lost', () => {
      expect(
        assessAttempt(
          attempt,
          { ...pending, nodeKnowsTx: false, confirmedNonce: 6, finalNonce: 5 },
          at(30),
          policy,
        ),
      ).toEqual({ verdict: 'wait' });
      // Not even after the stuck timeout or past the resubmit limit: nothing is sent, nothing given up.
      expect(
        assessAttempt(
          { ...attempt, bumpsSoFar: 99, resubmitsSoFar: 99 },
          { ...pending, nodeKnowsTx: false, confirmedNonce: 6, finalNonce: 5 },
          at(9_999),
          policy,
        ),
      ).toEqual({ verdict: 'wait' });
    });
  });

  describe('not mined', () => {
    it('resubmits a drop one below the limit and gives up exactly at it', () => {
      const forgotten = { ...pending, nodeKnowsTx: false };
      expect(assessAttempt({ ...attempt, resubmitsSoFar: 1 }, forgotten, at(5), policy)).toEqual({
        verdict: 'dropped',
      });
      expect(assessAttempt({ ...attempt, resubmitsSoFar: 2 }, forgotten, at(5), policy)).toEqual({
        verdict: 'give_up',
        why: 'max_resubmits',
      });
      expect(assessAttempt({ ...attempt, resubmitsSoFar: 9 }, forgotten, at(5), policy)).toEqual({
        verdict: 'give_up',
        why: 'max_resubmits',
      });
    });

    it('maxResubmits 0 means a drop is never resubmitted', () => {
      expect(
        assessAttempt(attempt, { ...pending, nodeKnowsTx: false }, at(5), {
          ...policy,
          maxResubmits: 0,
        }),
      ).toEqual({ verdict: 'give_up', why: 'max_resubmits' });
    });

    it('the resubmit limit does not affect a pending or replaced attempt', () => {
      const exhausted = { ...attempt, resubmitsSoFar: 2 };
      expect(assessAttempt(exhausted, pending, at(5), policy)).toEqual({ verdict: 'wait' });
      expect(
        assessAttempt(
          exhausted,
          { ...pending, nodeKnowsTx: false, confirmedNonce: 6, finalNonce: 6 },
          at(5),
          policy,
        ),
      ).toEqual({ verdict: 'replaced_or_lost' });
    });

    it('dropped: the node forgot it and the nonce is still free', () => {
      expect(assessAttempt(attempt, { ...pending, nodeKnowsTx: false }, at(5), policy)).toEqual({
        verdict: 'dropped',
      });
    });

    it('replaced_or_lost takes precedence over dropped and over pending', () => {
      expect(
        assessAttempt(
          attempt,
          { ...pending, nodeKnowsTx: true, confirmedNonce: 9, finalNonce: 9 },
          at(500),
          policy,
        ),
      ).toEqual({ verdict: 'replaced_or_lost' });
    });

    it('waits until stuckAfterSeconds, then bumps with the same nonce and higher fees', () => {
      expect(assessAttempt(attempt, pending, at(59), policy)).toEqual({ verdict: 'wait' });
      expect(assessAttempt(attempt, pending, at(60), policy)).toEqual({
        verdict: 'stuck_bump',
        nonce: 5,
        fees: { maxFeePerGas: 1126n, maxPriorityFeePerGas: 113n },
      });
    });

    it('waits when the clock reads earlier than submission (skew), rather than bumping', () => {
      expect(assessAttempt(attempt, pending, at(-30), policy)).toEqual({ verdict: 'wait' });
    });

    it('gives up once maxBumps is reached', () => {
      expect(assessAttempt({ ...attempt, bumpsSoFar: 2 }, pending, at(61), policy).verdict).toBe(
        'stuck_bump',
      );
      expect(assessAttempt({ ...attempt, bumpsSoFar: 3 }, pending, at(61), policy)).toEqual({
        verdict: 'give_up',
        why: 'max_bumps',
      });
    });

    it('gives up when the next bump would pass the fee cap', () => {
      expect(assessAttempt(attempt, pending, at(61), { ...policy, feeCap: 1125n })).toEqual({
        verdict: 'give_up',
        why: 'fee_cap',
      });
    });

    it('rethrows a non-cap error from the bump (bad policy)', () => {
      expect(() => assessAttempt(attempt, pending, at(61), { ...policy, bumpFeeBps: 100 })).toThrow(
        InvalidInputError,
      );
    });
  });

  describe('input validation', () => {
    it.each<[string, () => unknown]>([
      ['depth 0', () => assessAttempt(attempt, pending, at(1), { ...policy, confirmations: 0 })],
      ['negative nonce', () => assessAttempt({ ...attempt, nonce: -1 }, pending, at(1), policy)],
      [
        'fractional bumps',
        () => assessAttempt({ ...attempt, bumpsSoFar: 0.5 }, pending, at(1), policy),
      ],
      [
        'negative confirmed nonce',
        () => assessAttempt(attempt, { ...pending, confirmedNonce: -1 }, at(1), policy),
      ],
      [
        'negative final nonce',
        () => assessAttempt(attempt, { ...pending, finalNonce: -1 }, at(1), policy),
      ],
      [
        'final nonce above the head nonce',
        () =>
          assessAttempt(attempt, { ...pending, confirmedNonce: 5, finalNonce: 6 }, at(1), policy),
      ],
      [
        'negative resubmitsSoFar',
        () => assessAttempt({ ...attempt, resubmitsSoFar: -1 }, pending, at(1), policy),
      ],
      [
        'fractional resubmitsSoFar',
        () => assessAttempt({ ...attempt, resubmitsSoFar: 1.5 }, pending, at(1), policy),
      ],
      [
        'negative maxResubmits',
        () => assessAttempt(attempt, pending, at(1), { ...policy, maxResubmits: -1 }),
      ],
      [
        'missing maxResubmits',
        () =>
          assessAttempt(attempt, pending, at(1), {
            ...policy,
            maxResubmits: undefined as unknown as number,
          }),
      ],
      [
        'negative maxBumps',
        () => assessAttempt(attempt, pending, at(1), { ...policy, maxBumps: -1 }),
      ],
      [
        'negative stuckAfter',
        () => assessAttempt(attempt, pending, at(1), { ...policy, stuckAfterSeconds: -1 }),
      ],
      [
        'NaN stuckAfter',
        () => assessAttempt(attempt, pending, at(1), { ...policy, stuckAfterSeconds: Number.NaN }),
      ],
      [
        'invalid submittedAt',
        () => assessAttempt({ ...attempt, submittedAt: new Date('x') }, pending, at(1), policy),
      ],
      ['invalid now', () => assessAttempt(attempt, pending, new Date(Number.NaN), policy)],
      ['non-Date now', () => assessAttempt(attempt, pending, 5 as unknown as Date, policy)],
    ])('rejects %s', (_label, fn) => {
      expect(fn).toThrow(InvalidInputError);
    });
  });
});

describe('attemptCanStillMine (review M-1)', () => {
  const depth = 3;
  const base: AttemptObservation = {
    receipt: null,
    nodeKnowsTx: true,
    confirmedNonce: 5,
    finalNonce: 5,
    head: 100n,
  };

  it('review scenario: a replacement mined with 1 of 3 confirmations must not allow reversal', () => {
    // Our attempt (nonce 5) was replaced by another tx mined at the head (block 100): the head nonce
    // is 6, but the final block (98) still shows 5. A 1-block reorg could bring ours back.
    const obs = { ...base, nodeKnowsTx: false, confirmedNonce: 6, finalNonce: 5 };
    expect(attemptCanStillMine({ nonce: 5 }, obs, depth)).toBe(true);
    expect(
      mayReverse({
        failureReason: 'reverted',
        anAttemptCanStillMine: attemptCanStillMine({ nonce: 5 }, obs, depth),
        chainHasEventForRef: false,
        referenceConsumedOnChain: false,
      }),
    ).toBe(false);
  });

  it('is false once the nonce use is final', () => {
    expect(
      attemptCanStillMine({ nonce: 5 }, { ...base, confirmedNonce: 6, finalNonce: 6 }, depth),
    ).toBe(false);
    expect(attemptCanStillMine({ nonce: 4 }, base, depth)).toBe(false);
  });

  it('is true for a pending attempt and for one whose node forgot it', () => {
    expect(attemptCanStillMine({ nonce: 5 }, base, depth)).toBe(true);
    expect(attemptCanStillMine({ nonce: 5 }, { ...base, nodeKnowsTx: false }, depth)).toBe(true);
  });

  it('a receipt counts only once final: exactly depth deep is final, one less is not', () => {
    const shallow = { ...base, receipt: { status: 'reverted' as const, blockNumber: 99n } };
    const exact = { ...base, receipt: { status: 'reverted' as const, blockNumber: 98n } };
    expect(attemptCanStillMine({ nonce: 5 }, shallow, depth)).toBe(true);
    expect(attemptCanStillMine({ nonce: 5 }, exact, depth)).toBe(false);
    expect(
      attemptCanStillMine(
        { nonce: 5 },
        { ...base, receipt: { status: 'success', blockNumber: 1n } },
        depth,
      ),
    ).toBe(false);
  });

  it('validates its inputs', () => {
    expect(() => attemptCanStillMine({ nonce: 5 }, base, 0)).toThrow(InvalidInputError);
    expect(() => attemptCanStillMine({ nonce: -1 }, base, depth)).toThrow(InvalidInputError);
    expect(() => attemptCanStillMine({ nonce: 5 }, { ...base, finalNonce: 6 }, depth)).toThrow(
      InvalidInputError,
    );
  });
});

describe('isFinal', () => {
  it('is final at exactly depth confirmations', () => {
    expect(isFinal(98n, { head: 100n, depth: 3, canonicalBlockHashes: new Map() })).toBe(true);
    expect(isFinal(99n, { head: 100n, depth: 3, canonicalBlockHashes: new Map() })).toBe(false);
  });
});

describe('isFinalAndCanonical (review N-2)', () => {
  const fin = {
    head: 100n,
    depth: 3,
    canonicalBlockHashes: new Map([[98n, bh('b98')] as const, [99n, bh('b99')] as const]),
  };

  it('needs both depth and the canonical hash', () => {
    expect(isFinalAndCanonical({ blockNumber: 98n, blockHash: bh('b98') }, fin)).toBe(true);
    expect(isFinalAndCanonical({ blockNumber: 99n, blockHash: bh('b99') }, fin)).toBe(false);
    expect(isFinalAndCanonical({ blockNumber: 98n, blockHash: bh('orphan') }, fin)).toBe(false);
    expect(isFinalAndCanonical({ blockNumber: 97n, blockHash: bh('b97') }, fin)).toBe(false);
  });
});
