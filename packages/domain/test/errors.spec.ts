import {
  AmountOverflowError,
  ComplianceRejectedError,
  DomainError,
  FeeCapExceededError,
  InsufficientFundsError,
  InvalidInputError,
  InvalidReferenceError,
  InvalidTransitionError,
  JournalIntegrityError,
  SelfTransferError,
  UnbalancedEntryError,
} from '../src';

describe('DomainError hierarchy', () => {
  it('every subclass is a DomainError and an Error, with its own name and stable code', () => {
    const cases: Array<[DomainError, string, string]> = [
      [new InvalidInputError('x'), 'InvalidInputError', 'INVALID_INPUT'],
      [new AmountOverflowError('x'), 'AmountOverflowError', 'AMOUNT_OVERFLOW'],
      [new UnbalancedEntryError('op', 1n, 2n, 'x'), 'UnbalancedEntryError', 'UNBALANCED_ENTRY'],
      [new InsufficientFundsError(1n, 2n), 'InsufficientFundsError', 'INSUFFICIENT_FUNDS'],
      [new SelfTransferError('x'), 'SelfTransferError', 'SELF_TRANSFER'],
      [new InvalidTransitionError('a', 'B', 'm'), 'InvalidTransitionError', 'INVALID_TRANSITION'],
      [new InvalidReferenceError('x'), 'InvalidReferenceError', 'INVALID_REFERENCE'],
      [new ComplianceRejectedError([]), 'ComplianceRejectedError', 'COMPLIANCE_REJECTED'],
      [new FeeCapExceededError(2n, 1n), 'FeeCapExceededError', 'FEE_CAP_EXCEEDED'],
      [new JournalIntegrityError(null, 'x'), 'JournalIntegrityError', 'JOURNAL_INTEGRITY'],
    ];
    for (const [err, name, code] of cases) {
      expect(err).toBeInstanceOf(DomainError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(name);
      expect(err.code).toBe(code);
    }
  });

  it('carries the data a caller needs', () => {
    const insufficient = new InsufficientFundsError(5n, 9n);
    expect(insufficient.available).toBe(5n);
    expect(insufficient.requested).toBe(9n);
    expect(insufficient.message).toBe('insufficient funds: available 5, requested 9');

    const transition = new InvalidTransitionError('confirmed', 'FAIL', 'operation');
    expect(transition.message).toBe("operation: no transition from 'confirmed' on 'FAIL'");

    const compliance = new ComplianceRejectedError([
      { party: 'sender', address: '0xaa', reason: 'frozen' },
      { party: 'recipient', address: '0xbb', reason: 'unknown' },
    ]);
    expect(compliance.message).toBe(
      'compliance rejected: sender 0xaa (frozen), recipient 0xbb (unknown)',
    );

    const fee = new FeeCapExceededError(11n, 10n);
    expect([fee.required, fee.cap]).toEqual([11n, 10n]);
  });
});
