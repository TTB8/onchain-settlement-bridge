/**
 * Integration tests for the viem gateway against a REAL native anvil that this file spawns on a
 * free port, with the contracts deployed from the forge build artifacts. Needs `anvil` (Foundry)
 * on PATH or in ~/.foundry/bin.
 */

import { inspect } from 'node:util';

import { parseGwei, toHex } from 'viem';

import {
  AlreadyKnownError,
  ChainError,
  ChainIdMismatchError,
  ChainUnavailableError,
  InsufficientFundsError,
  NonceTooLowError,
  ReplacementUnderpricedError,
  SubmissionRejectedError,
  ViemChainGateway,
  type Address,
  type ContractCall,
  type Fees,
  type SignerName,
  type TxHash,
} from '../src';
import {
  deployBridge,
  freePort,
  gatewayFor,
  holderTransferOnChain,
  setPausedOnChain,
  startAnvil,
  waitForReceipt,
  type AnvilNode,
  type Deployment,
} from './support/anvil';
import { DEV_ROLES, devAccount, devAddress, devPrivateKeyHex } from './support/dev-accounts';
import { ZERO_ADDRESS, ref } from './support/refs';

jest.setTimeout(60_000);

const ONE = 1_000_000n;
const alice = devAddress('alice');
const bob = devAddress('bob');
const carol = devAddress('carol');
const dave = devAddress('dave');
const FEES: Fees = { maxFeePerGas: parseGwei('10'), maxPriorityFeePerGas: parseGwei('1') };

let node: AnvilNode;
let deployment: Deployment;
let gw: ViemChainGateway;
let refCounter = 5000;
const nextRef = () => ref(++refCounter);

function signerFor(call: ContractCall): SignerName {
  return call.kind === 'setVerified' || call.kind === 'setFrozen' ? 'compliance' : 'settlement';
}

async function send(call: ContractCall, fees: Fees = FEES, gateway = gw): Promise<TxHash> {
  const signer = signerFor(call);
  const { pending } = await gateway.getNonce(signer);
  return gateway.submit({ signer, call, nonce: pending, fees });
}

async function sendOk(call: ContractCall): Promise<TxHash> {
  const hash = await send(call);
  const receipt = await waitForReceipt(gw, hash);
  if (receipt?.status !== 'success') throw new Error(`${call.kind} did not succeed`);
  return hash;
}

const automine = (on: boolean) => node.rpc('evm_setAutomine', [on]);
const mine = (blocks = 1) => node.rpc('anvil_mine', [toHex(blocks)]);

beforeAll(async () => {
  node = await startAnvil();
  deployment = await deployBridge(node);
  gw = gatewayFor(node, deployment);
  await sendOk({ kind: 'setVerified', account: alice, verified: true, ref: nextRef() });
  await sendOk({ kind: 'setVerified', account: bob, verified: true, ref: nextRef() });
});

afterAll(async () => {
  await node?.stop();
});

describe('ViemChainGateway on anvil: identity', () => {
  it('reports the chain, head, blocks and lowercase signer addresses', async () => {
    expect(await gw.getChainId()).toBe(31337);
    const head = await gw.getHeadBlock();
    expect(head).toBeGreaterThan(0n);
    const block = await gw.getBlock(head);
    expect(block?.number).toBe(head);
    expect(block?.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(block?.parentHash).toBe((await gw.getBlock(head - 1n))?.hash);
    expect(await gw.getBlock(head + 100n)).toBeNull();
    expect(await gw.getBlock(-1n)).toBeNull();
    expect(gw.signerAddress('settlement')).toBe(devAddress('settlement'));
    expect(gw.signerAddress('compliance')).toBe(devAddress('compliance'));
    expect(() => gw.signerAddress('nobody' as SignerName)).toThrow(ChainError);
    const fees = await gw.estimateFees();
    expect(fees.maxFeePerGas).toBeGreaterThan(fees.maxPriorityFeePerGas);
    expect(JSON.stringify(gw)).toContain(devAddress('settlement'));
  });

  it('accepts private keys as signers (derived at runtime from the dev mnemonic)', async () => {
    const keyed = new ViemChainGateway({
      rpcUrl: node.url,
      chainId: 31337,
      registryAddress: deployment.registry,
      tokenAddress: deployment.token,
      signers: {
        settlement: `0x${devPrivateKeyHex(DEV_ROLES.settlement)}`,
        compliance: `0x${devPrivateKeyHex(DEV_ROLES.compliance)}`,
      },
    });
    expect(keyed.signerAddress('settlement')).toBe(devAddress('settlement'));
    const hash = await send(
      { kind: 'setFrozen', account: dave, frozen: false, ref: nextRef() },
      FEES,
      keyed,
    );
    expect((await waitForReceipt(keyed, hash))?.status).toBe('success');
  });

  it('refuses bad configuration without echoing it', () => {
    const base = {
      rpcUrl: node.url,
      chainId: 31337,
      registryAddress: deployment.registry,
      tokenAddress: deployment.token,
      signers: { settlement: devAccount(1), compliance: devAccount(2) },
    };
    expect(() => new ViemChainGateway({ ...base, chainId: 0 })).toThrow(ChainError);
    expect(() => new ViemChainGateway({ ...base, registryAddress: '0x12' })).toThrow(
      /registryAddress/,
    );
    expect(() => new ViemChainGateway({ ...base, tokenAddress: '0x12' })).toThrow(/tokenAddress/);
    expect(
      () =>
        new ViemChainGateway({
          ...base,
          signers: { ...base.signers, compliance: undefined as never },
        }),
    ).toThrow(/compliance signer must be/);
    const badKey = `0x${'f'.repeat(64)}` as const; // above the curve order: not a valid key
    let message = '';
    try {
      new ViemChainGateway({ ...base, signers: { ...base.signers, settlement: badKey } });
    } catch (error) {
      message = `${String(error)} ${(error as Error).stack ?? ''} ${String((error as Error).cause)}`;
    }
    expect(message).toMatch(/not a valid private key/);
    expect(message).not.toContain('f'.repeat(64));
  });
});

describe('ViemChainGateway on anvil: the five calls and their events', () => {
  it('sends all five calls and decodes all six event kinds in chain order', async () => {
    const from = (await gw.getHeadBlock()) + 1n;
    const rMint = nextRef();
    const rSettle = nextRef();
    const rBurn = nextRef();
    const rFreeze = nextRef();
    const rVerify = nextRef();
    const hMint = await sendOk({ kind: 'mint', to: alice, amount: 10n * ONE, ref: rMint });
    const hSettle = await sendOk({
      kind: 'settleTransfer',
      from: alice,
      to: bob,
      amount: 4n * ONE,
      ref: rSettle,
    });
    const hBurn = await sendOk({ kind: 'burn', from: bob, amount: ONE, ref: rBurn });
    const hFreeze = await sendOk({ kind: 'setFrozen', account: carol, frozen: true, ref: rFreeze });
    const hVerify = await sendOk({
      kind: 'setVerified',
      account: carol,
      verified: true,
      ref: rVerify,
    });
    const to = await gw.getHeadBlock();

    const events = await gw.getEvents({ fromBlock: from, toBlock: to });
    const strip = events.map(({ blockNumber: _b, blockHash: _h, logIndex: _l, ...rest }) => rest);
    expect(strip).toEqual([
      { kind: 'Transfer', from: ZERO_ADDRESS, to: alice, amount: 10n * ONE, txHash: hMint },
      { kind: 'Minted', to: alice, amount: 10n * ONE, ref: rMint, txHash: hMint },
      { kind: 'Transfer', from: alice, to: bob, amount: 4n * ONE, txHash: hSettle },
      {
        kind: 'SettledTransfer',
        from: alice,
        to: bob,
        amount: 4n * ONE,
        ref: rSettle,
        txHash: hSettle,
      },
      { kind: 'Transfer', from: bob, to: ZERO_ADDRESS, amount: ONE, txHash: hBurn },
      { kind: 'Burned', from: bob, amount: ONE, ref: rBurn, txHash: hBurn },
      { kind: 'FrozenSet', account: carol, frozen: true, ref: rFreeze, txHash: hFreeze },
      { kind: 'VerificationSet', account: carol, verified: true, ref: rVerify, txHash: hVerify },
    ]);
    for (let i = 1; i < events.length; i += 1) {
      const [a, b] = [events[i - 1]!, events[i]!];
      expect(
        a.blockNumber < b.blockNumber ||
          (a.blockNumber === b.blockNumber && a.logIndex < b.logIndex),
      ).toBe(true);
    }
    const receipt = await gw.getReceipt(hMint);
    expect(events[0]).toMatchObject({
      blockNumber: receipt?.blockNumber,
      blockHash: receipt?.blockHash,
    });

    expect(await gw.readBalance(alice)).toBe(6n * ONE);
    expect(await gw.readBalance(bob)).toBe(3n * ONE);
    expect(await gw.readTotalSupply()).toBe(9n * ONE);
    expect(await gw.readCompliance(carol)).toEqual({ verified: true, frozen: true });

    // Unfreeze carol again for later tests.
    await sendOk({ kind: 'setFrozen', account: carol, frozen: false, ref: nextRef() });
  });

  it("ignores the contracts' other events (roles, pause) and returns [] for an empty range", async () => {
    const all = await gw.getEvents({ fromBlock: 0n, toBlock: (await gw.getHeadBlock()) + 50n });
    const kinds = new Set(all.map((e) => e.kind));
    for (const kind of kinds) {
      expect([
        'Transfer',
        'Minted',
        'Burned',
        'SettledTransfer',
        'VerificationSet',
        'FrozenSet',
      ]).toContain(kind);
    }
    expect(await gw.getEvents({ fromBlock: 10n, toBlock: 9n })).toEqual([]);
    expect(await gw.getEvents({ fromBlock: -3n, toBlock: 0n })).toEqual([]);
  });

  it('a holder-signed transfer shows up as a Transfer with no reference event', async () => {
    await sendOk({ kind: 'mint', to: alice, amount: ONE, ref: nextRef() });
    const hash = (await holderTransferOnChain(
      node,
      deployment,
      DEV_ROLES.alice,
      bob,
      ONE,
    )) as TxHash;
    const receipt = await waitForReceipt(gw, hash);
    expect(receipt?.status).toBe('success');
    const events = await gw.getEvents({
      fromBlock: receipt!.blockNumber,
      toBlock: receipt!.blockNumber,
    });
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'Transfer',
        from: alice,
        to: bob,
        amount: ONE,
        txHash: hash,
      }),
    ]);
    // Not one of the bridge's transactions.
    expect(await gw.getTransaction(hash)).toBeNull();
  });

  it('reads balances, supply and flags at a past block', async () => {
    await sendOk({ kind: 'setVerified', account: dave, verified: true, ref: nextRef() });
    const before = await gw.getHeadBlock();
    const balanceBefore = await gw.readBalance(dave);
    const supplyBefore = await gw.readTotalSupply();
    await sendOk({ kind: 'mint', to: dave, amount: 7n * ONE, ref: nextRef() });
    await sendOk({ kind: 'setFrozen', account: dave, frozen: true, ref: nextRef() });
    expect(await gw.readBalance(dave, before)).toBe(balanceBefore);
    expect(await gw.readBalance(dave)).toBe(balanceBefore + 7n * ONE);
    expect(await gw.readTotalSupply(before)).toBe(supplyBefore);
    expect(await gw.readCompliance(dave, before)).toEqual({ verified: true, frozen: false });
    expect(await gw.readCompliance(dave)).toEqual({ verified: true, frozen: true });
    await expect(gw.readBalance(dave, before + 1000n)).rejects.toBeInstanceOf(ChainError);
    await sendOk({ kind: 'setFrozen', account: dave, frozen: false, ref: nextRef() });
  });
});

describe('ViemChainGateway on anvil: reverts', () => {
  it('a reused reference is mined, reverted, decoded as ReferenceAlreadyUsed, and consumes the nonce', async () => {
    const r = nextRef();
    await sendOk({ kind: 'mint', to: alice, amount: ONE, ref: r });
    const nonceBefore = await gw.getNonce('settlement');
    const supply = await gw.readTotalSupply();
    const hash = await send({ kind: 'mint', to: alice, amount: ONE, ref: r });
    const receipt = await waitForReceipt(gw, hash);
    expect(receipt).toMatchObject({ status: 'reverted', revertReason: 'ReferenceAlreadyUsed' });
    expect(await gw.getNonce('settlement')).toEqual({
      confirmed: nonceBefore.confirmed + 1,
      pending: nonceBefore.pending + 1,
    });
    expect(await gw.readTotalSupply()).toBe(supply);
    expect(
      await gw.getEvents({ fromBlock: receipt!.blockNumber, toBlock: receipt!.blockNumber }),
    ).toEqual([]);
  });

  it('decodes NotAllowed, ZeroAmount, InvalidReference, ZeroAddress, ERC20InsufficientBalance, EnforcedPause', async () => {
    const reason = async (call: ContractCall) =>
      (await waitForReceipt(gw, await send(call)))?.revertReason;
    expect(
      await reason({ kind: 'mint', to: devAddress('deployer'), amount: ONE, ref: nextRef() }),
    ).toBe('NotAllowed');
    expect(await reason({ kind: 'mint', to: alice, amount: 0n, ref: nextRef() })).toBe(
      'ZeroAmount',
    );
    expect(await reason({ kind: 'burn', from: alice, amount: ONE, ref: ref(0) })).toBe(
      'InvalidReference',
    );
    expect(
      await reason({ kind: 'setVerified', account: ZERO_ADDRESS, verified: true, ref: nextRef() }),
    ).toBe('ZeroAddress');
    expect(await reason({ kind: 'burn', from: alice, amount: 10_000n * ONE, ref: nextRef() })).toBe(
      'ERC20InsufficientBalance',
    );
    await setPausedOnChain(node, deployment, true);
    expect(await reason({ kind: 'mint', to: alice, amount: ONE, ref: nextRef() })).toBe(
      'EnforcedPause',
    );
    await setPausedOnChain(node, deployment, false);
  });

  it('a revert with no data (out of gas) has no revertReason', async () => {
    const tight = gatewayFor(node, deployment, { gasLimit: 30_000n });
    const hash = await send({ kind: 'mint', to: alice, amount: ONE, ref: nextRef() }, FEES, tight);
    const receipt = await waitForReceipt(tight, hash);
    expect(receipt?.status).toBe('reverted');
    expect(receipt?.revertReason).toBeUndefined();
  });
});

describe('ViemChainGateway on anvil: submission errors', () => {
  it('rejects a call for the wrong signer before touching the node', async () => {
    const { pending } = await gw.getNonce('settlement');
    await expect(
      gw.submit({
        signer: 'compliance',
        call: { kind: 'mint', to: alice, amount: ONE, ref: nextRef() },
        nonce: pending,
        fees: FEES,
      }),
    ).rejects.toBeInstanceOf(SubmissionRejectedError);
    await expect(
      gw.submit({
        signer: 'settlement',
        call: { kind: 'setVerified', account: alice, verified: true, ref: nextRef() },
        nonce: pending,
        fees: FEES,
      }),
    ).rejects.toThrow(/must be sent by the compliance signer/);
    expect((await gw.getNonce('settlement')).pending).toBe(pending);
  });

  it('rejects malformed requests locally', async () => {
    const bad = (request: unknown) =>
      expect(gw.submit(request as never)).rejects.toBeInstanceOf(SubmissionRejectedError);
    const mint = { kind: 'mint', to: alice, amount: ONE, ref: ref(1) };
    await bad({ signer: 'settlement', call: { kind: 'nope' }, nonce: 0, fees: FEES });
    await bad({ signer: 'settlement', call: mint, nonce: -1, fees: FEES });
    await bad({
      signer: 'settlement',
      call: mint,
      nonce: 0,
      fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 2n },
    });
    await bad({ signer: 'settlement', call: mint, nonce: 0, fees: undefined });
    await bad({ signer: 'settlement', call: { ...mint, to: '0xnope' }, nonce: 0, fees: FEES });
    await bad({ signer: 'settlement', call: { ...mint, amount: -1n }, nonce: 0, fees: FEES });
    await bad({ signer: 'settlement', call: { ...mint, ref: '0x12' }, nonce: 0, fees: FEES });
  });

  it('NonceTooLowError for a nonce already mined', async () => {
    const { confirmed } = await gw.getNonce('settlement');
    await expect(
      gw.submit({
        signer: 'settlement',
        call: { kind: 'mint', to: alice, amount: ONE, ref: nextRef() },
        nonce: confirmed - 1,
        fees: FEES,
      }),
    ).rejects.toBeInstanceOf(NonceTooLowError);
  });

  it('InsufficientFundsError when the signer cannot pay for gas', async () => {
    await expect(
      send(
        { kind: 'mint', to: alice, amount: ONE, ref: nextRef() },
        { maxFeePerGas: 10n ** 24n, maxPriorityFeePerGas: 1n },
      ),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it('a fee below the base fee is refused by anvil as SubmissionRejectedError', async () => {
    await expect(
      send(
        { kind: 'mint', to: alice, amount: ONE, ref: nextRef() },
        { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      ),
    ).rejects.toThrow(/max fee per gas less than block base fee/);
  });
});

describe('ViemChainGateway on anvil: pool behaviour (automine off)', () => {
  beforeEach(() => automine(false));
  afterEach(async () => {
    await node.rpc('anvil_setNextBlockBaseFeePerGas', [toHex(parseGwei('1'))]);
    await mine();
    await automine(true);
  });

  it('AlreadyKnownError (with the hash) for an identical pending transaction', async () => {
    const { pending } = await gw.getNonce('settlement');
    const request = {
      signer: 'settlement' as const,
      call: { kind: 'mint' as const, to: alice, amount: ONE, ref: nextRef() },
      nonce: pending,
      fees: FEES,
    };
    const hash = await gw.submit(request);
    const error = await gw.submit(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AlreadyKnownError);
    expect((error as AlreadyKnownError).txHash).toBe(hash);
    expect(await gw.getNonce('settlement')).toEqual({ confirmed: pending, pending: pending + 1 });
  });

  it('ReplacementUnderpricedError for the same nonce at the same fees', async () => {
    const { pending } = await gw.getNonce('settlement');
    const call = (r = nextRef()) => ({ kind: 'mint' as const, to: alice, amount: ONE, ref: r });
    await gw.submit({ signer: 'settlement', call: call(), nonce: pending, fees: FEES });
    await expect(
      gw.submit({ signer: 'settlement', call: call(), nonce: pending, fees: FEES }),
    ).rejects.toBeInstanceOf(ReplacementUnderpricedError);
  });

  it("a pending transaction is replaced by a re-fee'd one, which is the one that mines", async () => {
    const { pending } = await gw.getNonce('settlement');
    const call = { kind: 'mint' as const, to: alice, amount: ONE, ref: nextRef() };
    const first = await gw.submit({ signer: 'settlement', call, nonce: pending, fees: FEES });
    expect(await gw.getReceipt(first)).toBeNull();
    expect(await gw.getTransaction(first)).toMatchObject({
      signer: 'settlement',
      nonce: pending,
      fees: FEES,
      blockNumber: null,
    });
    const bigger = {
      maxFeePerGas: FEES.maxFeePerGas * 2n,
      maxPriorityFeePerGas: FEES.maxPriorityFeePerGas * 2n,
    };
    const second = await gw.submit({ signer: 'settlement', call, nonce: pending, fees: bigger });
    expect(second).not.toBe(first);
    await mine();
    expect(await gw.getReceipt(first)).toBeNull();
    expect(await gw.getTransaction(first)).toBeNull();
    const receipt = await gw.getReceipt(second);
    expect(receipt?.status).toBe('success');
    expect((await gw.getTransaction(second))?.blockNumber).toBe(receipt?.blockNumber);
  });

  it('a pending transaction is not mined while the base fee exceeds its max fee (anvil then evicts it)', async () => {
    // Anvil differs from geth here: geth keeps such a transaction in its pool until the base fee
    // falls; anvil evicts it when it mines a block it cannot pay for. The fake follows geth (the
    // transaction stays stuck); this test pins down what anvil does so the difference is known.
    const { pending } = await gw.getNonce('settlement');
    const hash = await gw.submit({
      signer: 'settlement',
      call: { kind: 'mint', to: alice, amount: ONE, ref: nextRef() },
      nonce: pending,
      fees: FEES,
    });
    expect((await gw.getTransaction(hash))?.blockNumber).toBeNull();
    await node.rpc('anvil_setNextBlockBaseFeePerGas', [toHex(parseGwei('50'))]);
    await mine();
    expect(await gw.getReceipt(hash)).toBeNull();
    expect(await gw.getTransaction(hash)).toBeNull();
    expect(await gw.getNonce('settlement')).toEqual({ confirmed: pending, pending });
  });

  it('a dropped transaction is forgotten; its nonce is free and can be reused', async () => {
    const { pending } = await gw.getNonce('settlement');
    const r = nextRef();
    const hash = await gw.submit({
      signer: 'settlement',
      call: { kind: 'mint', to: alice, amount: ONE, ref: r },
      nonce: pending,
      fees: FEES,
    });
    await node.rpc('anvil_dropTransaction', [hash]);
    expect(await gw.getTransaction(hash)).toBeNull();
    expect(await gw.getNonce('settlement')).toEqual({ confirmed: pending, pending });
    await mine();
    expect(await gw.getReceipt(hash)).toBeNull();
    const again = await gw.submit({
      signer: 'settlement',
      call: { kind: 'mint', to: alice, amount: ONE, ref: r },
      nonce: pending,
      fees: FEES,
    });
    expect(again).toBe(hash);
    await mine();
    expect((await gw.getReceipt(hash))?.status).toBe('success');
  });
});

describe('ViemChainGateway on anvil: reorg', () => {
  it('after evm_revert the removed block is gone, then replaced by one with a different hash, and its events vanish', async () => {
    const snapshot = await node.rpc<string>('evm_snapshot');
    const hash = await sendOk({ kind: 'mint', to: alice, amount: ONE, ref: nextRef() });
    const receipt = (await gw.getReceipt(hash))!;
    const height = receipt.blockNumber;
    expect(await gw.getEvents({ fromBlock: height, toBlock: height })).toHaveLength(2);

    await node.rpc('evm_revert', [snapshot]);
    expect(await gw.getHeadBlock()).toBe(height - 1n);
    expect(await gw.getBlock(height)).toBeNull();
    expect(await gw.getReceipt(hash)).toBeNull();
    expect(await gw.getEvents({ fromBlock: height, toBlock: height })).toEqual([]);

    await mine();
    const replacement = await gw.getBlock(height);
    expect(replacement).not.toBeNull();
    expect(replacement?.hash).not.toBe(receipt.blockHash);
    expect(await gw.getEvents({ fromBlock: height, toBlock: height })).toEqual([]);
  });
});

describe('ViemChainGateway: refusals and transport failures', () => {
  it('refuses to operate when the node reports a different chain id, sending nothing', async () => {
    const wrong = gatewayFor(node, deployment, { chainId: 1 });
    expect(await wrong.getChainId()).toBe(31337); // diagnostic only
    const { pending } = await gw.getNonce('settlement');
    const error = await wrong
      .submit({
        signer: 'settlement',
        call: { kind: 'mint', to: alice, amount: ONE, ref: nextRef() },
        nonce: pending,
        fees: FEES,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainIdMismatchError);
    expect((error as Error).message).toMatch(/configured for 1, but the node reports 31337/);
    await expect(wrong.getHeadBlock()).rejects.toBeInstanceOf(ChainIdMismatchError);
    await expect(wrong.readBalance(alice)).rejects.toBeInstanceOf(ChainIdMismatchError);
    expect((await gw.getNonce('settlement')).pending).toBe(pending);
  });

  it('ChainUnavailableError against a closed port, for reads and for submit', async () => {
    const port = await freePort();
    const dead = new ViemChainGateway({
      rpcUrl: `http://127.0.0.1:${port}`,
      chainId: 31337,
      registryAddress: deployment.registry,
      tokenAddress: deployment.token,
      signers: { settlement: devAccount(1), compliance: devAccount(2) },
      timeoutMs: 2_000,
    });
    await expect(dead.getChainId()).rejects.toBeInstanceOf(ChainUnavailableError);
    await expect(dead.getHeadBlock()).rejects.toBeInstanceOf(ChainUnavailableError);
    await expect(
      dead.submit({
        signer: 'settlement',
        call: { kind: 'mint', to: alice, amount: ONE, ref: nextRef() },
        nonce: 0,
        fees: FEES,
      }),
    ).rejects.toBeInstanceOf(ChainUnavailableError);
  });

  it('no error message, stack or cause ever contains key material', async () => {
    const keys = [devPrivateKeyHex(DEV_ROLES.settlement), devPrivateKeyHex(DEV_ROLES.compliance)];
    const keyed = new ViemChainGateway({
      rpcUrl: node.url,
      chainId: 31337,
      registryAddress: deployment.registry,
      tokenAddress: deployment.token,
      signers: { settlement: `0x${keys[0]}`, compliance: `0x${keys[1]}` },
    });
    const port = await freePort();
    const dead = new ViemChainGateway({
      rpcUrl: `http://127.0.0.1:${port}`,
      chainId: 31337,
      registryAddress: deployment.registry,
      tokenAddress: deployment.token,
      signers: { settlement: `0x${keys[0]}`, compliance: `0x${keys[1]}` },
    });
    const wrongChain = new ViemChainGateway({
      rpcUrl: node.url,
      chainId: 5,
      registryAddress: deployment.registry,
      tokenAddress: deployment.token,
      signers: { settlement: `0x${keys[0]}`, compliance: `0x${keys[1]}` },
    });
    const { confirmed } = await keyed.getNonce('settlement');
    const mint = (nonce: number, fees = FEES) => ({
      signer: 'settlement' as const,
      call: { kind: 'mint' as const, to: alice, amount: ONE, ref: nextRef() },
      nonce,
      fees,
    });
    const failures = await Promise.all(
      [
        keyed.submit(mint(confirmed - 1)),
        keyed.submit({ ...mint(confirmed), signer: 'compliance' }),
        keyed.submit(mint(confirmed, { maxFeePerGas: 10n ** 24n, maxPriorityFeePerGas: 1n })),
        keyed.submit(mint(confirmed, { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })),
        dead.submit(mint(0)),
        wrongChain.submit(mint(0)),
      ].map((p) =>
        p.then(
          () => new Error('unexpected success'),
          (e: unknown) => e as Error,
        ),
      ),
    );
    const seen = (error: unknown, depth = 0): string => {
      if (!(error instanceof Error) || depth > 8) return String(error);
      const own = Object.entries(error)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? '' : String(v)}`)
        .join(' ');
      return `${error.message} ${error.stack ?? ''} ${own} ${seen(error.cause, depth + 1)}`;
    };
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(ChainError);
      const text = seen(failure).toLowerCase();
      for (const key of keys) expect(text).not.toContain(key.toLowerCase());
    }
    const inspected = `${JSON.stringify(keyed)} ${inspect(keyed, { depth: 5 })}`;
    for (const key of keys) expect(inspected).not.toContain(key);
  });
});

describe('ViemChainGateway on anvil: lookups', () => {
  it('getTransaction and getReceipt return null for an unknown hash', async () => {
    const unknown = `0x${'ab'.repeat(32)}` as TxHash;
    expect(await gw.getTransaction(unknown)).toBeNull();
    expect(await gw.getReceipt(unknown)).toBeNull();
  });

  it('getTransaction reports a mined bridge transaction with its signer and fees', async () => {
    const hash = await sendOk({ kind: 'setFrozen', account: carol, frozen: false, ref: nextRef() });
    const info = await gw.getTransaction(hash);
    expect(info).toMatchObject({ hash, signer: 'compliance', fees: FEES });
    expect(info?.blockNumber).toBe((await gw.getReceipt(hash))?.blockNumber);
    expect(carol as Address).toBe(devAddress('carol'));
  });
});
