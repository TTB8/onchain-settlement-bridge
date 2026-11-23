/**
 * Unit tests for the API's pure parts: problem mapping, amounts, idempotency keys, auth (token
 * matching, the access decision, constant-time comparison), the logger and alarm sink, the
 * read-only gateway, run status reporting, balances, cursors and validation error flattening.
 */

import * as crypto from 'node:crypto';

// timingSafeEqual is a non-configurable export: wrap it so the tests can see every call.
jest.mock('node:crypto', () => {
  const actual = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, timingSafeEqual: jest.fn(actual.timingSafeEqual) };
});
const timingSafe = crypto.timingSafeEqual as unknown as jest.Mock;

import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  PayloadTooLargeException,
  UnauthorizedException,
} from '@nestjs/common';
import { FakeChainGateway } from '@bridge/chain';
import {
  ComplianceIdempotencyConflictError,
  DeploymentMismatchError,
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidRequestError,
  LeaseLostError,
  NoActiveDeploymentError,
  OperationNotFoundError,
  RetriesExhaustedError,
  SelfTransferRequestError,
  UnknownUserError,
  type ReconciliationRunRecord,
} from '@bridge/engine';
import { loadApiConfig } from '@bridge/engine/env';
import type { ValidationError } from 'class-validator';

import { reportedStatus, toRunView } from '../src/admin/reconciliations';
import { fieldErrors } from '../src/app';
import { bearerToken, constantTimeEqual, decideAccess, TokenMatcher } from '../src/auth/auth';
import { balancesView } from '../src/balances/balances';
import {
  buildReadOnlyGateway,
  ReadOnlyChainGateway,
  ReadOnlyGatewayError,
  refusingAccount,
} from '../src/chain/read-only-gateway';
import { AMOUNT_PATTERN, formatAmount, parseAmount } from '../src/core/amount';
import { parseIdempotencyKey } from '../src/core/idempotency-key';
import { JsonLogger, LoggingAlarmSink } from '../src/core/logger';
import { parseLimit } from '../src/core/params';
import {
  ApiProblem,
  PROBLEMS,
  type ProblemCode,
  problemBody,
  toProblem,
} from '../src/core/problem';
import { decodeCursor, encodeCursor } from '../src/operations/operations';
import { ADMIN, PLATFORM, testEnv } from './support/rig';

describe('toProblem', () => {
  const cases: [string, unknown, number, ProblemCode][] = [
    ['InvalidRequestError', new InvalidRequestError('x'), 400, 'VALIDATION_FAILED'],
    ['InsufficientFundsError', new InsufficientFundsError(1n, 2n), 422, 'INSUFFICIENT_FUNDS'],
    ['SelfTransferRequestError', new SelfTransferRequestError('x'), 400, 'SELF_TRANSFER'],
    ['UnknownUserError', new UnknownUserError('no user 0xabc'), 404, 'USER_NOT_FOUND'],
    ['NoActiveDeploymentError', new NoActiveDeploymentError('x'), 503, 'NO_ACTIVE_DEPLOYMENT'],
    ['DeploymentMismatchError', new DeploymentMismatchError('x'), 503, 'DEPLOYMENT_MISMATCH'],
    ['IdempotencyConflictError', new IdempotencyConflictError('op-1'), 409, 'IDEMPOTENCY_CONFLICT'],
    ['OperationNotFoundError', new OperationNotFoundError('x'), 404, 'OPERATION_NOT_FOUND'],
    ['RetriesExhaustedError', new RetriesExhaustedError(3, new Error('40001')), 503, 'BUSY'],
    ['an engine error with no API meaning', new LeaseLostError('x'), 500, 'INTERNAL'],
    ['BadRequestException', new BadRequestException('x'), 400, 'VALIDATION_FAILED'],
    ['UnauthorizedException', new UnauthorizedException(), 401, 'UNAUTHENTICATED'],
    ['ForbiddenException', new ForbiddenException(), 403, 'FORBIDDEN'],
    ['NotFoundException', new NotFoundException(), 404, 'NOT_FOUND'],
    ['PayloadTooLargeException', new PayloadTooLargeException(), 413, 'PAYLOAD_TOO_LARGE'],
    ['an HttpException with another status', new HttpException('teapot', 418), 500, 'INTERNAL'],
    [
      'body-parser parse failure',
      { type: 'entity.parse.failed', status: 400 },
      400,
      'MALFORMED_JSON',
    ],
    ['body-parser too large', { type: 'entity.too.large', status: 413 }, 413, 'PAYLOAD_TOO_LARGE'],
    [
      'body-parser charset',
      { type: 'charset.unsupported', status: 415 },
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    ],
    [
      'body-parser encoding',
      { type: 'encoding.unsupported', status: 415 },
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    ],
    ['body-parser aborted', { type: 'request.aborted', status: 400 }, 400, 'BAD_REQUEST_BODY'],
    [
      'body-parser size',
      { type: 'request.size.invalid', statusCode: 400 },
      400,
      'BAD_REQUEST_BODY',
    ],
    ['body-parser 5xx', { type: 'stream.encoding.set', status: 500 }, 500, 'INTERNAL'],
    ['a typed error with no status', { type: 'entity.parse.failed' }, 500, 'INTERNAL'],
    ['a plain Error', new Error('SELECT * FROM app_user'), 500, 'INTERNAL'],
    ['a string', 'boom', 500, 'INTERNAL'],
    ['null', null, 500, 'INTERNAL'],
  ];

  it.each(cases)('%s -> %d %s', (_name, err, status, code) => {
    const mapped = toProblem(err, 'req-1');
    expect(mapped.body.status).toBe(status);
    expect(mapped.body.code).toBe(code);
    expect(mapped.body.type).toBe(`urn:bridge:problem:${code.toLowerCase().replace(/_/g, '-')}`);
    expect(mapped.body.title).toBe(PROBLEMS[code].title);
    expect(mapped.body.detail).toBe(PROBLEMS[code].detail);
    expect(mapped.body.instance).toBe('urn:request:req-1');
    expect(mapped.unexpected).toBe(code === 'INTERNAL');
  });

  it('never carries the error message, only the fixed detail', () => {
    for (const err of [
      new UnknownUserError('no user has wallet 0xdeadbeef'),
      new InsufficientFundsError(123n, 456n),
      new Error('password=hunter2 at postgresql://u:p@h/db'),
    ]) {
      const text = JSON.stringify(toProblem(err).body);
      expect(text).not.toMatch(/deadbeef|123|456|hunter2|postgresql/);
    }
  });

  it('an idempotency conflict names only the caller own operation / change', () => {
    expect(toProblem(new IdempotencyConflictError('op-1')).body.existingOperationId).toBe('op-1');
    expect(
      toProblem(new ComplianceIdempotencyConflictError('c-1')).body.existingComplianceChangeId,
    ).toBe('c-1');
    const odd = Object.assign(new InsufficientFundsError(1n, 2n), { existingOperationId: 'x' });
    expect(toProblem(odd).body.existingOperationId).toBeUndefined();
  });

  it('503s carry Retry-After, 401 carries WWW-Authenticate, others neither', () => {
    expect(toProblem(new NoActiveDeploymentError('x')).headers).toEqual({ 'Retry-After': '5' });
    expect(toProblem(new DeploymentMismatchError('x')).headers).toEqual({ 'Retry-After': '30' });
    expect(toProblem(new RetriesExhaustedError(1, null)).headers).toEqual({ 'Retry-After': '1' });
    expect(toProblem(new ApiProblem('UNAUTHENTICATED')).headers).toEqual({
      'WWW-Authenticate': 'Bearer',
    });
    expect(toProblem(new ApiProblem('FORBIDDEN')).headers).toEqual({});
    expect(toProblem(new Error('x')).headers).toEqual({});
  });

  it('extensions cannot overwrite the fixed fields', () => {
    const body = problemBody('FORBIDDEN', undefined, {
      type: 'x',
      status: 200,
      code: 'OK',
      detail: 'y',
    });
    expect(body).toMatchObject({
      type: 'urn:bridge:problem:forbidden',
      status: 403,
      code: 'FORBIDDEN',
    });
    expect(body.detail).toBe(PROBLEMS.FORBIDDEN.detail);
    expect(body.instance).toBeUndefined();
  });

  it('every catalog entry has a 4xx/5xx status, and 503s a Retry-After', () => {
    for (const [code, spec] of Object.entries(PROBLEMS)) {
      expect(spec.status).toBeGreaterThanOrEqual(400);
      if (spec.status === 503)
        expect({ code, retry: spec.retryAfterSeconds }).toEqual({
          code,
          retry: expect.any(Number),
        });
    }
  });
});

describe('parseAmount', () => {
  it.each(['1', '9', '10', '1500000', '1000000000000'])('accepts %s', (v) => {
    expect(parseAmount(v, 10n ** 12n)).toBe(BigInt(v));
  });

  it.each([
    1,
    1.5,
    -1,
    0,
    1e6,
    Number.MAX_SAFE_INTEGER,
    '0',
    '00',
    '01',
    '-1',
    '+1',
    '1.0',
    '1.5',
    '1e6',
    '0x1',
    ' 1',
    '1 ',
    '',
    '１',
    null,
    undefined,
    true,
    ['1'],
    { v: '1' },
    1n,
    '1'.repeat(20),
  ])('refuses %p as VALIDATION_FAILED', (v) => {
    expect(() => parseAmount(v, 10n ** 30n)).toThrow(ApiProblem);
    try {
      parseAmount(v, 10n ** 30n);
    } catch (err) {
      expect((err as ApiProblem).code).toBe('VALIDATION_FAILED');
      expect((err as ApiProblem).extensions.errors).toEqual([
        { field: 'amount', message: expect.any(String) },
      ]);
    }
  });

  it('refuses above the cap as AMOUNT_ABOVE_LIMIT and accepts the cap itself', () => {
    expect(parseAmount('100', 100n)).toBe(100n);
    try {
      parseAmount('101', 100n);
      throw new Error('accepted');
    } catch (err) {
      expect((err as ApiProblem).code).toBe('AMOUNT_ABOVE_LIMIT');
      expect((err as ApiProblem).extensions).toEqual({ limit: '100' });
    }
  });

  it('the pattern allows at most 19 digits and formats back identically', () => {
    expect(AMOUNT_PATTERN.test('9'.repeat(19))).toBe(true);
    expect(AMOUNT_PATTERN.test('9'.repeat(20))).toBe(false);
    expect(formatAmount(1_500_000n)).toBe('1500000');
  });
});

describe('parseIdempotencyKey / parseLimit', () => {
  it('requires a key and validates its spelling', () => {
    const code = (v: string | string[] | undefined) => {
      try {
        parseIdempotencyKey(v);
        return 'ok';
      } catch (err) {
        return (err as ApiProblem).code;
      }
    };
    expect(code(undefined)).toBe('IDEMPOTENCY_KEY_MISSING');
    expect(code('')).toBe('IDEMPOTENCY_KEY_MISSING');
    expect(code(['a', 'b'])).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(code('a b')).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(code('ü')).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(code('k'.repeat(256))).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(code('k'.repeat(255))).toBe('ok');
    expect(parseIdempotencyKey('deposit-1')).toBe('deposit-1');
  });

  it('parses limits', () => {
    expect(parseLimit(undefined, 20, 100)).toBe(20);
    expect(parseLimit('100', 20, 100)).toBe(100);
    for (const bad of ['0', '101', '-1', '1.5', 'x', ['1'], '00001']) {
      expect(() => parseLimit(bad, 20, 100)).toThrow(ApiProblem);
    }
  });
});

describe('auth', () => {
  it('constantTimeEqual compares by content, any lengths, through timingSafeEqual', () => {
    const spy = timingSafe;
    spy.mockClear();
    try {
      expect(constantTimeEqual('abc', 'abc')).toBe(true);
      expect(constantTimeEqual('abc', 'abd')).toBe(false);
      expect(constantTimeEqual('abc', 'abcd')).toBe(false); // different lengths never throw
      expect(constantTimeEqual('', 'x'.repeat(10_000))).toBe(false);
      expect(spy).toHaveBeenCalledTimes(4);
      // Always fixed 32-byte digests, so the comparison time never depends on the input length.
      for (const [a, b] of spy.mock.calls) {
        expect([(a as Buffer).length, (b as Buffer).length]).toEqual([32, 32]);
      }
    } finally {
      spy.mockClear();
    }
  });

  it('bearerToken accepts only "Bearer <visible ASCII>"', () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('')).toBeNull();
    expect(bearerToken('Bearer')).toBeNull();
    expect(bearerToken('Bearer ')).toBeNull();
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
    expect(bearerToken(`Bearer ${'x'.repeat(513)}`)).toBeNull();
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('  Bearer abc  ')).toBe('abc');
  });

  it('TokenMatcher always runs BOTH comparisons, whatever matches', () => {
    const calls: string[] = [];
    const equal = (a: string, b: string) => {
      calls.push(b);
      return a === b;
    };
    const m = new TokenMatcher('P', 'A', equal);
    for (const [token, expected] of [
      ['P', 'platform'],
      ['A', 'admin'],
      ['x', 'none'],
    ] as const) {
      calls.length = 0;
      expect(m.match(token)).toBe(expected);
      expect(calls).toEqual(['P', 'A']);
    }
    calls.length = 0;
    expect(m.match(null)).toBe('none');
    expect(calls).toEqual([]);
  });

  it('TokenMatcher defaults to the constant-time comparison', () => {
    const spy = timingSafe;
    spy.mockClear();
    try {
      expect(new TokenMatcher(PLATFORM, ADMIN).match(PLATFORM)).toBe('platform');
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockClear();
    }
  });

  it('decideAccess: deny by default, 401 without a credential, 403 for the other scope', () => {
    expect(decideAccess(undefined, 'platform')).toBe('FORBIDDEN');
    expect(decideAccess(undefined, 'admin')).toBe('FORBIDDEN');
    expect(decideAccess(undefined, 'none')).toBe('FORBIDDEN');
    expect(decideAccess('public', 'none')).toBe('allow');
    expect(decideAccess('platform', 'none')).toBe('UNAUTHENTICATED');
    expect(decideAccess('admin', 'none')).toBe('UNAUTHENTICATED');
    expect(decideAccess('platform', 'platform')).toBe('allow');
    expect(decideAccess('admin', 'admin')).toBe('allow');
    expect(decideAccess('platform', 'admin')).toBe('FORBIDDEN');
    expect(decideAccess('admin', 'platform')).toBe('FORBIDDEN');
  });
});

describe('JsonLogger and LoggingAlarmSink', () => {
  const at = () => new Date(Date.UTC(2026, 10, 23));

  it('writes one redacted JSON line per message, filtered by level', () => {
    const lines: string[] = [];
    const log = new JsonLogger({
      level: 'warn',
      secrets: ['s3cr3t-value'],
      service: 't',
      write: (l) => lines.push(l),
      clock: at,
    });
    log.log('hidden');
    log.debug('hidden');
    log.verbose('hidden');
    log.warn('token s3cr3t-value at https://rpc.example.com/key', 'Ctx');
    log.error('failed', 'stack line 1\n at secretFrame', 'Ctx2');
    log.emit('warn', 'fields', { a: 'https://x.example.com/k', b: 1, c: true, d: null });
    expect(lines).toHaveLength(3);
    const [w, e, f] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(w).toEqual({
      time: '2026-11-23T00:00:00.000Z',
      level: 'warn',
      service: 't',
      msg: 'token <redacted> at <redacted-url>',
      context: 'Ctx',
    });
    expect(e).toEqual({
      time: '2026-11-23T00:00:00.000Z',
      level: 'error',
      service: 't',
      msg: 'failed',
      context: 'Ctx2',
    });
    expect(lines[1]).not.toContain('secretFrame');
    expect(f).toMatchObject({ a: '<redacted-url>', b: 1, c: true, d: null });
  });

  it('debug level writes everything; a non-string context is ignored', () => {
    const lines: string[] = [];
    const log = new JsonLogger({
      level: 'debug',
      secrets: [],
      service: 't',
      write: (l) => lines.push(l),
    });
    log.log('a', { not: 'a string' });
    log.debug('b');
    log.verbose('c');
    expect(lines.map((l) => JSON.parse(l).msg)).toEqual(['a', 'b', 'c']);
    expect(JSON.parse(lines[0] ?? '{}').context).toBeUndefined();
  });

  it('the alarm sink logs each alarm and never throws', () => {
    const lines: string[] = [];
    const log = new JsonLogger({
      level: 'log',
      secrets: ['k3y-secret'],
      service: 't',
      write: (l) => lines.push(l),
      clock: at,
    });
    const sink = new LoggingAlarmSink(log);
    sink.raise({ kind: 'escalation', detail: 'k3y-secret leaked', operationId: 'op', at: at() });
    sink.raise({ kind: 'head_stalled', detail: 'x', at: at() });
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      level: 'warn',
      msg: 'alarm',
      kind: 'escalation',
      detail: '<redacted> leaked',
      operationId: 'op',
      complianceChangeId: null,
      reconciliationRunId: null,
    });
    const broken = new LoggingAlarmSink(
      new JsonLogger({
        level: 'log',
        secrets: [],
        service: 't',
        write: () => {
          throw new Error('EPIPE');
        },
      }),
    );
    expect(() => broken.raise({ kind: 'escalation', detail: 'x', at: at() })).not.toThrow();
  });
});

describe('ReadOnlyChainGateway', () => {
  it('delegates every read and refuses every signing or sending method', async () => {
    const fake = new FakeChainGateway({ chainId: 31337 });
    const ro = new ReadOnlyChainGateway(fake);
    expect(await ro.getChainId()).toBe(31337);
    expect(await ro.getHeadBlock()).toBe(0n);
    expect(await ro.getBlock(0n)).toEqual(await fake.getBlock(0n));
    expect(ro.deployment()).toEqual(fake.deployment());
    expect(await ro.getNonce('settlement')).toEqual(await fake.getNonce('settlement'));
    expect(await ro.estimateFees()).toEqual(await fake.estimateFees());
    const hash = `0x${'11'.repeat(32)}` as const;
    expect(await ro.getReceipt(hash)).toBeNull();
    expect(await ro.getTransaction(hash)).toBeNull();
    expect(await ro.getEvents({ fromBlock: 0n, toBlock: 0n })).toEqual([]);
    const holder = `0x${'22'.repeat(20)}` as const;
    expect(await ro.readBalance(holder)).toBe(0n);
    expect(await ro.readTotalSupply()).toBe(0n);
    expect(await ro.readReferenceUsed('token', hash)).toBe(false);
    expect(await ro.readCompliance(holder)).toEqual(await fake.readCompliance(holder));
    const req = {
      signer: 'settlement' as const,
      call: { kind: 'mint' as const, to: holder, amount: 1n, ref: hash },
      nonce: 0,
      fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
    };
    await expect(ro.submit(req)).rejects.toThrow(ReadOnlyGatewayError);
    await expect(ro.signTransaction(req)).rejects.toThrow(ReadOnlyGatewayError);
    await expect(ro.sendRaw('0x00')).rejects.toThrow(ReadOnlyGatewayError);
    expect(() => ro.signerAddress('settlement')).toThrow(ReadOnlyGatewayError);
    expect(fake.mempoolSize()).toBe(0);
  });

  it('the placeholder account refuses to sign anything', async () => {
    const account = refusingAccount('settlement');
    expect(account.address).toBe('0x0000000000000000000000000000000000000000');
    await expect(account.signMessage({ message: 'x' })).rejects.toThrow(ReadOnlyGatewayError);
    await expect(account.signTransaction({ chainId: 1, type: 'eip1559' })).rejects.toThrow(
      ReadOnlyGatewayError,
    );
    await expect(
      account.signTypedData({ domain: {}, types: {}, primaryType: 'EIP712Domain' }),
    ).rejects.toThrow(ReadOnlyGatewayError);
  });

  it('the production builder makes a keyless viem gateway bound to the configured deployment', () => {
    const chain = new FakeChainGateway({ chainId: 31337 });
    const config = loadApiConfig(testEnv(chain, 'postgresql://u:p@localhost:5434/x'));
    const gw = buildReadOnlyGateway(config.chain);
    expect(gw).toBeInstanceOf(ReadOnlyChainGateway);
    expect(gw.deployment()).toEqual({
      chainId: 31337,
      token: chain.tokenAddress,
      registry: chain.registryAddress,
    });
    expect(() => gw.signerAddress('compliance')).toThrow(ReadOnlyGatewayError);
  });
});

describe('reconciliation views', () => {
  const run = (status: string, mismatchCount = 0): ReconciliationRunRecord =>
    ({
      id: 'r',
      deploymentId: 'd',
      status,
      atBlock: 5n,
      finalBlock: 5n,
      headBlock: 5n,
      error: null,
      mismatchCount,
      summary: {},
      startedAt: new Date(0),
      finishedAt: null,
      mismatches: [],
    }) as unknown as ReconciliationRunRecord;

  it('only exactly ok / mismatch pass through; anything else is unknown', () => {
    expect(reportedStatus('ok')).toBe('ok');
    expect(reportedStatus('mismatch')).toBe('mismatch');
    for (const s of ['unknown', 'OK', '', 'running', 'ok '])
      expect(reportedStatus(s)).toBe('unknown');
  });

  it('clean is true only for ok with zero mismatches; unknown is never clean', () => {
    expect(toRunView(run('ok')).clean).toBe(true);
    expect(toRunView(run('ok', 1)).clean).toBe(false);
    expect(toRunView(run('mismatch', 2)).clean).toBe(false);
    expect(toRunView(run('unknown')).clean).toBe(false);
    expect(toRunView(run('unknown')).status).toBe('unknown');
    const v = toRunView({ ...run('ok'), atBlock: null, finishedAt: new Date(1000) });
    expect([v.atBlock, v.finalBlock, v.finishedAt]).toEqual([
      null,
      '5',
      '1970-01-01T00:00:01.000Z',
    ]);
  });
});

describe('balancesView', () => {
  it('expectedOnChain is available + held (incoming is not on chain yet)', () => {
    expect(balancesView('u', { available: 7n, held: 3n, incoming: 100n })).toEqual({
      userId: 'u',
      available: '7',
      held: '3',
      incoming: '100',
      expectedOnChain: '10',
      decimals: 6,
    });
  });
});

describe('cursors and validation errors', () => {
  it('round-trips a cursor and refuses anything else', () => {
    const c = { t: new Date(Date.UTC(2026, 0, 1)), id: '7d0b6f0e-2f8e-4a51-9a8c-7a3b3b9a1c11' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    for (const bad of [
      undefined,
      ['x'],
      '',
      '!!',
      b64('no-separator'),
      b64(`2026-01-01T00:00:00.000Z|${c.id}|extra`),
      b64('not-a-date|7d0b6f0e-2f8e-4a51-9a8c-7a3b3b9a1c11'),
      b64('2026-01-01T00:00:00.000Z|not-a-uuid'),
    ]) {
      expect(() => decodeCursor(bad)).toThrow(ApiProblem);
    }
  });

  it('flattens nested validation errors, keeping constraint messages only', () => {
    const errors = [
      { property: 'a', constraints: { isString: 'a must be a string' }, children: [] },
      {
        property: 'b',
        children: [{ property: 'c', constraints: { x: 'c is bad' }, children: [] }],
      },
      { property: 'd' },
    ] as unknown as ValidationError[];
    expect(fieldErrors(errors)).toEqual([
      { field: 'a', message: 'a must be a string' },
      { field: 'b.c', message: 'c is bad' },
    ]);
  });
});
