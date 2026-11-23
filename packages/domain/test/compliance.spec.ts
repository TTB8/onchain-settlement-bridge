import {
  type Address,
  applyComplianceAction,
  assertCanStart,
  canTransact,
  type ComplianceAction,
  type ComplianceChangeEvent,
  type ComplianceChangeStatus,
  ComplianceRejectedError,
  type ComplianceState,
  complianceViolations,
  flagChangeFor,
  type InFlightStatus,
  inFlightComplianceCheck,
  InvalidInputError,
  InvalidTransitionError,
  transitionComplianceChange,
} from '../src';
import { addr } from './support/fixtures';

const OK: ComplianceState = { verified: true, frozen: false };
const FROZEN: ComplianceState = { verified: true, frozen: true };
const UNVERIFIED: ComplianceState = { verified: false, frozen: false };

const alice = addr(1);
const bob = addr(2);

function states(entries: Array<[Address, ComplianceState]>): ReadonlyMap<Address, ComplianceState> {
  return new Map(entries);
}

describe('canTransact', () => {
  it('is verified && !frozen', () => {
    expect(canTransact(OK)).toBe(true);
    expect(canTransact(FROZEN)).toBe(false);
    expect(canTransact(UNVERIFIED)).toBe(false);
    expect(canTransact({ verified: false, frozen: true })).toBe(false);
  });
});

describe('assertCanStart', () => {
  it('passes when every party may transact', () => {
    const s = states([
      [alice, OK],
      [bob, OK],
    ]);
    expect(() => assertCanStart({ type: 'deposit', to: alice }, s)).not.toThrow();
    expect(() => assertCanStart({ type: 'withdrawal', from: alice }, s)).not.toThrow();
    expect(() => assertCanStart({ type: 'transfer', from: alice, to: bob }, s)).not.toThrow();
  });

  it("checks a deposit's recipient", () => {
    expect(() =>
      assertCanStart({ type: 'deposit', to: alice }, states([[alice, UNVERIFIED]])),
    ).toThrow(ComplianceRejectedError);
  });

  it("checks a withdrawal's owner", () => {
    try {
      assertCanStart({ type: 'withdrawal', from: alice }, states([[alice, FROZEN]]));
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ComplianceRejectedError);
      expect((err as ComplianceRejectedError).violations).toEqual([
        { party: 'owner', address: alice, reason: 'frozen' },
      ]);
    }
  });

  it('checks both sides of a transfer and names every failing party, sender first', () => {
    try {
      assertCanStart(
        { type: 'transfer', from: alice, to: bob },
        states([
          [alice, UNVERIFIED],
          [bob, FROZEN],
        ]),
      );
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as ComplianceRejectedError).violations).toEqual([
        { party: 'sender', address: alice, reason: 'not_verified' },
        { party: 'recipient', address: bob, reason: 'frozen' },
      ]);
    }
  });

  it('rejects a frozen recipient of a transfer even when the sender is fine', () => {
    expect(() =>
      assertCanStart(
        { type: 'transfer', from: alice, to: bob },
        states([
          [alice, OK],
          [bob, FROZEN],
        ]),
      ),
    ).toThrow(/recipient/);
  });

  it('fails closed when an address has no known state', () => {
    expect(complianceViolations({ type: 'deposit', to: alice }, states([]))).toEqual([
      { party: 'recipient', address: alice, reason: 'unknown' },
    ]);
  });

  it('reports frozen ahead of unverified for an address that is both', () => {
    expect(
      complianceViolations(
        { type: 'deposit', to: alice },
        states([[alice, { verified: false, frozen: true }]]),
      ),
    ).toEqual([{ party: 'recipient', address: alice, reason: 'frozen' }]);
  });
});

describe('inFlightComplianceCheck: frozen address mid-operation', () => {
  const transfer = { type: 'transfer', from: alice, to: bob } as const;

  it('lets an operation proceed when every party is still allowed', () => {
    const s = states([
      [alice, OK],
      [bob, OK],
    ]);
    expect(inFlightComplianceCheck('ledger_reserved', transfer, s)).toEqual({ action: 'proceed' });
    expect(inFlightComplianceCheck('submitted', transfer, s)).toEqual({ action: 'proceed' });
  });

  it('abandons a reserved, unsent operation with FAIL compliance_rejected', () => {
    const verdict = inFlightComplianceCheck(
      'ledger_reserved',
      transfer,
      states([
        [alice, OK],
        [bob, FROZEN],
      ]),
    );
    expect(verdict).toEqual({
      action: 'abandon',
      event: 'FAIL',
      reason: 'compliance_rejected',
      violations: [{ party: 'recipient', address: bob, reason: 'frozen' }],
    });
  });

  it('leaves an already-sent operation to the chain, which will reject it', () => {
    const verdict = inFlightComplianceCheck(
      'submitted',
      transfer,
      states([
        [alice, FROZEN],
        [bob, OK],
      ]),
    );
    expect(verdict).toEqual({
      action: 'chain_will_reject',
      violations: [{ party: 'sender', address: alice, reason: 'frozen' }],
    });
  });

  it.each(['requested', 'confirmed', 'failed', 'reversed'])(
    'refuses non-in-flight status %s',
    (s) => {
      expect(() => inFlightComplianceCheck(s as InFlightStatus, transfer, states([]))).toThrow(
        InvalidInputError,
      );
    },
  );
});

describe('compliance actions', () => {
  it('maps each action to its on-chain flag change', () => {
    expect(flagChangeFor('verify')).toEqual({ flag: 'verified', value: true });
    expect(flagChangeFor('unverify')).toEqual({ flag: 'verified', value: false });
    expect(flagChangeFor('freeze')).toEqual({ flag: 'frozen', value: true });
    expect(flagChangeFor('unfreeze')).toEqual({ flag: 'frozen', value: false });
  });

  it('rejects an unknown action, including prototype keys', () => {
    expect(() => flagChangeFor('ban' as ComplianceAction)).toThrow(InvalidInputError);
    expect(() => flagChangeFor('toString' as ComplianceAction)).toThrow(InvalidInputError);
  });

  it('applies an action to a state, changing only its flag', () => {
    expect(applyComplianceAction(UNVERIFIED, 'verify')).toEqual(OK);
    expect(applyComplianceAction(OK, 'freeze')).toEqual(FROZEN);
    expect(applyComplianceAction(FROZEN, 'unfreeze')).toEqual(OK);
    expect(applyComplianceAction(FROZEN, 'unverify')).toEqual({ verified: false, frozen: true });
  });
});

describe('compliance change state machine', () => {
  const S: ComplianceChangeStatus[] = ['requested', 'submitted', 'confirmed', 'failed'];
  const E: ComplianceChangeEvent[] = ['SUBMIT', 'CONFIRM', 'FAIL'];
  const LEGAL: Record<string, ComplianceChangeStatus> = {
    'requested:SUBMIT': 'submitted',
    'submitted:SUBMIT': 'submitted',
    'submitted:CONFIRM': 'confirmed',
    'submitted:FAIL': 'failed',
  };

  it('allows exactly the specified edges', () => {
    for (const s of S) {
      for (const e of E) {
        const expected = LEGAL[`${s}:${e}`];
        if (expected === undefined) {
          expect(() => transitionComplianceChange(s, e)).toThrow(InvalidTransitionError);
        } else {
          expect(transitionComplianceChange(s, e)).toBe(expected);
        }
      }
    }
  });

  it('names the machine in the error', () => {
    expect(() => transitionComplianceChange('confirmed', 'SUBMIT')).toThrow(/compliance_change/);
  });
});
