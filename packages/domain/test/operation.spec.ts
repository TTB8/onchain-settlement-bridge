import {
  type Address,
  canTransition,
  type Finality,
  InvalidInputError,
  InvalidTransitionError,
  isTerminal,
  journalKindFor,
  lateConfirmation,
  ESCALATION_REASONS,
  mayReverse,
  NOT_ALLOWED,
  type OperationEvent,
  type OperationStatus,
  REFERENCE_ALREADY_USED,
  type ReversalEvidence,
  resolveRevert,
  type SettlementExpectation,
  type SettlingEventLike,
  settlementDifferences,
  SETTLING_EVENT,
  transition,
} from '../src';
import { addr, bh, refOf } from './support/fixtures';

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
  // Late, gated settlement of a failed operation (review M-2 decision).
  'failed:CONFIRM': 'confirmed',
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

  it('has exactly eight legal edges', () => {
    let legal = 0;
    for (const s of STATUSES) for (const e of EVENTS) if (canTransition(s, e)) legal += 1;
    expect(legal).toBe(8);
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

// Finality used throughout: head 100, depth 3. Block 98 has exactly 3 confirmations (final);
// block 99 has 2 (not final).
// Canonical hashes for blocks 90..110 are bh('b<n>'); `at(n)` stamps an event with that position.
const FIN: Finality = {
  head: 100n,
  depth: 3,
  canonicalBlockHashes: new Map(
    Array.from({ length: 21 }, (_, i) => [BigInt(90 + i), bh(`b${90 + i}`)] as const),
  ),
};
const FINAL_BLOCK = 98n;
const SHALLOW_BLOCK = 99n;
const at = (blockNumber: bigint) => ({ blockNumber, blockHash: bh(`b${blockNumber}`) });
/** The reference every operation below carries (unless a test says otherwise). */
const REF = refOf(7);

describe('resolveRevert: the duplicate-submission rule', () => {
  const alice = addr(0xa);
  const bob = addr(0xb);
  const carol = addr(0xc);
  const deposit: SettlementExpectation = {
    ref: REF,
    type: 'deposit',
    amount: 1000n,
    parties: { type: 'deposit', to: alice },
  };
  const withdrawal: SettlementExpectation = {
    ref: REF,
    type: 'withdrawal',
    amount: 50n,
    parties: { type: 'withdrawal', from: alice },
  };
  const transfer: SettlementExpectation = {
    ref: REF,
    type: 'transfer',
    amount: 7n,
    parties: { type: 'transfer', from: alice, to: bob },
  };
  const mint = (to: Address, amount: bigint, blockNumber = FINAL_BLOCK): SettlingEventLike => ({
    kind: 'Minted',
    to,
    amount,
    ref: REF,
    ...at(blockNumber),
  });

  describe('the first submission won (exact settling event on chain)', () => {
    it('confirms a deposit whose final Minted event matches exactly', () => {
      expect(resolveRevert(deposit, REFERENCE_ALREADY_USED, mint(alice, 1000n), FIN)).toEqual({
        verdict: 'confirm',
        event: 'CONFIRM',
      });
    });

    it('confirms a withdrawal and a transfer that match exactly', () => {
      expect(
        resolveRevert(
          withdrawal,
          REFERENCE_ALREADY_USED,
          { kind: 'Burned', from: alice, amount: 50n, ref: REF, ...at(FINAL_BLOCK) },
          FIN,
        ).verdict,
      ).toBe('confirm');
      expect(
        resolveRevert(
          transfer,
          REFERENCE_ALREADY_USED,
          {
            kind: 'SettledTransfer',
            from: alice,
            to: bob,
            amount: 7n,
            ref: REF,
            ...at(FINAL_BLOCK),
          },
          FIN,
        ).verdict,
      ).toBe('confirm');
    });

    it('confirms even if this attempt reverted for another reason (the chain is the record)', () => {
      expect(resolveRevert(deposit, NOT_ALLOWED, mint(alice, 1000n), FIN).verdict).toBe('confirm');
      expect(resolveRevert(deposit, undefined, mint(alice, 1000n), FIN).verdict).toBe('confirm');
    });
  });

  describe('finality of the observed event (review M-1)', () => {
    it('a matching event with fewer than depth confirmations is wait, not confirm', () => {
      expect(
        resolveRevert(deposit, REFERENCE_ALREADY_USED, mint(alice, 1000n, SHALLOW_BLOCK), FIN),
      ).toEqual({ verdict: 'wait' });
    });

    it('a conflicting event that is not final is wait too: it may vanish in a reorg', () => {
      expect(
        resolveRevert(deposit, REFERENCE_ALREADY_USED, mint(alice, 100n, SHALLOW_BLOCK), FIN),
      ).toEqual({ verdict: 'wait' });
    });

    it('an event above a lagging head (0 confirmations) is wait', () => {
      expect(resolveRevert(deposit, undefined, mint(alice, 1000n, 101n), FIN).verdict).toBe('wait');
    });

    it('is decided at exactly depth confirmations', () => {
      expect(resolveRevert(deposit, undefined, mint(alice, 1000n, 98n), FIN).verdict).toBe(
        'confirm',
      );
      expect(resolveRevert(deposit, undefined, mint(alice, 100n, 98n), FIN).verdict).toBe(
        'reference_conflict',
      );
    });

    it('rejects an invalid depth', () => {
      expect(() =>
        resolveRevert(deposit, undefined, mint(alice, 1000n), { ...FIN, depth: 0 }),
      ).toThrow(InvalidInputError);
    });
  });

  describe('the reference was used for something else (conflict, needs a person)', () => {
    it('mint(100) event vs a 1000 deposit is a conflict on amount', () => {
      expect(resolveRevert(deposit, REFERENCE_ALREADY_USED, mint(alice, 100n), FIN)).toEqual({
        verdict: 'reference_conflict',
        reason: 'reference_conflict',
        differences: [{ field: 'amount', expected: 1000n, observed: 100n }],
      });
    });

    it('a burn event vs a deposit is a conflict on kind', () => {
      expect(
        resolveRevert(
          deposit,
          REFERENCE_ALREADY_USED,
          { kind: 'Burned', from: alice, amount: 1000n, ref: REF, ...at(FINAL_BLOCK) },
          FIN,
        ),
      ).toEqual({
        verdict: 'reference_conflict',
        reason: 'reference_conflict',
        differences: [{ field: 'kind', expected: 'Minted', observed: 'Burned' }],
      });
    });

    it('a different recipient is a conflict on `to`', () => {
      const r = resolveRevert(deposit, REFERENCE_ALREADY_USED, mint(bob, 1000n), FIN);
      expect(r.verdict).toBe('reference_conflict');
      expect(r).toMatchObject({ differences: [{ field: 'to', expected: alice, observed: bob }] });
    });

    it('a different sender, or a different transfer recipient, is a conflict', () => {
      expect(
        resolveRevert(
          withdrawal,
          REFERENCE_ALREADY_USED,
          { kind: 'Burned', from: bob, amount: 50n, ref: REF, ...at(FINAL_BLOCK) },
          FIN,
        ).verdict,
      ).toBe('reference_conflict');
      const r = resolveRevert(
        transfer,
        REFERENCE_ALREADY_USED,
        {
          kind: 'SettledTransfer',
          from: carol,
          to: carol,
          amount: 8n,
          ref: REF,
          ...at(FINAL_BLOCK),
        },
        FIN,
      );
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
      const r = resolveRevert(deposit, REFERENCE_ALREADY_USED, mint(alice, 100n), FIN);
      expect('event' in r).toBe(false);
      expect(
        mayReverse({
          failureReason: 'reference_conflict',
          anAttemptCanStillMine: false,
          chainHasEventForRef: false,
          referenceConsumedOnChain: false,
        }),
      ).toBe(false);
    });
  });

  describe('no event for the reference: a real failure', () => {
    it('ReferenceAlreadyUsed with no event is duplicate_reference, never a confirm', () => {
      expect(resolveRevert(deposit, REFERENCE_ALREADY_USED, null, FIN)).toEqual({
        verdict: 'failed',
        event: 'FAIL',
        reason: 'duplicate_reference',
      });
    });

    it('NotAllowed is compliance_rejected', () => {
      expect(resolveRevert(transfer, NOT_ALLOWED, null, FIN)).toEqual({
        verdict: 'failed',
        event: 'FAIL',
        reason: 'compliance_rejected',
      });
    });

    it('any other or undecoded reason is a plain revert', () => {
      expect(resolveRevert(withdrawal, 'EnforcedPause', null, FIN)).toEqual({
        verdict: 'failed',
        event: 'FAIL',
        reason: 'reverted',
      });
      expect(resolveRevert(withdrawal, undefined, null, FIN)).toMatchObject({
        reason: 'reverted',
      });
    });
  });

  it('settlementDifferences is empty exactly for the matching event', () => {
    expect(settlementDifferences(deposit, mint(alice, 1000n))).toEqual([]);
    expect(settlementDifferences(deposit, mint(alice, 999n))).toHaveLength(1);
  });
});

describe('lateConfirmation: a failed operation settling late (review M-2)', () => {
  const alice = addr(0xa);
  const deposit: SettlementExpectation = {
    ref: REF,
    type: 'deposit',
    amount: 1000n,
    parties: { type: 'deposit', to: alice },
  };
  const mint = (amount: bigint, blockNumber: bigint): SettlingEventLike => ({
    kind: 'Minted',
    to: alice,
    amount,
    ref: REF,
    ...at(blockNumber),
  });

  it('confirms on a final, exactly matching event, and the edge failed -> confirmed exists', () => {
    expect(lateConfirmation(deposit, mint(1000n, FINAL_BLOCK), FIN)).toEqual({
      verdict: 'confirm',
      event: 'CONFIRM',
    });
    expect(transition('failed', 'CONFIRM')).toBe('confirmed');
  });

  it('waits on a matching event that is not final', () => {
    expect(lateConfirmation(deposit, mint(1000n, SHALLOW_BLOCK), FIN)).toEqual({ verdict: 'wait' });
  });

  it('reports a conflict, never a confirm, for a final event that differs', () => {
    expect(lateConfirmation(deposit, mint(999n, FINAL_BLOCK), FIN)).toMatchObject({
      verdict: 'reference_conflict',
      differences: [{ field: 'amount', expected: 1000n, observed: 999n }],
    });
  });

  it('rejects an operation whose type disagrees with its parties', () => {
    expect(() =>
      lateConfirmation(
        { ...deposit, parties: { type: 'withdrawal', from: alice } },
        mint(1000n, FINAL_BLOCK),
        FIN,
      ),
    ).toThrow(InvalidInputError);
  });

  it('still leaves no edge out of reversed or confirmed', () => {
    for (const e of EVENTS) {
      expect(canTransition('reversed', e)).toBe(false);
      expect(canTransition('confirmed', e)).toBe(false);
    }
  });
});

describe('binding an event to its operation (review N-2)', () => {
  const alice = addr(0xa);
  const bob = addr(0xb);
  const opA: SettlementExpectation = {
    ref: refOf(0xa1),
    type: 'deposit',
    amount: 1000n,
    parties: { type: 'deposit', to: alice },
  };
  // Operation B is identical to A except for its reference: same user, same amount.
  const opB: SettlementExpectation = { ...opA, ref: refOf(0xb2) };
  const mintFor = (op: SettlementExpectation, blockNumber = FINAL_BLOCK): SettlingEventLike => ({
    kind: 'Minted',
    to: alice,
    amount: 1000n,
    ref: op.ref,
    ...at(blockNumber),
  });

  it("two identical deposits: B's event does NOT confirm A (late or after a revert)", () => {
    const bEvent = mintFor(opB);
    const expected = {
      verdict: 'reference_conflict',
      reason: 'reference_conflict',
      differences: [{ field: 'ref', expected: opA.ref, observed: opB.ref }],
    };
    expect(lateConfirmation(opA, bEvent, FIN)).toEqual(expected);
    expect(resolveRevert(opA, REFERENCE_ALREADY_USED, bEvent, FIN)).toEqual(expected);
    // Each still confirms on its own event.
    expect(lateConfirmation(opA, mintFor(opA), FIN).verdict).toBe('confirm');
    expect(lateConfirmation(opB, bEvent, FIN).verdict).toBe('confirm');
  });

  it('an event cached from an orphaned block (deep number, other hash) gives wait', () => {
    const orphan = { ...mintFor(opA), blockHash: bh('orphan98') };
    expect(lateConfirmation(opA, orphan, FIN)).toEqual({ verdict: 'wait' });
    expect(resolveRevert(opA, REFERENCE_ALREADY_USED, orphan, FIN)).toEqual({ verdict: 'wait' });
  });

  it('an event whose block has no canonical hash gives wait (fail closed)', () => {
    const fin = { ...FIN, canonicalBlockHashes: new Map() };
    expect(lateConfirmation(opA, mintFor(opA), fin)).toEqual({ verdict: 'wait' });
  });

  it('each compared field, changed alone, prevents a confirm', () => {
    const good = mintFor(opA) as Extract<SettlingEventLike, { kind: 'Minted' }>;
    const variants: Array<[string, SettlingEventLike]> = [
      ['ref', { ...good, ref: refOf(0xc3) }],
      ['amount', { ...good, amount: 999n }],
      ['to', { ...good, to: bob }],
      ['kind', { kind: 'Burned', from: alice, amount: 1000n, ref: opA.ref, ...at(FINAL_BLOCK) }],
    ];
    for (const [field, event] of variants) {
      const r = lateConfirmation(opA, event, FIN);
      expect(r).toMatchObject({ verdict: 'reference_conflict', differences: [{ field }] });
    }
    const transfer: SettlementExpectation = {
      ref: refOf(0xd4),
      type: 'transfer',
      amount: 5n,
      parties: { type: 'transfer', from: alice, to: bob },
    };
    const settled: Extract<SettlingEventLike, { kind: 'SettledTransfer' }> = {
      kind: 'SettledTransfer',
      from: alice,
      to: bob,
      amount: 5n,
      ref: transfer.ref,
      ...at(FINAL_BLOCK),
    };
    expect(lateConfirmation(transfer, settled, FIN).verdict).toBe('confirm');
    expect(lateConfirmation(transfer, { ...settled, from: bob }, FIN)).toMatchObject({
      differences: [{ field: 'from' }],
    });
    // Position fields, changed alone, prevent a confirm too.
    expect(lateConfirmation(opA, { ...good, blockHash: bh('x') }, FIN).verdict).toBe('wait');
    expect(lateConfirmation(opA, { ...good, ...at(SHALLOW_BLOCK) }, FIN).verdict).toBe('wait');
  });
});

describe('an operation whose type disagrees with its parties', () => {
  const alice = addr(0xa);
  const bob = addr(0xb);
  // A deposit typed operation carrying transfer parties: the `from` check would silently vanish.
  const inconsistent: SettlementExpectation = {
    ref: REF,
    type: 'deposit',
    amount: 5n,
    parties: { type: 'transfer', from: bob, to: alice },
  };
  const mint: SettlingEventLike = { kind: 'Minted', to: alice, amount: 5n, ref: REF, ...at(1n) };

  it('settlementDifferences throws InvalidInputError instead of comparing', () => {
    expect(() => settlementDifferences(inconsistent, mint)).toThrow(InvalidInputError);
    expect(() => settlementDifferences(inconsistent, mint)).toThrow(/disagrees/);
  });

  it('resolveRevert throws on every branch, never confirming', () => {
    expect(() => resolveRevert(inconsistent, REFERENCE_ALREADY_USED, mint, FIN)).toThrow(
      InvalidInputError,
    );
    expect(() => resolveRevert(inconsistent, REFERENCE_ALREADY_USED, null, FIN)).toThrow(
      InvalidInputError,
    );
    expect(() =>
      resolveRevert(
        { ref: REF, type: 'withdrawal', amount: 5n, parties: { type: 'deposit', to: alice } },
        undefined,
        null,
        FIN,
      ),
    ).toThrow(InvalidInputError);
    // Even when the event is not final yet: the bad input is reported, not deferred.
    expect(() =>
      resolveRevert(inconsistent, undefined, { ...mint, ...at(SHALLOW_BLOCK) }, FIN),
    ).toThrow(InvalidInputError);
  });

  it('a consistent operation is still compared normally', () => {
    expect(
      settlementDifferences({ ...inconsistent, parties: { type: 'deposit', to: alice } }, mint),
    ).toEqual([]);
  });
});

describe('mayReverse', () => {
  const clean: ReversalEvidence = {
    failureReason: 'reverted',
    anAttemptCanStillMine: false,
    chainHasEventForRef: false,
    referenceConsumedOnChain: false,
  };

  it('allows reversal only when every piece of evidence is clean', () => {
    expect(mayReverse(clean)).toBe(true);
    expect(mayReverse({ ...clean, failureReason: 'dropped' })).toBe(true);
    expect(mayReverse({ ...clean, failureReason: 'compliance_rejected' })).toBe(true);
  });

  it('refuses while an attempt can still land', () => {
    expect(mayReverse({ ...clean, anAttemptCanStillMine: true })).toBe(false);
  });

  it('refuses when the index shows a settling event', () => {
    expect(mayReverse({ ...clean, chainHasEventForRef: true })).toBe(false);
  });

  it('refuses when the contract says the reference was consumed, whatever the index shows', () => {
    expect(mayReverse({ ...clean, referenceConsumedOnChain: true })).toBe(false);
  });

  it('review H-1: duplicate_reference, no visible event, nothing pending, consumed flag true -> false', () => {
    expect(
      mayReverse({
        failureReason: 'duplicate_reference',
        anAttemptCanStillMine: false,
        chainHasEventForRef: false,
        referenceConsumedOnChain: true,
      }),
    ).toBe(false);
  });

  it('never auto-reverses an escalation, even with every other flag clean', () => {
    expect(mayReverse({ ...clean, failureReason: 'duplicate_reference' })).toBe(false);
    expect(mayReverse({ ...clean, failureReason: 'reference_conflict' })).toBe(false);
    expect([...ESCALATION_REASONS].sort()).toEqual(['duplicate_reference', 'reference_conflict']);
  });
});
