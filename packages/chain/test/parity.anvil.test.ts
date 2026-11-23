/**
 * PARITY: the same scenario script runs against the fake and against the viem gateway on a real
 * anvil (with the real contracts), and every observable result must match: receipt status and
 * revert reason per step, the events each step emitted, the full event log of the run, balances,
 * supply, compliance flags, nonces, historical reads, and the error class of every refused
 * submission. This is what makes the fake trustworthy for every other package's tests.
 */

import { keccak256, parseGwei, toHex } from 'viem';

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
  freePort,
  gatewayFor,
  holderTransferOnChain,
  setHolderTransfersOnChain,
  setPausedOnChain,
  startAnvil,
  tokenCallOnChain,
  waitForReceipt,
  type AnvilNode,
} from './support/anvil';
import { DEV_ROLES, devAddress } from './support/dev-accounts';
import { ZERO_ADDRESS, ZERO_REF, ref } from './support/refs';

jest.setTimeout(120_000);

const ONE = 1_000_000n;
const FEES: Fees = { maxFeePerGas: parseGwei('10'), maxPriorityFeePerGas: parseGwei('1') };
type Holder = 'alice' | 'bob' | 'carol' | 'dave' | 'erin';
const HOLDERS: Holder[] = ['alice', 'bob', 'carol', 'dave', 'erin'];
const at = (h: Holder): Address => devAddress(h);

/** What a test needs from a chain beyond the gateway: the outside world's actions. */
interface Rig {
  name: string;
  gateway: ChainGateway;
  rogueTransfer(from: Holder, to: Address, amount: bigint): Promise<TxHash>;
  setPaused(paused: boolean): Promise<TxHash>;
  setHolderTransfers(enabled: boolean): Promise<TxHash>;
  approve(owner: Holder, spender: Address, amount: bigint): Promise<TxHash>;
  transferFrom(spender: Holder, from: Address, to: Address, amount: bigint): Promise<TxHash>;
  setAutomine(on: boolean): Promise<void>;
  /** A gateway with the same signers configured for chain id 1, to sign foreign-chain bytes. */
  foreign: ChainGateway;
  /** Runs `fn` against this chain's gateway while the node cannot be reached. */
  outage<T>(fn: (gateway: ChainGateway) => Promise<T>): Promise<T>;
  mine(): Promise<void>;
}

type Step =
  | { call: ContractCall }
  | { rogue: { from: Holder; to: Address; amount: bigint } }
  | { pause: boolean }
  | { holderSwitch: boolean }
  | { approve: { owner: Holder; spender: Address; amount: bigint } }
  | { transferFrom: { spender: Holder; from: Address; to: Address; amount: bigint } }
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
      { rogue: { from: 'alice', to: at('bob'), amount: 2n * ONE } }, // switch off: disabled
      { rogue: { from: 'dave', to: ZERO_ADDRESS, amount: 10_000n * ONE } }, // disabled comes first
      { holderSwitch: true },
      { rogue: { from: 'alice', to: at('bob'), amount: 2n * ONE } },
      { rogue: { from: 'alice', to: at('carol'), amount: ONE } },
      { rogue: { from: 'alice', to: at('bob'), amount: 10_000n * ONE } },
      { rogue: { from: 'alice', to: ZERO_ADDRESS, amount: ONE } },
      { rogue: { from: 'dave', to: at('alice'), amount: 0n } }, // frozen sender, even for zero
      { holderSwitch: false },
      { rogue: { from: 'alice', to: at('bob'), amount: ONE } },
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
    name: 'holder approve and transferFrom',
    steps: [
      { approve: { owner: 'alice', spender: at('bob'), amount: ONE } }, // switch off
      { transferFrom: { spender: 'bob', from: at('alice'), to: at('bob'), amount: ONE } },
      { holderSwitch: true },
      { approve: { owner: 'carol', spender: at('bob'), amount: ONE } }, // owner not allowed
      { approve: { owner: 'alice', spender: ZERO_ADDRESS, amount: ONE } },
      { approve: { owner: 'alice', spender: at('carol'), amount: 3n * ONE } }, // spender unchecked
      { transferFrom: { spender: 'carol', from: at('alice'), to: at('bob'), amount: ONE } },
      { approve: { owner: 'alice', spender: at('bob'), amount: 2n * ONE } },
      { transferFrom: { spender: 'bob', from: at('alice'), to: at('bob'), amount: 3n * ONE } },
      { transferFrom: { spender: 'bob', from: at('alice'), to: at('carol'), amount: ONE } },
      { transferFrom: { spender: 'bob', from: at('alice'), to: ZERO_ADDRESS, amount: ONE } },
      { transferFrom: { spender: 'bob', from: at('alice'), to: at('bob'), amount: ONE } },
      { pause: true },
      { approve: { owner: 'alice', spender: at('bob'), amount: ONE } },
      { transferFrom: { spender: 'bob', from: at('alice'), to: at('bob'), amount: ONE } },
      { pause: false },
      { holderSwitch: false },
      { transferFrom: { spender: 'bob', from: at('alice'), to: at('bob'), amount: ONE } },
      { holderSwitch: true },
      { transferFrom: { spender: 'bob', from: at('alice'), to: at('bob'), amount: ONE } }, // survived
      { transferFrom: { spender: 'bob', from: at('alice'), to: at('bob'), amount: ONE } }, // spent
      { holderSwitch: false },
      // mint, burn and settleTransfer ignore the switch
      {
        call: {
          kind: 'settleTransfer',
          from: at('bob'),
          to: at('alice'),
          amount: ONE,
          ref: R(11, 1),
        },
      },
    ],
  },
  {
    name: 'self transfer',
    steps: [
      {
        call: {
          kind: 'settleTransfer',
          from: at('alice'),
          to: at('alice'),
          amount: ONE,
          ref: ZERO_REF,
        },
      },
      {
        call: {
          kind: 'settleTransfer',
          from: at('alice'),
          to: at('alice'),
          amount: 0n,
          ref: R(12, 1),
        },
      },
      {
        call: {
          kind: 'settleTransfer',
          from: at('alice'),
          to: at('alice'),
          amount: ONE,
          ref: R(2, 1),
        },
      },
      {
        call: {
          kind: 'settleTransfer',
          from: at('alice'),
          to: at('alice'),
          amount: ONE,
          ref: R(12, 1),
        },
      },
      {
        call: {
          kind: 'settleTransfer',
          from: ZERO_ADDRESS,
          to: ZERO_ADDRESS,
          amount: ONE,
          ref: R(12, 1),
        },
      },
      {
        call: {
          kind: 'settleTransfer',
          from: at('carol'),
          to: at('carol'),
          amount: ONE,
          ref: R(12, 1),
        },
      },
      // The reference was never consumed by the reverts.
      {
        call: {
          kind: 'settleTransfer',
          from: at('alice'),
          to: at('bob'),
          amount: ONE,
          ref: R(12, 1),
        },
      },
    ],
  },
  {
    name: 'revert-order edge cases',
    steps: [
      // Paused is checked before the parties: an unallowed party still gets EnforcedPause.
      { pause: true },
      { call: { kind: 'mint', to: at('carol'), amount: ONE, ref: R(13, 1) } },
      {
        call: {
          kind: 'settleTransfer',
          from: at('alice'),
          to: at('carol'),
          amount: ONE,
          ref: R(13, 1),
        },
      },
      { call: { kind: 'burn', from: at('dave'), amount: ONE, ref: R(13, 1) } },
      { pause: false },
      // Registry: the reference is consumed before the zero-address check.
      { call: { kind: 'setVerified', account: ZERO_ADDRESS, verified: true, ref: R(1, 1) } },
      { call: { kind: 'setFrozen', account: ZERO_ADDRESS, frozen: true, ref: ZERO_REF } },
      { call: { kind: 'setVerified', account: ZERO_ADDRESS, verified: true, ref: R(13, 2) } },
      // Token first, then the registry, with one reference: separate sets, both succeed.
      { call: { kind: 'mint', to: at('alice'), amount: ONE, ref: R(13, 3) } },
      { call: { kind: 'setFrozen', account: at('bob'), frozen: false, ref: R(13, 3) } },
      { call: { kind: 'burn', from: at('alice'), amount: ONE, ref: R(13, 3) } }, // used on the token
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
      } else if ('holderSwitch' in step) {
        hash = await rig.setHolderTransfers(step.holderSwitch);
      } else if ('approve' in step) {
        hash = await rig.approve(step.approve.owner, step.approve.spender, step.approve.amount);
      } else if ('transferFrom' in step) {
        const t = step.transferFrom;
        hash = await rig.transferFrom(t.spender, t.from, t.to, t.amount);
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

  // Two transactions in ONE block where the later one changes the earlier one's outcome: a mint
  // to erin (not yet verified, higher tip so it runs first) and erin's verification. The fake
  // knows the exact reason; the viem gateway replays the call on the state AFTER the block, where
  // erin is verified, so the replay succeeds and the reason is undefined. Pinned, not hidden.
  await rig.setAutomine(false);
  const sbMintNonce = (await gw.getNonce('settlement')).pending;
  const sbVerifyNonce = (await gw.getNonce('compliance')).pending;
  const sbMint = await gw.submit({
    signer: 'settlement',
    call: { kind: 'mint', to: at('erin'), amount: ONE, ref: R(14, 1) },
    nonce: sbMintNonce,
    fees: { maxFeePerGas: parseGwei('10'), maxPriorityFeePerGas: parseGwei('5') },
  });
  const sbVerify = await gw.submit({
    signer: 'compliance',
    call: { kind: 'setVerified', account: at('erin'), verified: true, ref: R(14, 2) },
    nonce: sbVerifyNonce,
    fees: { maxFeePerGas: parseGwei('10'), maxPriorityFeePerGas: parseGwei('1') },
  });
  stepOf.set(sbMint, ++stepIndex);
  stepOf.set(sbVerify, ++stepIndex);
  await rig.mine();
  await rig.setAutomine(true);
  const sbMintReceipt = await waitForReceipt(gw, sbMint);
  const sbVerifyReceipt = await waitForReceipt(gw, sbVerify);
  const sameBlock = {
    inOneBlock: sbMintReceipt.blockNumber === sbVerifyReceipt.blockNumber,
    mintStatus: sbMintReceipt.status,
    mintReason: sbMintReceipt.revertReason,
    verifyStatus: sbVerifyReceipt.status,
    mintFirst:
      (
        await gw.getEvents({
          fromBlock: sbMintReceipt.blockNumber,
          toBlock: sbMintReceipt.blockNumber,
        })
      ).length === 1, // only VerificationSet: the mint emitted nothing
  };

  // signTransaction and sendRaw: the persist-before-broadcast pair.
  const errName = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e: unknown) => (e as Error).constructor.name,
    );
  const mintReq = (nonce: number, r: number): SubmitRequest => ({
    signer: 'settlement',
    call: { kind: 'mint', to: at('bob'), amount: ONE, ref: R(15, r) },
    nonce,
    fees: FEES,
  });
  const p0 = (await gw.getNonce('settlement')).pending;
  const s1 = await gw.signTransaction(mintReq(p0, 1));
  const s1again = await gw.signTransaction(mintReq(p0, 1));
  const afterSign = await gw.getNonce('settlement');
  const knownBeforeSend = (await gw.getTransaction(s1.hash)) !== null;
  const sentHash = await gw.sendRaw(s1.raw);
  stepOf.set(s1.hash, ++stepIndex);
  const s1Receipt = await waitForReceipt(gw, s1.hash);
  const s1Events = (
    await gw.getEvents({ fromBlock: s1Receipt.blockNumber, toBlock: s1Receipt.blockNumber })
  )
    .filter((e) => e.txHash === s1.hash)
    .map((e) => strip(e, stepOf));
  const rebroadcastMined = (await gw.sendRaw(s1.raw)) === s1.hash;
  const otherBytesUsedNonce = await errName(
    gw.sendRaw((await gw.signTransaction(mintReq(p0, 2))).raw),
  );
  await rig.setAutomine(false);
  const pn = (await gw.getNonce('settlement')).pending;
  const pooledA = await gw.signTransaction(mintReq(pn, 3));
  await gw.sendRaw(pooledA.raw);
  const rebroadcastPooled = (await gw.sendRaw(pooledA.raw)) === pooledA.hash;
  const sameFeeReplacement = await errName(
    gw.sendRaw((await gw.signTransaction(mintReq(pn, 4))).raw),
  );
  await rig.mine();
  await rig.setAutomine(true);
  stepOf.set(pooledA.hash, ++stepIndex);
  const pooledStatus2 = (await waitForReceipt(gw, pooledA.hash)).status;
  const nextNonce = (await gw.getNonce('settlement')).pending;
  const foreignRaw = (await rig.foreign.signTransaction(mintReq(nextNonce, 5))).raw;
  const signedRaw = {
    deterministic: s1.hash === s1again.hash && s1.raw === s1again.raw,
    hashIsKeccak: s1.hash === keccak256(s1.raw),
    signConsumedNothing: afterSign.pending === p0 && afterSign.confirmed <= p0,
    knownBeforeSend,
    sendReturnsHash: sentHash === s1.hash,
    status: s1Receipt.status,
    events: s1Events,
    rebroadcastMined,
    otherBytesUsedNonce,
    rebroadcastPooled,
    sameFeeReplacement,
    pooledStatus: pooledStatus2,
    garbage: await errName(gw.sendRaw('0x1234')),
    empty: await errName(gw.sendRaw('0x')),
    wrongChain: await errName(gw.sendRaw(foreignRaw)),
    outage: await rig.outage(async (g) => {
      const signed = await g.signTransaction(mintReq(nextNonce, 6));
      return {
        signedWhileDown: signed.hash === keccak256(signed.raw),
        send: await errName(g.sendRaw(signed.raw)),
      };
    }),
  };
  const rawLooksEip1559 = s1.raw.startsWith('0x02');

  const refs = [
    ZERO_REF,
    ...new Set(
      SCENARIOS.flatMap((sc) => sc.steps)
        .filter((st): st is { call: ContractCall } => 'call' in st)
        .map((st) => st.call.ref),
    ),
    R(10, 1),
    R(10, 2),
    R(14, 1),
    R(14, 2),
    R(15, 1),
    R(15, 2),
    R(15, 3),
    R(15, 4),
  ];
  const referenceFlags = async (at?: bigint) =>
    Promise.all(
      refs.flatMap((r) => [
        gw.readReferenceUsed('token', r, at),
        gw.readReferenceUsed('registry', r, at),
      ]),
    );

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
    sameBlock,
    signedRaw,
    rawLooksEip1559,
    referenceFlags: await referenceFlags(),
    referenceFlagsAtCheckpoint: await referenceFlags(checkpoint),
    noncesAtCheckpoint: {
      settlement: await gw.getNonce('settlement', checkpoint),
      compliance: await gw.getNonce('compliance', checkpoint),
    },
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
    setHolderTransfers: async (enabled) =>
      (await setHolderTransfersOnChain(node, deployment, enabled)) as TxHash,
    approve: async (owner, spender, amount) =>
      (await tokenCallOnChain(node, deployment, DEV_ROLES[owner], 'approve', [
        spender,
        amount,
      ])) as TxHash,
    transferFrom: async (spender, from, to, amount) =>
      (await tokenCallOnChain(node, deployment, DEV_ROLES[spender], 'transferFrom', [
        from,
        to,
        amount,
      ])) as TxHash,
    setAutomine: async (on) => {
      await node.rpc('evm_setAutomine', [on]);
    },
    mine: async () => {
      await node.rpc('anvil_mine', [toHex(1)]);
    },
    foreign: gatewayFor(node, deployment, { chainId: 1 }),
    outage: async (fn) =>
      fn(
        gatewayFor(node, deployment, {
          rpcUrl: `http://127.0.0.1:${await freePort()}`,
          timeoutMs: 2_000,
        }),
      ),
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
    setHolderTransfers: async (enabled) => fake.setHolderTransfersEnabled(enabled),
    approve: async (owner, spender, amount) => fake.injectApprove(at(owner), spender, amount),
    transferFrom: async (spender, from, to, amount) =>
      fake.injectTransferFrom(at(spender), from, to, amount),
    setAutomine: async (on) => fake.setAutomine(on),
    mine: async () => {
      fake.mine();
    },
    foreign: new FakeChainGateway({
      chainId: 1,
      registryAddress: deployment.registry,
      tokenAddress: deployment.token,
      signers: { settlement: devAddress('settlement'), compliance: devAddress('compliance') },
    }),
    outage: async (fn) => {
      fake.setUnavailable(true);
      try {
        return await fn(fake);
      } finally {
        fake.setUnavailable(false);
      }
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
        'ERC20InsufficientAllowance',
        'ERC20InsufficientBalance',
        'ERC20InvalidReceiver',
        'ERC20InvalidSender',
        'ERC20InvalidSpender',
        'EnforcedPause',
        'ExpectedPause',
        'HolderTransfersDisabled',
        'InvalidReference',
        'NotAllowed',
        'ReferenceAlreadyUsed',
        'SelfTransfer',
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

  it('readReferenceUsed matches for every reference, on both contracts, at head and checkpoint', () => {
    expect(fakeResult.referenceFlags).toEqual(anvilResult.referenceFlags);
    expect(fakeResult.referenceFlagsAtCheckpoint).toEqual(anvilResult.referenceFlagsAtCheckpoint);
    // Not vacuous: some references are used, some are not, and the two moments differ.
    expect(anvilResult.referenceFlags).toContain(true);
    expect(anvilResult.referenceFlags).toContain(false);
    expect(anvilResult.referenceFlags).not.toEqual(anvilResult.referenceFlagsAtCheckpoint);
  });

  it('getNonce at the checkpoint block matches', () => {
    expect(fakeResult.noncesAtCheckpoint).toEqual(anvilResult.noncesAtCheckpoint);
    expect(anvilResult.noncesAtCheckpoint.settlement.confirmed).toBe(3);
    expect(anvilResult.noncesAtCheckpoint.compliance.confirmed).toBe(4);
  });

  it('signTransaction and sendRaw behave the same: stable bytes, idempotent rebroadcast, same errors', () => {
    expect(fakeResult.signedRaw).toEqual(anvilResult.signedRaw);
    expect(anvilResult.signedRaw).toEqual({
      deterministic: true,
      hashIsKeccak: true,
      signConsumedNothing: true,
      knownBeforeSend: false,
      sendReturnsHash: true,
      status: 'success',
      events: expect.arrayContaining([expect.objectContaining({ kind: 'Minted' })]),
      rebroadcastMined: true,
      otherBytesUsedNonce: 'NonceTooLowError',
      rebroadcastPooled: true,
      sameFeeReplacement: 'ReplacementUnderpricedError',
      pooledStatus: 'success',
      garbage: 'SubmissionRejectedError',
      empty: 'SubmissionRejectedError',
      wrongChain: 'SubmissionRejectedError',
      outage: { signedWhileDown: true, send: 'ChainUnavailableError' },
    });
  });

  it('KNOWN DIFFERENCE: the fake signs no real transaction, so its bytes and hashes differ', () => {
    // Behaviour is the same (above); the bytes are not. Anvil gets a real EIP-1559 transaction
    // signed by the dev key; the fake has no keys and encodes the request canonically.
    expect(anvilResult.rawLooksEip1559).toBe(true);
    expect(fakeResult.rawLooksEip1559).toBe(false);
  });

  it('KNOWN DIFFERENCE: a revert caused by state a later transaction in the same block changed', () => {
    // Same on both: one block, the mint ran first and reverted, the verification succeeded.
    for (const result of [fakeResult, anvilResult]) {
      expect(result.sameBlock).toMatchObject({
        inOneBlock: true,
        mintStatus: 'reverted',
        verifyStatus: 'success',
        mintFirst: true,
      });
    }
    // Different: the fake knows the reason; the viem gateway's replay (on the state after the
    // block, where erin is verified) succeeds, so it cannot name one. See the README.
    expect(fakeResult.sameBlock.mintReason).toBe('NotAllowed');
    expect(anvilResult.sameBlock.mintReason).toBeUndefined();
  });
});
