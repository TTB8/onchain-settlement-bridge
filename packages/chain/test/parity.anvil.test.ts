/**
 * PARITY: the same scenario script runs against the fake and against the viem gateway on a real
 * anvil (with the real contracts), and every observable result must match: receipt status and
 * revert reason per step, the events each step emitted, the full event log of the run, balances,
 * supply, compliance flags, nonces, historical reads, and the error class of every refused
 * submission. This is what makes the fake trustworthy for every other package's tests.
 */

import { parseGwei, toHex } from 'viem';

import {
  FakeChainGateway,
  type Address,
  type ChainEvent,
  type ChainGateway,
  type ContractCall,
  type Fees,
  type SignerName,
  type SubmitRequest,
  type TxHash,
} from '../src';
import {
  deployBridge,
  gatewayFor,
  holderTransferOnChain,
  setPausedOnChain,
  startAnvil,
  waitForReceipt,
  type AnvilNode,
} from './support/anvil';
import { DEV_ROLES, devAddress } from './support/dev-accounts';
import { ZERO_ADDRESS, ZERO_REF, ref } from './support/refs';

jest.setTimeout(120_000);

const ONE = 1_000_000n;
const FEES: Fees = { maxFeePerGas: parseGwei('10'), maxPriorityFeePerGas: parseGwei('1') };
type Holder = 'alice' | 'bob' | 'carol' | 'dave';
const HOLDERS: Holder[] = ['alice', 'bob', 'carol', 'dave'];
const at = (h: Holder): Address => devAddress(h);

/** What a test needs from a chain beyond the gateway: the outside world's actions. */
interface Rig {
  name: string;
  gateway: ChainGateway;
  rogueTransfer(from: Holder, to: Address, amount: bigint): Promise<TxHash>;
  setPaused(paused: boolean): Promise<TxHash>;
  setAutomine(on: boolean): Promise<void>;
  mine(): Promise<void>;
}

type Step =
  | { call: ContractCall }
  | { rogue: { from: Holder; to: Address; amount: bigint } }
  | { pause: boolean }
  /** A submission that must be refused, with a request shaped by the current nonces. */
  | {
      refused: (
        nonces: Record<SignerName, { confirmed: number; pending: number }>,
      ) => SubmitRequest;
    };

/** References are numbered per scenario so scenarios never collide by accident. */
const R = (scenario: number, n: number) => ref(scenario * 100 + n);

const SCENARIOS: { name: string; steps: Step[] }[] = [
  {
    name: 'onboarding',
    steps: [
      { call: { kind: 'setVerified', account: at('alice'), verified: true, ref: R(1, 1) } },
      { call: { kind: 'setVerified', account: at('bob'), verified: true, ref: R(1, 2) } },
      { call: { kind: 'setVerified', account: at('dave'), verified: true, ref: R(1, 3) } },
      { call: { kind: 'setFrozen', account: at('dave'), frozen: true, ref: R(1, 4) } },
    ],
  },
  {
    name: 'mint, settle and burn',
    steps: [
      { call: { kind: 'mint', to: at('alice'), amount: 100n * ONE, ref: R(2, 1) } },
      {
        call: {
          kind: 'settleTransfer',
          from: at('alice'),
          to: at('bob'),
          amount: 30n * ONE,
          ref: R(2, 2),
        },
      },
      { call: { kind: 'burn', from: at('bob'), amount: 10n * ONE, ref: R(2, 3) } },
    ],
  },
  {
    name: 'reference rules',
    steps: [
      { call: { kind: 'mint', to: at('alice'), amount: ONE, ref: R(2, 1) } }, // reused by a mint
      { call: { kind: 'burn', from: at('alice'), amount: ONE, ref: R(2, 1) } }, // shared across kinds
      {
        call: {
          kind: 'settleTransfer',
          from: at('alice'),
          to: at('bob'),
          amount: ONE,
          ref: R(2, 3),
        },
      },
      { call: { kind: 'mint', to: at('alice'), amount: ONE, ref: ZERO_REF } },
      { call: { kind: 'mint', to: at('alice'), amount: 0n, ref: R(3, 1) } },
      { call: { kind: 'mint', to: at('alice'), amount: 0n, ref: R(2, 1) } }, // amount checked before reuse
      { call: { kind: 'setVerified', account: at('bob'), verified: true, ref: R(1, 1) } },
      { call: { kind: 'setFrozen', account: at('bob'), frozen: false, ref: ZERO_REF } },
      // The registry and the token keep separate reference sets: a registry ref works on the token.
      { call: { kind: 'mint', to: at('alice'), amount: ONE, ref: R(1, 1) } },
    ],
  },
  {
    name: 'compliance gating',
    steps: [
      { call: { kind: 'mint', to: at('carol'), amount: ONE, ref: R(4, 1) } }, // unverified
      { call: { kind: 'mint', to: at('dave'), amount: ONE, ref: R(4, 1) } }, // frozen; ref still free
      {
        call: {
          kind: 'settleTransfer',
          from: at('alice'),
          to: at('carol'),
          amount: ONE,
          ref: R(4, 1),
        },
      },
      { call: { kind: 'setVerified', account: at('bob'), verified: false, ref: R(4, 2) } },
      { call: { kind: 'burn', from: at('bob'), amount: ONE, ref: R(4, 1) } },
      {
        call: {
          kind: 'settleTransfer',
          from: at('alice'),
          to: at('bob'),
          amount: ONE,
          ref: R(4, 1),
        },
      },
      { call: { kind: 'setVerified', account: at('bob'), verified: true, ref: R(4, 3) } },
      {
        call: {
          kind: 'settleTransfer',
          from: at('alice'),
          to: at('bob'),
          amount: ONE,
          ref: R(4, 1),
        },
      },
    ],
  },
  {
    name: 'freeze and unfreeze',
    steps: [
      { call: { kind: 'setFrozen', account: at('alice'), frozen: true, ref: R(5, 1) } },
      {
        call: {
          kind: 'settleTransfer',
          from: at('alice'),
          to: at('bob'),
          amount: ONE,
          ref: R(5, 2),
        },
      },
      {
        call: {
          kind: 'settleTransfer',
          from: at('bob'),
          to: at('alice'),
          amount: ONE,
          ref: R(5, 2),
        },
      },
      { call: { kind: 'burn', from: at('alice'), amount: ONE, ref: R(5, 2) } },
      { call: { kind: 'setFrozen', account: at('alice'), frozen: false, ref: R(5, 3) } },
      {
        call: {
          kind: 'settleTransfer',
          from: at('alice'),
          to: at('bob'),
          amount: ONE,
          ref: R(5, 2),
        },
      },
    ],
  },
  {
    name: 'balances and zero addresses',
    steps: [
      { call: { kind: 'burn', from: at('bob'), amount: 1000n * ONE, ref: R(6, 1) } },
      {
        call: {
          kind: 'settleTransfer',
          from: at('bob'),
          to: at('alice'),
          amount: 1000n * ONE,
          ref: R(6, 1),
        },
      },
      { call: { kind: 'setVerified', account: ZERO_ADDRESS, verified: true, ref: R(6, 2) } },
      { call: { kind: 'setFrozen', account: ZERO_ADDRESS, frozen: true, ref: R(6, 2) } },
      { call: { kind: 'mint', to: ZERO_ADDRESS, amount: ONE, ref: R(6, 1) } },
      { call: { kind: 'burn', from: ZERO_ADDRESS, amount: ONE, ref: R(6, 1) } },
      {
        call: {
          kind: 'settleTransfer',
          from: ZERO_ADDRESS,
          to: at('bob'),
          amount: ONE,
          ref: R(6, 1),
        },
      },
      {
        call: {
          kind: 'settleTransfer',
          from: at('alice'),
          to: ZERO_ADDRESS,
          amount: ONE,
          ref: R(6, 1),
        },
      },
    ],
  },
  {
    name: 'rogue holder transfers',
    steps: [
      { rogue: { from: 'alice', to: at('bob'), amount: 2n * ONE } },
      { rogue: { from: 'alice', to: at('carol'), amount: ONE } },
      { rogue: { from: 'alice', to: at('bob'), amount: 10_000n * ONE } },
      { rogue: { from: 'alice', to: ZERO_ADDRESS, amount: ONE } },
      { rogue: { from: 'dave', to: at('alice'), amount: 0n } }, // frozen sender, even for zero
    ],
  },
  {
    name: 'pause',
    steps: [
      { pause: true },
      { call: { kind: 'mint', to: at('alice'), amount: ONE, ref: R(8, 1) } },
      { call: { kind: 'burn', from: at('alice'), amount: ONE, ref: R(8, 1) } },
      {
        call: {
          kind: 'settleTransfer',
          from: at('alice'),
          to: at('bob'),
          amount: ONE,
          ref: R(8, 1),
        },
      },
      { rogue: { from: 'alice', to: at('bob'), amount: ONE } },
      { call: { kind: 'setFrozen', account: at('carol'), frozen: true, ref: R(8, 2) } }, // registry not paused
      { pause: true },
      { pause: false },
      { pause: false },
      { call: { kind: 'mint', to: at('alice'), amount: ONE, ref: R(8, 1) } },
    ],
  },
  {
    name: 'refused submissions',
    steps: [
      {
        refused: () => ({
          signer: 'compliance',
          call: { kind: 'mint', to: at('alice'), amount: ONE, ref: R(9, 1) },
          nonce: 0,
          fees: FEES,
        }),
      },
      {
        refused: () => ({
          signer: 'settlement',
          call: { kind: 'setFrozen', account: at('alice'), frozen: true, ref: R(9, 1) },
          nonce: 0,
          fees: FEES,
        }),
      },
      {
        refused: (n) => ({
          signer: 'settlement',
          call: { kind: 'mint', to: at('alice'), amount: ONE, ref: R(9, 1) },
          nonce: n.settlement.confirmed - 1,
          fees: FEES,
        }),
      },
      {
        refused: (n) => ({
          signer: 'compliance',
          call: { kind: 'setVerified', account: at('carol'), verified: true, ref: R(9, 1) },
          nonce: n.compliance.pending,
          fees: { maxFeePerGas: 10n ** 24n, maxPriorityFeePerGas: 1n },
        }),
      },
      {
        refused: (n) => ({
          signer: 'settlement',
          call: { kind: 'mint', to: '0x1234' as Address, amount: ONE, ref: R(9, 1) },
          nonce: n.settlement.pending,
          fees: FEES,
        }),
      },
    ],
  },
];

type StepOutcome =
  { status: string; revertReason?: string; events: unknown[] } | { refused: string };

/** An event without its position, and with its transaction named by step index. */
function strip(event: ChainEvent, stepOf: Map<TxHash, number>) {
  const { txHash, ...rest } = event;
  const { blockNumber, blockHash, logIndex, ...args } = rest;
  void [blockNumber, blockHash, logIndex];
  return { ...args, step: stepOf.get(txHash) ?? -1 };
}

async function nonces(gw: ChainGateway) {
  return {
    settlement: await gw.getNonce('settlement'),
    compliance: await gw.getNonce('compliance'),
  };
}

async function runScenarios(rig: Rig) {
  const gw = rig.gateway;
  const startNonces = await nonces(gw);
  const fromBlock = (await gw.getHeadBlock()) + 1n;
  const outcomes: Record<string, StepOutcome[]> = {};
  const stepOf = new Map<TxHash, number>();
  let stepIndex = 0;
  let checkpoint = 0n;

  for (const scenario of SCENARIOS) {
    const list: StepOutcome[] = [];
    for (const step of scenario.steps) {
      stepIndex += 1;
      let hash: TxHash;
      if ('refused' in step) {
        const request = step.refused(await nonces(gw));
        const error = await gw.submit(request).then(
          () => new Error('accepted'),
          (e: unknown) => e as Error,
        );
        list.push({ refused: error.constructor.name });
        continue;
      }
      if ('call' in step) {
        const signer: SignerName =
          step.call.kind === 'setVerified' || step.call.kind === 'setFrozen'
            ? 'compliance'
            : 'settlement';
        const { pending } = await gw.getNonce(signer);
        hash = await gw.submit({ signer, call: step.call, nonce: pending, fees: FEES });
      } else if ('rogue' in step) {
        hash = await rig.rogueTransfer(step.rogue.from, step.rogue.to, step.rogue.amount);
      } else {
        hash = await rig.setPaused(step.pause);
      }
      stepOf.set(hash, stepIndex);
      const receipt = await waitForReceipt(gw, hash);
      if (!receipt) throw new Error(`${rig.name}: step ${stepIndex} was not mined`);
      const events = await gw.getEvents({
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });
      list.push({
        status: receipt.status,
        ...(receipt.revertReason === undefined ? {} : { revertReason: receipt.revertReason }),
        events: events.filter((e) => e.txHash === hash).map((e) => strip(e, stepOf)),
      });
    }
    outcomes[scenario.name] = list;
    if (scenario.name === 'mint, settle and burn') checkpoint = await gw.getHeadBlock();
  }

  // Pool rules with automine off: already known, then underpriced, then mined.
  await rig.setAutomine(false);
  const { pending } = await gw.getNonce('settlement');
  const pooled: SubmitRequest = {
    signer: 'settlement',
    call: { kind: 'mint', to: at('bob'), amount: ONE, ref: R(10, 1) },
    nonce: pending,
    fees: FEES,
  };
  const pooledHash = await gw.submit(pooled);
  stepOf.set(pooledHash, ++stepIndex);
  const poolErrors: string[] = [];
  for (const request of [pooled, { ...pooled, call: { ...pooled.call, ref: R(10, 2) } }]) {
    poolErrors.push(
      await gw.submit(request).then(
        () => 'accepted',
        (e: unknown) => (e as Error).constructor.name,
      ),
    );
  }
  const pendingBeforeMine = await gw.getReceipt(pooledHash);
  const nonceWhilePending = await gw.getNonce('settlement');
  await rig.mine();
  await rig.setAutomine(true);
  const pooledReceipt = await gw.getReceipt(pooledHash);

  const endNonces = await nonces(gw);
  const toBlock = await gw.getHeadBlock();
  const holders = [...HOLDERS.map(at), ZERO_ADDRESS];
  return {
    outcomes,
    poolErrors,
    pendingBeforeMine,
    nonceWhilePendingDelta: nonceWhilePending.pending - nonceWhilePending.confirmed,
    pooledStatus: pooledReceipt?.status,
    allEvents: (await gw.getEvents({ fromBlock, toBlock })).map((e) => strip(e, stepOf)),
    balances: await Promise.all(holders.map((h) => gw.readBalance(h))),
    supply: await gw.readTotalSupply(),
    compliance: await Promise.all(holders.map((h) => gw.readCompliance(h))),
    balancesAtCheckpoint: await Promise.all(holders.map((h) => gw.readBalance(h, checkpoint))),
    supplyAtCheckpoint: await gw.readTotalSupply(checkpoint),
    complianceAtCheckpoint: await Promise.all(holders.map((h) => gw.readCompliance(h, checkpoint))),
    nonceDeltas: {
      settlement: endNonces.settlement.confirmed - startNonces.settlement.confirmed,
      compliance: endNonces.compliance.confirmed - startNonces.compliance.confirmed,
    },
  };
}

let node: AnvilNode;
let anvilResult: Awaited<ReturnType<typeof runScenarios>>;
let fakeResult: Awaited<ReturnType<typeof runScenarios>>;

beforeAll(async () => {
  node = await startAnvil();
  const deployment = await deployBridge(node);
  const anvilRig: Rig = {
    name: 'anvil',
    gateway: gatewayFor(node, deployment),
    rogueTransfer: async (from, to, amount) =>
      (await holderTransferOnChain(node, deployment, DEV_ROLES[from], to, amount)) as TxHash,
    setPaused: async (paused) => (await setPausedOnChain(node, deployment, paused)) as TxHash,
    setAutomine: async (on) => {
      await node.rpc('evm_setAutomine', [on]);
    },
    mine: async () => {
      await node.rpc('anvil_mine', [toHex(1)]);
    },
  };

  const fake = new FakeChainGateway({
    registryAddress: deployment.registry,
    tokenAddress: deployment.token,
    signers: { settlement: devAddress('settlement'), compliance: devAddress('compliance') },
  });
  const fakeRig: Rig = {
    name: 'fake',
    gateway: fake,
    rogueTransfer: async (from, to, amount) => fake.injectTransfer(at(from), to, amount),
    setPaused: async (paused) => fake.setPaused(paused),
    setAutomine: async (on) => fake.setAutomine(on),
    mine: async () => {
      fake.mine();
    },
  };

  anvilResult = await runScenarios(anvilRig);
  fakeResult = await runScenarios(fakeRig);
});

afterAll(async () => {
  await node?.stop();
});

describe('parity: fake vs viem gateway on anvil', () => {
  it.each(SCENARIOS.map((s) => s.name))(
    'scenario "%s": every step has the same outcome and events',
    (name) => {
      expect(fakeResult.outcomes[name]).toEqual(anvilResult.outcomes[name]);
    },
  );

  it('the scenarios really exercise reverts, refusals and events (not a vacuous match)', () => {
    const all = Object.values(anvilResult.outcomes).flat();
    const reasons = new Set(
      all.map((o) => ('revertReason' in o ? o.revertReason : undefined)).filter(Boolean),
    );
    expect([...reasons].sort()).toEqual(
      [
        'ERC20InsufficientBalance',
        'ERC20InvalidReceiver',
        'ERC20InvalidSender',
        'EnforcedPause',
        'ExpectedPause',
        'InvalidReference',
        'NotAllowed',
        'ReferenceAlreadyUsed',
        'ZeroAddress',
        'ZeroAmount',
      ].sort(),
    );
    const refused = all
      .filter((o) => 'refused' in o)
      .map((o) => (o as { refused: string }).refused);
    expect(refused).toEqual([
      'SubmissionRejectedError',
      'SubmissionRejectedError',
      'NonceTooLowError',
      'InsufficientFundsError',
      'SubmissionRejectedError',
    ]);
    const kinds = new Set(anvilResult.allEvents.map((e) => e.kind));
    expect([...kinds].sort()).toEqual(
      ['Burned', 'FrozenSet', 'Minted', 'SettledTransfer', 'Transfer', 'VerificationSet'].sort(),
    );
  });

  it('the whole event log matches, in chain order', () => {
    expect(fakeResult.allEvents).toEqual(anvilResult.allEvents);
    expect(anvilResult.allEvents.length).toBeGreaterThan(20);
  });

  it('pool rules match: already known, then underpriced, pending until mined', () => {
    expect(anvilResult.poolErrors).toEqual(['AlreadyKnownError', 'ReplacementUnderpricedError']);
    expect(fakeResult.poolErrors).toEqual(anvilResult.poolErrors);
    expect(fakeResult.pendingBeforeMine).toBeNull();
    expect(anvilResult.pendingBeforeMine).toBeNull();
    expect(fakeResult.nonceWhilePendingDelta).toBe(1);
    expect(anvilResult.nonceWhilePendingDelta).toBe(1);
    expect(fakeResult.pooledStatus).toBe('success');
    expect(anvilResult.pooledStatus).toBe('success');
  });

  it('final balances, supply, flags and nonce use match', () => {
    expect(fakeResult.balances).toEqual(anvilResult.balances);
    expect(fakeResult.supply).toBe(anvilResult.supply);
    expect(fakeResult.compliance).toEqual(anvilResult.compliance);
    expect(fakeResult.nonceDeltas).toEqual(anvilResult.nonceDeltas);
    expect(anvilResult.supply).toBeGreaterThan(0n);
  });

  it('historical reads at the checkpoint block match', () => {
    expect(fakeResult.balancesAtCheckpoint).toEqual(anvilResult.balancesAtCheckpoint);
    expect(fakeResult.supplyAtCheckpoint).toBe(anvilResult.supplyAtCheckpoint);
    expect(fakeResult.complianceAtCheckpoint).toEqual(anvilResult.complianceAtCheckpoint);
    expect(anvilResult.supplyAtCheckpoint).toBe(90n * ONE);
  });
});
