/**
 * Piece B test rig: a `FakeChainGateway`, a deployment row bound to it (with its signer rows),
 * users whose wallets are verified ON the fake chain, a deterministic signer for the fake, and a
 * `BridgeEngine` wired to all of it. Helpers read back the ledger and the chain.
 *
 * The fake's transaction hash is a function of (chain id, signer, nonce, call, fees); `fakeSign`
 * reproduces it so the engine can record the hash before broadcasting. `ResigningSigner` checks
 * on every broadcast that the fake reports the same hash, so a drift here fails loudly.
 */

import { randomBytes } from 'node:crypto';

import {
  type Address,
  FakeChainGateway,
  type FakeChainOptions,
  type SubmitRequest,
} from '@bridge/chain';
import type { ChainAttempt, Operation, PrismaClient } from '@bridge/db';
import { keccak256, stringToHex } from 'viem';

import {
  AlarmLog,
  BridgeEngine,
  type BridgeEngineConfig,
  ResigningSigner,
  type SignedTransaction,
  type TransactionSigner,
} from '../../src';
import { balanceOf, FakeClock, RecordingIds, type TestUser } from './fixtures';

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));
}

/** The fake's own hash for a request, and its JSON as the "raw" bytes. */
export function fakeSign(chainId: number) {
  return async (request: SubmitRequest): Promise<SignedTransaction> => {
    const payload = {
      signer: request.signer,
      nonce: request.nonce,
      call: request.call,
      fees: {
        maxFeePerGas: request.fees.maxFeePerGas,
        maxPriorityFeePerGas: request.fees.maxPriorityFeePerGas,
      },
    };
    return {
      hash: keccak256(stringToHex(stableJson({ chainId, payload }))),
      raw: stringToHex(stableJson(payload)),
    };
  };
}

/** A random non-zero bytes32. */
export const ref32 = (): `0x${string}` => `0x${randomBytes(32).toString('hex')}`;

/** A signer that records every broadcast and can be told to misbehave once. */
export class SpySigner implements TransactionSigner {
  readonly broadcasts: string[] = [];
  /** Called inside `sign` (inside the attempt transaction), once, then cleared. */
  onSign: (() => Promise<void>) | undefined;
  /** Thrown by the next broadcast INSTEAD of sending (a crash before the wire). */
  crashNextBroadcast: Error | undefined;

  constructor(private readonly inner: TransactionSigner) {}

  async sign(request: SubmitRequest): Promise<SignedTransaction> {
    const hook = this.onSign;
    this.onSign = undefined;
    if (hook !== undefined) await hook();
    return this.inner.sign(request);
  }

  async broadcast(signed: SignedTransaction, request: SubmitRequest): Promise<`0x${string}`> {
    const crash = this.crashNextBroadcast;
    if (crash !== undefined) {
      this.crashNextBroadcast = undefined;
      throw crash;
    }
    this.broadcasts.push(signed.hash);
    return this.inner.broadcast(signed, request);
  }
}

/** Everything a piece B scenario needs. */
export interface Rig {
  prisma: PrismaClient;
  chain: FakeChainGateway;
  signer: SpySigner;
  clock: FakeClock;
  alarms: AlarmLog;
  engine: BridgeEngine;
  deploymentId: string;
  /** Builds another engine on the same database and chain (e.g. a second worker). */
  makeEngine(extra?: Partial<BridgeEngineConfig>): BridgeEngine;
}

let chainCounter = 0;

/** Default engine config for the fake. */
export function configFor(chain: FakeChainGateway, extra: Partial<BridgeEngineConfig> = {}) {
  return {
    chainId: BigInt(chain.chainId),
    tokenAddress: chain.tokenAddress,
    workerId: 'test-worker',
    confirmationDepth: 1,
    feeCap: 10n ** 12n,
    stuckAfterSeconds: 60,
    backoff: { baseMs: 1_000, maxMs: 10_000, maxAttempts: 5 },
    lockTimeoutMs: 60_000,
    handlerTimeoutMs: 20_000,
    ...extra,
  } satisfies BridgeEngineConfig;
}

/**
 * A fake chain (unique chain id per rig, so rigs in one database never share a deployment), its
 * deployment row (active) with both signer rows, and an engine.
 */
export async function makeRig(
  prisma: PrismaClient,
  extra: Partial<BridgeEngineConfig> = {},
  chainOptions: FakeChainOptions = {},
): Promise<Rig> {
  chainCounter += 1;
  const chain = new FakeChainGateway({
    chainId: 900_000 + chainCounter + Math.floor(Math.random() * 1_000_000),
    ...chainOptions,
  });
  // Deactivate other deployments on the same chain id cannot happen: the id is unique per rig.
  const d = await prisma.deployment.create({
    data: {
      chainId: BigInt(chain.chainId),
      tokenAddress: chain.tokenAddress,
      registryAddress: chain.registryAddress,
      deploymentBlock: 0n,
      active: true,
    },
  });
  await prisma.signerState.createMany({
    data: [
      { deploymentId: d.id, signer: 'settlement', address: chain.signerAddress('settlement') },
      { deploymentId: d.id, signer: 'compliance', address: chain.signerAddress('compliance') },
    ],
  });
  const signer = new SpySigner(new ResigningSigner(chain, fakeSign(chain.chainId)));
  const clock = new FakeClock();
  const alarms = new AlarmLog();
  const makeEngine = (more: Partial<BridgeEngineConfig> = {}) =>
    new BridgeEngine(
      { prisma, gateway: chain, signer, clock, ids: new RecordingIds(), alarms },
      configFor(chain, { ...extra, ...more }),
    );
  return {
    prisma,
    chain,
    signer,
    clock,
    alarms,
    engine: makeEngine(),
    deploymentId: d.id,
    makeEngine,
  };
}

/** Sets a compliance flag on the fake chain directly (as the compliance signer), mined. */
export async function setOnChain(
  chain: FakeChainGateway,
  account: string,
  what: { verified: boolean } | { frozen: boolean },
): Promise<void> {
  const { pending } = await chain.getNonce('compliance');
  const fees = await chain.estimateFees();
  const call =
    'verified' in what
      ? {
          kind: 'setVerified' as const,
          account: account as Address,
          verified: what.verified,
          ref: ref32(),
        }
      : {
          kind: 'setFrozen' as const,
          account: account as Address,
          frozen: what.frozen,
          ref: ref32(),
        };
  await chain.submit({ signer: 'compliance', call, nonce: pending, fees });
  chain.mine();
}

/** available + held of a user (what the chain balance must equal once settled). */
export async function ledgerHolding(prisma: PrismaClient, u: TestUser): Promise<bigint> {
  return (await balanceOf(prisma, u.available)) + (await balanceOf(prisma, u.held));
}

/** The operation row. */
export function opRow(prisma: PrismaClient, id: string): Promise<Operation> {
  return prisma.operation.findUniqueOrThrow({ where: { id } });
}

/** Every attempt of an operation, oldest first. */
export function attemptsOf(prisma: PrismaClient, operationId: string): Promise<ChainAttempt[]> {
  return prisma.chainAttempt.findMany({
    where: { outbox: { operationId } },
    orderBy: [{ nonce: 'asc' }, { bumpsSoFar: 'asc' }, { submittedAt: 'asc' }, { id: 'asc' }],
  });
}

/** Runs `tick()` up to `n` times, stopping early when `done()` says so. */
export async function tickUntil(
  engine: BridgeEngine,
  done: () => Promise<boolean>,
  n = 10,
  between: () => void | Promise<void> = () => undefined,
): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await engine.tick();
    if (await done()) return;
    await between();
  }
}
