/**
 * Piece B test rig: a spying `FakeChainGateway`, a deployment row bound to it (with its signer
 * rows), users whose wallets are verified ON the fake chain, an inspector for the fake's signed
 * encoding, and a `BridgeEngine` wired to all of it. Helpers read back the ledger and the chain.
 *
 * The fake's raw bytes are its own canonical encoding (`fake-eip1559-tx:` + sorted JSON with
 * bigints as `"<n>n"`), not real EIP-1559 bytes. `FakeTransactionInspector` decodes exactly that
 * documented encoding. It cannot check `to` independently (the fake's bytes carry no target; the
 * contract is implied by the call kind), so `to` is only checked for real by the viem inspector in
 * the Anvil suite; every other field is checked here.
 */

import { randomBytes } from 'node:crypto';

import {
  type Address,
  type ContractCall,
  FakeChainGateway,
  type FakeChainOptions,
  type Hex,
  SIGNER_FOR_CALL,
  type SignedTransaction,
  type SignerName,
  type SubmitRequest,
} from '@bridge/chain';
import type { ChainAttempt, Operation, PrismaClient } from '@bridge/db';
import { hexToString, keccak256 } from 'viem';

import {
  AlarmLog,
  BridgeEngine,
  type BridgeEngineConfig,
  type DecodedTransaction,
  type RawTransactionInspector,
} from '../../src';
import { balanceOf, FakeClock, RecordingIds, type TestUser } from './fixtures';

/** A random non-zero bytes32. */
export const ref32 = (): `0x${string}` => `0x${randomBytes(32).toString('hex')}`;

const RAW_PREFIX = 'fake-eip1559-tx:';

/** Decodes the fake gateway's documented signed encoding. */
export class FakeTransactionInspector implements RawTransactionInspector {
  /** @param chain The fake whose deployment gives the target contract of each call kind. */
  constructor(private readonly chain: FakeChainGateway) {}

  async decode(raw: Hex): Promise<DecodedTransaction> {
    const text = hexToString(raw);
    if (!text.startsWith(RAW_PREFIX)) throw new TypeError('not a fake signed transaction');
    const d = JSON.parse(text.slice(RAW_PREFIX.length), (_k, v: unknown) =>
      typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
    ) as {
      chainId: number;
      from: Address;
      signer: SignerName;
      nonce: number;
      call: ContractCall;
      fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    };
    const dep = this.chain.deployment();
    return {
      type: 'eip1559',
      chainId: d.chainId,
      nonce: d.nonce,
      to: SIGNER_FOR_CALL[d.call.kind] === 'settlement' ? dep.token : dep.registry,
      call: d.call,
      maxFeePerGas: d.fees.maxFeePerGas,
      maxPriorityFeePerGas: d.fees.maxPriorityFeePerGas,
      from: d.from,
      value: 0n, // the fake's encoding carries no value: the bridge never sends any
      gas: null,
    };
  }
}

/** The fake, recording every broadcast and able to misbehave once. */
export class SpyChain extends FakeChainGateway {
  /** The hash of every byte string handed to `sendRaw`, in order. */
  readonly broadcasts: string[] = [];
  /** Called inside `signTransaction`, once, then cleared. */
  onSign: (() => Promise<void>) | undefined;
  /** Thrown by the next `sendRaw` INSTEAD of sending (a crash before the wire). */
  crashNextBroadcast: Error | undefined;
  /** Rewrites what `signTransaction` returns (a misbehaving signer), until cleared. */
  tamper:
    ((signed: SignedTransaction, request: SubmitRequest) => Promise<SignedTransaction>) | undefined;

  override async signTransaction(request: SubmitRequest): Promise<SignedTransaction> {
    const hook = this.onSign;
    this.onSign = undefined;
    if (hook !== undefined) await hook();
    const signed = await super.signTransaction(request);
    return this.tamper === undefined ? signed : this.tamper(signed, request);
  }

  override async sendRaw(raw: Hex): Promise<`0x${string}`> {
    const crash = this.crashNextBroadcast;
    if (crash !== undefined) {
      this.crashNextBroadcast = undefined;
      throw crash;
    }
    this.broadcasts.push(keccak256(raw));
    return super.sendRaw(raw);
  }
}

/** Everything a piece B scenario needs. */
export interface Rig {
  prisma: PrismaClient;
  chain: SpyChain;
  /** The same spy (kept as `signer` so tests read as "what the signer did"). */
  signer: SpyChain;
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
    dropRetrySeconds: 30,
    giveUpAfterSeconds: 300,
    failedAlarmAfterSeconds: 3_600,
    orphanAfterSeconds: 600,
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
  const chain = new SpyChain({
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
  const signer = chain;
  const inspector = new FakeTransactionInspector(chain);
  const clock = new FakeClock();
  const alarms = new AlarmLog();
  const makeEngine = (more: Partial<BridgeEngineConfig> = {}) =>
    new BridgeEngine(
      { prisma, gateway: chain, inspector, clock, ids: new RecordingIds(), alarms },
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
