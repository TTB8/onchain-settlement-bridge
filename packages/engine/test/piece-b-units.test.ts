/**
 * Units for piece B without a database: the outbox call codec, the broadcast classifier (ADR
 * 0009), `signAndVerify` on real and fake signed bytes, the alarm log, constructor validation, and the
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
  type ChainGateway,
  type SignedTransaction,
  settlementTokenAbi,
  ViemChainGateway,
} from '@bridge/chain';
import type { PrismaClient } from '@bridge/db';
import { encodeFunctionData, keccak256 } from 'viem';

import {
  AlarmLog,
  BridgeEngine,
  classifyBroadcastError,
  contractCallFromJson,
  InvalidRequestError,
  callFromCalldata,
  SignedTransactionMismatchError,
  signAndVerify,
  ViemTransactionInspector,
  type TickSummary,
  TxMonitor,
} from '../src';
import { configFor, FakeTransactionInspector, SpyChain } from './support/bridge';
import { devAccount } from '../../chain/test/support/dev-accounts';
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
    [new SignedTransactionMismatchError('drift'), 'unknown'],
    [new Error('anything else'), 'unknown'],
    ['a string', 'unknown'],
  ])('%p is %s', (err, kind) => {
    expect(classifyBroadcastError(err).kind).toBe(kind);
  });
});

describe('signAndVerify (review M-3): the signed bytes are checked before anything is stored', () => {
  // DEV ONLY: Anvil's public development accounts, derived at runtime from the public mnemonic.
  const TOKEN: `0x${string}` = `0x${'7'.repeat(40)}`;
  const REGISTRY: `0x${string}` = `0x${'6'.repeat(40)}`;
  const viemGateway = (over: { chainId?: number; token?: `0x${string}`; key?: number } = {}) =>
    new ViemChainGateway({
      rpcUrl: 'http://127.0.0.1:9', // never contacted: signing is local
      chainId: over.chainId ?? 31337,
      registryAddress: REGISTRY,
      tokenAddress: over.token ?? TOKEN,
      signers: { settlement: devAccount(over.key ?? 1), compliance: devAccount(2) },
    });
  const settlementAddress = devAccount(1).address.toLowerCase() as `0x${string}`;
  const expected = {
    chainId: 31337,
    token: TOKEN,
    registry: REGISTRY,
    signerAddress: settlementAddress,
  };
  const request = (over: Partial<SubmitRequest> = {}): SubmitRequest => ({
    signer: 'settlement',
    call: { kind: 'mint', to: A, amount: 5n, ref: REF },
    nonce: 3,
    fees: { maxFeePerGas: 10n ** 10n, maxPriorityFeePerGas: 10n ** 9n },
    ...over,
  });
  const inspector = new ViemTransactionInspector();
  /** A gateway whose signTransaction returns what `other` signs instead. */
  const lying = (other: () => Promise<SignedTransaction>): ChainGateway =>
    new Proxy(viemGateway(), {
      get(target, prop, receiver) {
        if (prop === 'signTransaction') return other;
        const v: unknown = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });

  it('accepts real EIP-1559 bytes that are exactly the request (all five call kinds decode)', async () => {
    const g = viemGateway();
    const signed = await signAndVerify(g, inspector, request(), expected);
    expect(signed.hash).toMatch(/^0x[0-9a-f]{64}$/);
    for (const call of [
      { kind: 'burn', from: A, amount: 2n, ref: REF },
      { kind: 'settleTransfer', from: A, to: B, amount: 2n, ref: REF },
    ] as const) {
      await expect(signAndVerify(g, inspector, request({ call }), expected)).resolves.toBeDefined();
    }
    for (const call of [
      { kind: 'setVerified', account: A, verified: true, ref: REF },
      { kind: 'setFrozen', account: A, frozen: false, ref: REF },
    ] as const) {
      const req: SubmitRequest = { ...request({ call }), signer: 'compliance' };
      const comp = {
        ...expected,
        signerAddress: devAccount(2).address.toLowerCase() as `0x${string}`,
      };
      await expect(signAndVerify(g, inspector, req, comp)).resolves.toBeDefined();
    }
  });

  it.each([
    [
      'a hash that is not the bytes hash',
      async () => ({
        ...(await viemGateway().signTransaction(request())),
        hash: `0x${'9'.repeat(64)}` as `0x${string}`,
      }),
      /hash/,
    ],
    ['another nonce', () => viemGateway().signTransaction(request({ nonce: 4 })), /nonce/],
    [
      'another key (wrong signer in the raw bytes)',
      () => viemGateway({ key: 5 }).signTransaction(request()),
      /from/,
    ],
    [
      'another token (wrong to)',
      () => viemGateway({ token: `0x${'8'.repeat(40)}` }).signTransaction(request()),
      /to/,
    ],
    ['another chain id', () => viemGateway({ chainId: 1 }).signTransaction(request()), /chainId/],
    [
      'another amount (wrong data)',
      () =>
        viemGateway().signTransaction(
          request({ call: { kind: 'mint', to: A, amount: 6n, ref: REF } }),
        ),
      /data/,
    ],
    [
      'other fees',
      () =>
        viemGateway().signTransaction(
          request({ fees: { maxFeePerGas: 10n ** 11n, maxPriorityFeePerGas: 10n ** 9n } }),
        ),
      /maxFeePerGas/,
    ],
    [
      'other tip',
      () =>
        viemGateway().signTransaction(
          request({ fees: { maxFeePerGas: 10n ** 10n, maxPriorityFeePerGas: 1n } }),
        ),
      /maxPriorityFeePerGas/,
    ],
    [
      'undecodable bytes',
      async () => ({ raw: '0xdeadbeef' as `0x${string}`, hash: keccak256('0xdeadbeef') }),
      /decoded/,
    ],
  ])('refuses %s', async (_label, other, why) => {
    await expect(signAndVerify(lying(other), inspector, request(), expected)).rejects.toThrow(
      SignedTransactionMismatchError,
    );
    await expect(signAndVerify(lying(other), inspector, request(), expected)).rejects.toThrow(why);
  });

  /** Signs a raw EIP-1559 transaction directly with the dev settlement key (DEV ONLY). */
  const rawSign = async (over: { value?: bigint; data?: `0x${string}`; gas?: bigint }) => {
    const data =
      over.data ??
      encodeFunctionData({ abi: settlementTokenAbi, functionName: 'mint', args: [A, 5n, REF] });
    const raw = await devAccount(1).signTransaction({
      type: 'eip1559',
      chainId: 31337,
      nonce: 3,
      to: TOKEN,
      data,
      value: over.value ?? 0n,
      gas: over.gas ?? 300_000n,
      maxFeePerGas: 10n ** 10n,
      maxPriorityFeePerGas: 10n ** 9n,
    });
    return { raw, hash: keccak256(raw) };
  };

  it('refuses a transaction that sends ether', async () => {
    await expect(
      signAndVerify(
        lying(() => rawSign({ value: 1n })),
        inspector,
        request(),
        expected,
      ),
    ).rejects.toThrow(/value/);
    await expect(
      signAndVerify(
        lying(() => rawSign({})),
        inspector,
        request(),
        expected,
      ),
    ).resolves.toBeDefined();
  });

  it('refuses calldata with trailing bytes', async () => {
    const data =
      `${encodeFunctionData({ abi: settlementTokenAbi, functionName: 'mint', args: [A, 5n, REF] })}00` as `0x${string}`;
    await expect(
      signAndVerify(
        lying(() => rawSign({ data })),
        inspector,
        request(),
        expected,
      ),
    ).rejects.toThrow(/decoded/);
  });

  it('compares the gas limit when the caller knows it', async () => {
    const g = lying(() => rawSign({ gas: 21_000n }));
    await expect(signAndVerify(g, inspector, request(), expected)).resolves.toBeDefined();
    await expect(
      signAndVerify(g, inspector, request(), { ...expected, gasLimit: 300_000n }),
    ).rejects.toThrow(/gas/);
  });

  it('the fake inspector checks the fake encoding the same way', async () => {
    const chain = new SpyChain({ chainId: 4242 });
    const dep = chain.deployment();
    const exp = {
      chainId: 4242,
      token: dep.token,
      registry: dep.registry,
      signerAddress: chain.signerAddress('settlement'),
    };
    const fake = new FakeTransactionInspector(chain);
    await expect(signAndVerify(chain, fake, request(), exp)).resolves.toBeDefined();
    chain.tamper = async (_s, r) => {
      const other = new SpyChain({ chainId: 4242 });
      return other.signTransaction({ ...r, nonce: r.nonce + 1 });
    };
    await expect(signAndVerify(chain, fake, request(), exp)).rejects.toThrow(/nonce/);
  });

  it('callFromCalldata refuses calldata that is not a bridge call', () => {
    expect(() => callFromCalldata('0x12345678')).toThrow(TypeError);
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
      inspector: new FakeTransactionInspector(chain),
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
      inspector: new FakeTransactionInspector(chain),
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
      skipAlarmPasses: 1,
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
          inspector: new FakeTransactionInspector(chain),
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
