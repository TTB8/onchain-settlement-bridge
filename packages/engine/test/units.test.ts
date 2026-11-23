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
  describeError,
  isRetryableTransactionError,
  randomIds,
  sanitizeText,
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

describe('sanitizeText / describeError', () => {
  it.each([
    ['https://mainnet.example.io/v3/KEY', '<redacted-url>'],
    ['ws=wss://node.example:8546/KEY rest', 'ws=<redacted-url> rest'],
    ['{"url":"https:\\/\\/node.example\\/KEY"}', '{"url":"<redacted-url>"}'],
    ['GET https%3A%2F%2Fnode.example%2FKEY now', 'GET <redacted-url> now'],
    ['line1\nline2\ttab\u0000nul', 'line1 line2 tab nul'],
    ['   ', '(no message)'],
  ])('%j -> %j', (input, expected) => {
    expect(sanitizeText(input)).toBe(expected);
  });

  it('cuts to the limit, marking the cut', () => {
    const out = sanitizeText('a'.repeat(5000));
    expect(out).toHaveLength(1000);
    expect(out.endsWith('...')).toBe(true);
    expect(sanitizeText('abcdef', { max: 5 })).toBe('ab...');
    expect(sanitizeText('abcde', { max: 5 })).toBe('abcde');
  });

  it('describes errors by class and non-errors by type', () => {
    class RpcError extends Error {
      override name = 'RpcError';
    }
    expect(describeError(new RpcError('at http://x.example/k'))).toBe(
      'RpcError: at <redacted-url>',
    );
    expect(describeError('plain')).toBe('string: plain');
    expect(describeError(42)).toBe('number: 42');
    const evil = {
      toString() {
        throw new Error('no');
      },
    };
    expect(describeError(evil)).toBe('object: (unprintable)');
  });
});

describe('sanitizeText: forms that leaked before (review L-C)', () => {
  const KEY = 'SECRETKEY1';
  const URL = `https://node.example.org/v2/${KEY}`;
  const slashEscaped = URL.replace(/\//g, '\\/');

  it.each([
    ['doubly JSON-escaped URL', JSON.stringify(JSON.stringify({ u: slashEscaped }))],
    ['triply backslash-escaped separator', `at https:\\\\\\/\\\\\\/node.example.org/v2/${KEY}`],
    ['double percent-encoded URL', `GET ${encodeURIComponent(encodeURIComponent(URL))}`],
    ['scheme-less host/path', `nonce too high at eth.g.alchemy.com/v2/${KEY}`],
    ['scheme-less host:port/path', `connect node.example.org:8545/${KEY} refused`],
    ['IPv4 host/path', `dial 10.0.0.7:8545/${KEY}`],
    ['host with an escaped slash', `at node.example.org\\/v2\\/${KEY}`],
    ['host with an encoded slash', `at node.example.org%2Fv2%2F${KEY}`],
  ])('%s', (_name, raw) => {
    expect(raw).toContain(KEY); // non-vacuous: the secret is in the input
    const out = sanitizeText(raw);
    expect(out).not.toContain(KEY);
    expect(out).toContain('<redacted-url>');
  });

  it('a bare key is only caught by value, in every spelling', () => {
    const rpc = `https://user:${KEY}pw@node.example.org/v3/${KEY}?apikey=${KEY}Q`;
    const forms = [
      `api key ${KEY} rejected`,
      `api key ${KEY.toLowerCase()} rejected`,
      `path /v3/${KEY} rejected`,
      `query apikey=${KEY}Q rejected`,
      `escaped ${JSON.stringify(JSON.stringify(`/v3/${KEY}`))}`,
      `encoded ${encodeURIComponent(encodeURIComponent(`/v3/${KEY}`))}`,
      `password ${KEY}pw rejected`,
    ];
    for (const raw of forms) {
      expect(raw.toUpperCase()).toContain(KEY);
      expect(sanitizeText(raw, { secrets: [rpc] }).toUpperCase()).not.toContain(KEY);
    }
    // Without the literal, the generic patterns cannot know a bare key is one.
    expect(sanitizeText(`api key ${KEY} rejected`)).toContain(KEY);
  });

  it('ignores secret pieces too short to be secrets and non-URL secrets work as literals', () => {
    expect(sanitizeText('a b c', { secrets: ['a', 'b'] })).toBe('a b c');
    expect(sanitizeText(`token ${KEY} bad`, { secrets: [KEY] })).toBe('token <redacted> bad');
    expect(sanitizeText(`token ${KEY} bad`, { secrets: [] })).toBe(`token ${KEY} bad`);
  });

  it('leaves ordinary error text alone', () => {
    for (const text of [
      'insufficient funds for gas * price + value',
      'nonce too low: next nonce 7, tx nonce 5',
      'version 1.2.3 is not supported',
      'packages/engine/src/redact.ts line 3',
    ]) {
      expect(sanitizeText(text)).toBe(text);
    }
  });

  it('describeError applies the literal secrets too', () => {
    expect(describeError(new Error(`bad key ${KEY}`), { secrets: [KEY] })).toBe(
      'Error: bad key <redacted>',
    );
  });
});
