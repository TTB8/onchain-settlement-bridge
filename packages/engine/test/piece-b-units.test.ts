/**
 * Units for piece B without a database: the outbox call codec, the broadcast classifier (ADR
 * 0009), `ResigningSigner`'s hash check, the alarm log, constructor validation, and the
 * `BridgeEngine` loop driven by fake timers (no timer inside the logic itself).
 */

import {
  AlreadyKnownError,
  ChainUnavailableError,
  FakeChainGateway,
  InsufficientFundsError,
  NonceTooLowError,
  ReplacementUnderpricedError,
  SubmissionRejectedError,
  type SubmitRequest,
} from '@bridge/chain';
import type { PrismaClient } from '@bridge/db';

import {
  AlarmLog,
  BridgeEngine,
  classifyBroadcastError,
  contractCallFromJson,
  InvalidRequestError,
  ResigningSigner,
  SignedHashMismatchError,
  type TickSummary,
  TxMonitor,
} from '../src';
import { configFor, fakeSign } from './support/bridge';
import { FakeClock, RecordingIds } from './support/fixtures';

const A: `0x${string}` = `0x${'a'.repeat(40)}`;
const B: `0x${string}` = `0x${'b'.repeat(40)}`;
const REF: `0x${string}` = `0x${'0'.repeat(32)}${'1'.repeat(32)}`;

describe('contractCallFromJson', () => {
  it('decodes every call kind, with bigint amounts', () => {
    expect(contractCallFromJson({ kind: 'mint', to: A, amount: '5', ref: REF })).toEqual({
      kind: 'mint',
      to: A,
      amount: 5n,
      ref: REF,
    });
    expect(contractCallFromJson({ kind: 'burn', from: A, amount: '6', ref: REF })).toEqual({
      kind: 'burn',
      from: A,
      amount: 6n,
      ref: REF,
    });
    expect(
      contractCallFromJson({ kind: 'settleTransfer', from: A, to: B, amount: '7', ref: REF }),
    ).toEqual({ kind: 'settleTransfer', from: A, to: B, amount: 7n, ref: REF });
    expect(
      contractCallFromJson({ kind: 'setVerified', account: A, verified: true, ref: REF }),
    ).toEqual({ kind: 'setVerified', account: A, verified: true, ref: REF });
    expect(
      contractCallFromJson({ kind: 'setFrozen', account: A, frozen: false, ref: REF }),
    ).toEqual({ kind: 'setFrozen', account: A, frozen: false, ref: REF });
  });

  it.each([
    ['not an object', 'mint'],
    ['an array', []],
    ['null', null],
    ['a bad ref', { kind: 'mint', to: A, amount: '1', ref: '0x12' }],
    ['an uppercase address', { kind: 'mint', to: A.toUpperCase(), amount: '1', ref: REF }],
    ['a numeric amount', { kind: 'mint', to: A, amount: 1, ref: REF }],
    ['a zero amount', { kind: 'mint', to: A, amount: '0', ref: REF }],
    ['a non-boolean flag', { kind: 'setFrozen', account: A, frozen: 'yes', ref: REF }],
    ['an unknown kind', { kind: 'approve', to: A, amount: '1', ref: REF }],
  ])('refuses %s', (_label, json) => {
    expect(() => contractCallFromJson(json)).toThrow(InvalidRequestError);
  });
});

describe('classifyBroadcastError (ADR 0009: only definite answers are not unknown)', () => {
  it.each([
    [new AlreadyKnownError('known'), 'sent'],
    [new NonceTooLowError('low'), 'nonce_used'],
    [new SubmissionRejectedError('refused'), 'rejected'],
    [new ReplacementUnderpricedError('under'), 'rejected'],
    [new InsufficientFundsError('gas'), 'rejected'],
    [new ChainUnavailableError('timeout'), 'unknown'],
    [new SignedHashMismatchError('drift'), 'unknown'],
    [new Error('anything else'), 'unknown'],
    ['a string', 'unknown'],
  ])('%p is %s', (err, kind) => {
    expect(classifyBroadcastError(err).kind).toBe(kind);
  });
});

describe('ResigningSigner', () => {
  const chain = new FakeChainGateway({ automine: false });
  const signer = new ResigningSigner(chain, fakeSign(chain.chainId));
  const request = (nonce: number): SubmitRequest => ({
    signer: 'settlement',
    call: { kind: 'mint', to: A, amount: 1n, ref: REF },
    nonce,
    fees: { maxFeePerGas: 10n ** 10n, maxPriorityFeePerGas: 10n ** 9n },
  });

  it('broadcasts and returns the recorded hash; "already known" for it is a send', async () => {
    const signed = await signer.sign(request(0));
    expect(await signer.broadcast(signed, request(0))).toBe(signed.hash);
    expect(await signer.broadcast(signed, request(0))).toBe(signed.hash);
    chain.failNextSubmit(new AlreadyKnownError('known'));
    expect(await signer.broadcast(signed, request(0))).toBe(signed.hash);
  });

  it('refuses to call a different hash a success', async () => {
    const signed = await signer.sign(request(1));
    await expect(
      signer.broadcast({ ...signed, hash: `0x${'9'.repeat(64)}` }, request(1)),
    ).rejects.toBeInstanceOf(SignedHashMismatchError);
    chain.failNextSubmit(new AlreadyKnownError('known', `0x${'8'.repeat(64)}`));
    await expect(signer.broadcast(signed, request(1))).rejects.toBeInstanceOf(
      SignedHashMismatchError,
    );
    chain.failNextSubmit(new ChainUnavailableError('down'));
    await expect(signer.broadcast(signed, request(1))).rejects.toBeInstanceOf(
      ChainUnavailableError,
    );
  });
});

describe('AlarmLog', () => {
  it('keeps the newest alarms up to its limit, filterable by kind', () => {
    const log = new AlarmLog(2);
    const at = new Date(0);
    log.raise({ kind: 'head_stalled', detail: '1', at });
    log.raise({ kind: 'escalation', detail: '2', at, operationId: 'x' });
    log.raise({ kind: 'escalation', detail: '3', at });
    expect(log.all.map((a) => a.detail)).toEqual(['2', '3']);
    expect(log.ofKind('escalation')).toHaveLength(2);
    expect(log.ofKind('head_stalled')).toHaveLength(0);
  });
});

const prismaStub = {} as PrismaClient;

function engineFor(extra: Parameters<typeof configFor>[1] = {}): BridgeEngine {
  const chain = new FakeChainGateway();
  return new BridgeEngine(
    {
      prisma: prismaStub,
      gateway: chain,
      signer: new ResigningSigner(chain, fakeSign(chain.chainId)),
      clock: new FakeClock(),
      ids: new RecordingIds(),
    },
    configFor(chain, extra),
  );
}

describe('BridgeEngine construction and loop', () => {
  it('refuses a depth < 1 and a missing or non-positive fee cap', () => {
    expect(() => engineFor({ confirmationDepth: 0 })).toThrow(InvalidRequestError);
    expect(() => engineFor({ feeCap: 0n })).toThrow(InvalidRequestError);
  });

  it('the monitor refuses a depth or stall threshold < 1', () => {
    const chain = new FakeChainGateway();
    const base = {
      prisma: prismaStub,
      gateway: chain,
      signer: new ResigningSigner(chain, fakeSign(chain.chainId)),
      clock: new FakeClock(),
      binding: { chainId: 1n, tokenAddress: chain.tokenAddress },
      alarms: new AlarmLog(),
    };
    const policy = {
      confirmationDepth: 1,
      stuckAfterSeconds: 1,
      maxBumps: 1,
      maxResubmits: 1,
      bumpFeeBps: 1250,
      feeCap: 1n,
      initialFeeMarginBps: 0,
      headStallTicks: 1,
      dropRetrySeconds: 1,
      giveUpAfterSeconds: 1,
      failedAlarmAfterSeconds: 1,
      orphanAfterSeconds: 1,
    };
    expect(() => new TxMonitor({ ...base, policy: { ...policy, confirmationDepth: 0 } })).toThrow(
      RangeError,
    );
    expect(() => new TxMonitor({ ...base, policy: { ...policy, headStallTicks: 0 } })).toThrow(
      RangeError,
    );
  });

  describe('start() / stop() with fake timers', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const summary = {} as TickSummary;

    it('ticks every pollIntervalMs, never overlapping, and stops', async () => {
      const engine = engineFor({ pollIntervalMs: 1_000, batchSize: 3, lockTimeoutMs: 30_000 });
      let running = 0;
      let maxRunning = 0;
      const tick = jest.spyOn(engine, 'tick').mockImplementation(async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 1_500));
        running -= 1;
        return summary;
      });
      engine.start();
      engine.start(); // idempotent
      await jest.advanceTimersByTimeAsync(0);
      expect(tick).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1_500 + 1_000);
      expect(tick).toHaveBeenCalledTimes(2);
      const stopping = engine.stop();
      await jest.advanceTimersByTimeAsync(5_000);
      await stopping;
      expect(tick).toHaveBeenCalledTimes(2);
      expect(maxRunning).toBe(1);
    });

    it('a failing tick raises an alarm and the loop carries on', async () => {
      const alarms = new AlarmLog();
      const chain = new FakeChainGateway();
      const engine = new BridgeEngine(
        {
          prisma: prismaStub,
          gateway: chain,
          signer: new ResigningSigner(chain, fakeSign(chain.chainId)),
          clock: new FakeClock(),
          ids: new RecordingIds(),
          alarms,
        },
        configFor(chain, { pollIntervalMs: 100 }),
      );
      const tick = jest.spyOn(engine, 'tick').mockRejectedValue(new Error('db down'));
      engine.start();
      await jest.advanceTimersByTimeAsync(250);
      await engine.stop();
      expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(alarms.ofKind('examine_error')[0]?.detail).toContain('db down');
      await engine.stop(); // stopping twice is harmless
    });
  });
});
