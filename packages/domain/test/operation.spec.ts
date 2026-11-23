import {
  canTransition,
  InvalidInputError,
  InvalidTransitionError,
  isTerminal,
  journalKindFor,
  mayReverse,
  NOT_ALLOWED,
  type OperationEvent,
  type OperationStatus,
  REFERENCE_ALREADY_USED,
  resolveRevert,
  type SettlementExpectation,
  settlementDifferences,
  SETTLING_EVENT,
  transition,
} from '../src';
import { addr } from './support/fixtures';

const STATUSES: OperationStatus[] = [
  'requested',
  'ledger_reserved',
  'submitted',
  'confirmed',
  'failed',
  'reversed',
];
const EVENTS: OperationEvent[] = ['RESERVE', 'SUBMIT', 'CONFIRM', 'FAIL', 'REVERSE'];

/** The exact table from the specification; the test enumerates every other pair as illegal. */
const LEGAL: Record<string, OperationStatus> = {
  'requested:RESERVE': 'ledger_reserved',
  'ledger_reserved:SUBMIT': 'submitted',
  'submitted:SUBMIT': 'submitted',
  'submitted:CONFIRM': 'confirmed',
  'ledger_reserved:FAIL': 'failed',
  'submitted:FAIL': 'failed',
  'failed:REVERSE': 'reversed',
};

describe('operation state machine', () => {
  describe.each(STATUSES)('from %s', (status) => {
    it.each(EVENTS)('on %s', (event) => {
      const expected = LEGAL[`${status}:${event}`];
      if (expected === undefined) {
        expect(canTransition(status, event)).toBe(false);
        expect(() => transition(status, event)).toThrow(InvalidTransitionError);
      } else {
        expect(canTransition(status, event)).toBe(true);
        expect(transition(status, event)).toBe(expected);
      }
    });
  });

  it('has exactly seven legal edges', () => {
    let legal = 0;
    for (const s of STATUSES) for (const e of EVENTS) if (canTransition(s, e)) legal += 1;
    expect(legal).toBe(7);
  });

  it('reports the refused edge in the error', () => {
    try {
      transition('confirmed', 'REVERSE');
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      expect((err as InvalidTransitionError).from).toBe('confirmed');
      expect((err as InvalidTransitionError).event).toBe('REVERSE');
      expect((err as InvalidTransitionError).machine).toBe('operation');
    }
  });

  it('cannot settle twice or refund a settled operation', () => {
    expect(() => transition('confirmed', 'CONFIRM')).toThrow(InvalidTransitionError);
    expect(() => transition('confirmed', 'FAIL')).toThrow(InvalidTransitionError);
    expect(() => transition('reversed', 'REVERSE')).toThrow(InvalidTransitionError);
  });

  it('cannot skip the ledger reservation', () => {
    expect(() => transition('requested', 'SUBMIT')).toThrow(InvalidTransitionError);
    expect(() => transition('requested', 'FAIL')).toThrow(InvalidTransitionError);
  });

  it('treats only confirmed and reversed as terminal, and they have no outgoing edges', () => {
    for (const s of STATUSES) {
      const terminal = s === 'confirmed' || s === 'reversed';
      expect(isTerminal(s)).toBe(terminal);
      if (terminal) for (const e of EVENTS) expect(canTransition(s, e)).toBe(false);
    }
  });

  it('writes a journal entry on RESERVE, CONFIRM and REVERSE only', () => {
    expect(journalKindFor('RESERVE')).toBe('reserve');
    expect(journalKindFor('CONFIRM')).toBe('settle');
    expect(journalKindFor('REVERSE')).toBe('reverse');
    expect(journalKindFor('SUBMIT')).toBeNull();
    expect(journalKindFor('FAIL')).toBeNull();
  });
});

describe('settling events', () => {
  it('maps each operation type to its settling event', () => {
    expect(SETTLING_EVENT).toEqual({
      deposit: 'Minted',
      withdrawal: 'Burned',
      transfer: 'SettledTransfer',
    });
  });
});

describe('resolveRevert: the duplicate-submission rule', () => {
  const alice = addr(0xa);
  const bob = addr(0xb);
  const carol = addr(0xc);
  const deposit: SettlementExpectation = {
    type: 'deposit',
    amount: 1000n,
    parties: { type: 'deposit', to: alice },
  };
  const withdrawal: SettlementExpectation = {
    type: 'withdrawal',
    amount: 50n,
    parties: { type: 'withdrawal', from: alice },
  };
  const transfer: SettlementExpectation = {
    type: 'transfer',
    amount: 7n,
    parties: { type: 'transfer', from: alice, to: bob },
  };

  describe('the first submission won (exact settling event on chain)', () => {
    it('confirms a deposit whose Minted event matches exactly', () => {
      expect(
        resolveRevert(deposit, REFERENCE_ALREADY_USED, {
          kind: 'Minted',
          to: alice,
          amount: 1000n,
        }),
      ).toEqual({ verdict: 'confirm', event: 'CONFIRM' });
    });

    it('confirms a withdrawal and a transfer that match exactly', () => {
      expect(
        resolveRevert(withdrawal, REFERENCE_ALREADY_USED, {
          kind: 'Burned',
          from: alice,
          amount: 50n,
        }).verdict,
      ).toBe('confirm');
      expect(
        resolveRevert(transfer, REFERENCE_ALREADY_USED, {
          kind: 'SettledTransfer',
          from: alice,
          to: bob,
          amount: 7n,
        }).verdict,
      ).toBe('confirm');
    });

    it('confirms even if this attempt reverted for another reason (the chain is the record)', () => {
      expect(
        resolveRevert(deposit, NOT_ALLOWED, { kind: 'Minted', to: alice, amount: 1000n }).verdict,
      ).toBe('confirm');
      expect(
        resolveRevert(deposit, undefined, { kind: 'Minted', to: alice, amount: 1000n }).verdict,
      ).toBe('confirm');
    });
  });

  describe('the reference was used for something else (conflict, needs a person)', () => {
    it('mint(100) event vs a 1000 deposit is a conflict on amount', () => {
      expect(
        resolveRevert(deposit, REFERENCE_ALREADY_USED, { kind: 'Minted', to: alice, amount: 100n }),
      ).toEqual({
        verdict: 'reference_conflict',
        reason: 'reference_conflict',
        differences: [{ field: 'amount', expected: 1000n, observed: 100n }],
      });
    });

    it('a burn event vs a deposit is a conflict on kind', () => {
      expect(
        resolveRevert(deposit, REFERENCE_ALREADY_USED, {
          kind: 'Burned',
          from: alice,
          amount: 1000n,
        }),
      ).toEqual({
        verdict: 'reference_conflict',
        reason: 'reference_conflict',
        differences: [{ field: 'kind', expected: 'Minted', observed: 'Burned' }],
      });
    });

    it('a different recipient is a conflict on `to`', () => {
      const r = resolveRevert(deposit, REFERENCE_ALREADY_USED, {
        kind: 'Minted',
        to: bob,
        amount: 1000n,
      });
      expect(r.verdict).toBe('reference_conflict');
      expect(r).toMatchObject({ differences: [{ field: 'to', expected: alice, observed: bob }] });
    });

    it('a different sender, or a different transfer recipient, is a conflict', () => {
      expect(
        resolveRevert(withdrawal, REFERENCE_ALREADY_USED, {
          kind: 'Burned',
          from: bob,
          amount: 50n,
        }).verdict,
      ).toBe('reference_conflict');
      const r = resolveRevert(transfer, REFERENCE_ALREADY_USED, {
        kind: 'SettledTransfer',
        from: carol,
        to: carol,
        amount: 8n,
      });
      expect(r).toMatchObject({
        verdict: 'reference_conflict',
        differences: [
          { field: 'amount', expected: 7n, observed: 8n },
          { field: 'from', expected: alice, observed: carol },
          { field: 'to', expected: bob, observed: carol },
        ],
      });
    });

    it('a conflict is never a CONFIRM or a REVERSE edge', () => {
      const r = resolveRevert(deposit, REFERENCE_ALREADY_USED, {
        kind: 'Minted',
        to: alice,
        amount: 100n,
      });
      expect('event' in r).toBe(false);
      expect(
        mayReverse({
          failureReason: 'reference_conflict',
          anAttemptCanStillMine: false,
          chainHasEventForRef: false,
        }),
      ).toBe(false);
    });
  });

  describe('no event for the reference: a real failure', () => {
    it('ReferenceAlreadyUsed with no event is duplicate_reference, never a confirm', () => {
      expect(resolveRevert(deposit, REFERENCE_ALREADY_USED, null)).toEqual({
        verdict: 'failed',
        event: 'FAIL',
        reason: 'duplicate_reference',
      });
    });

    it('NotAllowed is compliance_rejected', () => {
      expect(resolveRevert(transfer, NOT_ALLOWED, null)).toEqual({
        verdict: 'failed',
        event: 'FAIL',
        reason: 'compliance_rejected',
      });
    });

    it('any other or undecoded reason is a plain revert', () => {
      expect(resolveRevert(withdrawal, 'EnforcedPause', null)).toEqual({
        verdict: 'failed',
        event: 'FAIL',
        reason: 'reverted',
      });
      expect(resolveRevert(withdrawal, undefined, null)).toMatchObject({ reason: 'reverted' });
    });
  });

  it('settlementDifferences is empty exactly for the matching event', () => {
    expect(settlementDifferences(deposit, { kind: 'Minted', to: alice, amount: 1000n })).toEqual(
      [],
    );
    expect(
      settlementDifferences(deposit, { kind: 'Minted', to: alice, amount: 999n }),
    ).toHaveLength(1);
  });
});

describe('an operation whose type disagrees with its parties', () => {
  const alice = addr(0xa);
  const bob = addr(0xb);
  // A deposit typed operation carrying transfer parties: the `from` check would silently vanish.
  const inconsistent: SettlementExpectation = {
    type: 'deposit',
    amount: 5n,
    parties: { type: 'transfer', from: bob, to: alice },
  };
  const mint = { kind: 'Minted', to: alice, amount: 5n } as const;

  it('settlementDifferences throws InvalidInputError instead of comparing', () => {
    expect(() => settlementDifferences(inconsistent, mint)).toThrow(InvalidInputError);
    expect(() => settlementDifferences(inconsistent, mint)).toThrow(/disagrees/);
  });

  it('resolveRevert throws on every branch, never confirming', () => {
    expect(() => resolveRevert(inconsistent, REFERENCE_ALREADY_USED, mint)).toThrow(
      InvalidInputError,
    );
    expect(() => resolveRevert(inconsistent, REFERENCE_ALREADY_USED, null)).toThrow(
      InvalidInputError,
    );
    expect(() =>
      resolveRevert(
        { type: 'withdrawal', amount: 5n, parties: { type: 'deposit', to: alice } },
        undefined,
        null,
      ),
    ).toThrow(InvalidInputError);
  });

  it('a consistent operation is still compared normally', () => {
    expect(
      settlementDifferences({ ...inconsistent, parties: { type: 'deposit', to: alice } }, mint),
    ).toEqual([]);
  });
});

describe('mayReverse', () => {
  it('allows reversal only when no attempt can land, no event exists and it is not a conflict', () => {
    expect(
      mayReverse({
        failureReason: 'reverted',
        anAttemptCanStillMine: false,
        chainHasEventForRef: false,
      }),
    ).toBe(true);
    expect(
      mayReverse({
        failureReason: 'reverted',
        anAttemptCanStillMine: true,
        chainHasEventForRef: false,
      }),
    ).toBe(false);
    expect(
      mayReverse({
        failureReason: 'dropped',
        anAttemptCanStillMine: false,
        chainHasEventForRef: true,
      }),
    ).toBe(false);
  });
});
