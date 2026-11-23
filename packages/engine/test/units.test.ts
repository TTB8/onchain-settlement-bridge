/**
 * Pure units: which errors retry a transaction, how domain refusals become engine errors, and the
 * production clock and id source. No database.
 */

import { Prisma } from '@bridge/db';
import {
  InsufficientFundsError as DomainInsufficientFunds,
  InvalidReferenceError,
  InvalidTransitionError,
  SelfTransferError,
} from '@bridge/domain';

import {
  fromDomainError,
  IllegalTransitionError,
  InsufficientFundsError,
  InvalidRequestError,
  isRetryableTransactionError,
  randomIds,
  SelfTransferRequestError,
  systemClock,
} from '../src';

const known = (code: string, message = 'x', meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test', meta });

describe('isRetryableTransactionError', () => {
  it.each([
    ['P2034 (write conflict or deadlock)', known('P2034'), true],
    ['raw query 40001 in meta', known('P2010', 'Raw query failed', { code: '40001' }), true],
    ['raw query 40P01 in meta', known('P2010', 'Raw query failed', { code: '40P01' }), true],
    [
      'raw query 40001 only in the message',
      known('P2010', 'Raw query failed. Code: `40001`. Message: ...'),
      true,
    ],
    [
      'raw query check_violation',
      known('P2010', 'Raw query failed. Code: `23514`.', { code: '23514' }),
      false,
    ],
    ['unique violation', known('P2002', 'Unique', { target: ['ref'] }), false],
    ['a plain Error mentioning 40001', new Error('Code: `40001`'), false],
    ['a string', '40001', false],
  ])('%s -> %s', (_name, err, expected) => {
    expect(isRetryableTransactionError(err)).toBe(expected);
  });
});

describe('fromDomainError', () => {
  it('maps each domain refusal to its engine error, keeping the details', () => {
    const insufficient = fromDomainError(new DomainInsufficientFunds(3n, 5n));
    expect(insufficient).toBeInstanceOf(InsufficientFundsError);
    expect(insufficient).toMatchObject({ available: 3n, requested: 5n });
    expect(fromDomainError(new SelfTransferError('self'))).toBeInstanceOf(SelfTransferRequestError);
    const illegal = fromDomainError(new InvalidTransitionError('confirmed', 'SUBMIT', 'operation'));
    expect(illegal).toBeInstanceOf(IllegalTransitionError);
    expect((illegal as Error).cause).toBeInstanceOf(InvalidTransitionError);
    expect(fromDomainError(new InvalidReferenceError('bad'))).toBeInstanceOf(InvalidRequestError);
  });

  it('returns anything that is not a domain error unchanged', () => {
    const e = new Error('db down');
    expect(fromDomainError(e)).toBe(e);
    expect(fromDomainError('text')).toBe('text');
  });
});

describe('production ports', () => {
  it('systemClock returns a fresh, current Date', () => {
    const a = systemClock.now();
    const b = systemClock.now();
    expect(a).not.toBe(b);
    expect(Math.abs(a.getTime() - Date.now())).toBeLessThan(5_000);
  });

  it('randomIds returns distinct lowercase v4 UUIDs', () => {
    const ids = new Set(Array.from({ length: 50 }, () => randomIds.uuid()));
    expect(ids.size).toBe(50);
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
