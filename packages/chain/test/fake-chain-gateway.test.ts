/**
 * Unit tests for the in-memory chain: every contract rule, every node rule, and every test
 * control. The fake is what every other package's tests trust, so it is tested exhaustively.
 */

import { hexToString, keccak256, parseGwei, stringToHex } from 'viem';

import {
  AlreadyKnownError,
  ChainError,
  ChainUnavailableError,
  FakeChainGateway,
  InsufficientFundsError,
  NonceTooLowError,
  ReplacementUnderpricedError,
  SubmissionRejectedError,
  TOKEN_DECIMALS,
  type Address,
  type ContractCall,
  type Fees,
  type SignerName,
  type SubmitRequest,
  type TxHash,
} from '../src';
import { ZERO_ADDRESS, ZERO_REF, ref } from './support/refs';

const ONE = 10n ** BigInt(TOKEN_DECIMALS);
const alice = '0x00000000000000000000000000000000000a11ce' as Address;
const bob = '0x0000000000000000000000000000000000000b0b' as Address;
const carol = '0x00000000000000000000000000000000000ca201' as Address;
const dave = '0x0000000000000000000000000000000000000da5' as Address;
const FEES: Fees = { maxFeePerGas: parseGwei('10'), maxPriorityFeePerGas: parseGwei('1') };

/** A small driver that owns nonces and references, like the engine will. */
class Driver {
  private refCounter = 1000;
  constructor(readonly chain: FakeChainGateway) {}

  nextRef() {
    return ref(++this.refCounter);
  }

  async send(call: ContractCall, fees: Fees = FEES): Promise<TxHash> {
    const signer: SignerName =
      call.kind === 'setVerified' || call.kind === 'setFrozen' ? 'compliance' : 'settlement';
    const { pending } = await this.chain.getNonce(signer);
    return this.chain.submit({ signer, call, nonce: pending, fees });
  }

  async status(hash: TxHash) {
    const receipt = await this.chain.getReceipt(hash);
    return receipt ? { status: receipt.status, reason: receipt.revertReason } : null;
  }

  verify(account: Address, verified = true) {
    return this.send({ kind: 'setVerified', account, verified, ref: this.nextRef() });
  }

  freeze(account: Address, frozen = true) {
    return this.send({ kind: 'setFrozen', account, frozen, ref: this.nextRef() });
  }

  mint(to: Address, amount: bigint, r = this.nextRef()) {
    return this.send({ kind: 'mint', to, amount, ref: r });
  }

  burn(from: Address, amount: bigint, r = this.nextRef()) {
    return this.send({ kind: 'burn', from, amount, ref: r });
  }

  settle(from: Address, to: Address, amount: bigint, r = this.nextRef()) {
    return this.send({ kind: 'settleTransfer', from, to, amount, ref: r });
  }
}

function setup(options: ConstructorParameters<typeof FakeChainGateway>[0] = {}) {
  const chain = new FakeChainGateway(options);
  return { chain, d: new Driver(chain) };
}

function mintRequest(nonce: number, fees: Fees = FEES, r = ref(1), amount = ONE): SubmitRequest {
  return { signer: 'settlement', call: { kind: 'mint', to: alice, amount, ref: r }, nonce, fees };
}

function scale(fees: Fees, num: bigint, den: bigint): Fees {
  return {
    maxFeePerGas: (fees.maxFeePerGas * num) / den,
    maxPriorityFeePerGas: (fees.maxPriorityFeePerGas * num) / den,
  };
}

describe('FakeChainGateway: identity and defaults', () => {
  it('starts at block 0 with a genesis block and reports its configuration', async () => {
    const chain = new FakeChainGateway();
    expect(await chain.getChainId()).toBe(31337);
    expect(await chain.getHeadBlock()).toBe(0n);
    const genesis = await chain.getBlock(0n);
    expect(genesis).toMatchObject({ number: 0n, timestamp: 1_700_000_000n });
    expect(genesis?.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(genesis?.parentHash).toBe(`0x${'0'.repeat(64)}`);
    expect(await chain.getBlock(1n)).toBeNull();
    expect(await chain.getBlock(-1n)).toBeNull();
    expect(chain.signerAddress('settlement')).toMatch(/^0x[0-9a-f]{40}$/);
    expect(chain.signerAddress('settlement')).not.toBe(chain.signerAddress('compliance'));
    expect(chain.registryAddress).not.toBe(chain.tokenAddress);
    expect(TOKEN_DECIMALS).toBe(6);
    expect(chain.baseFee).toBe(parseGwei('1'));
  });

  it('lowercases configured addresses and honours options', async () => {
    const chain = new FakeChainGateway({
      chainId: 5,
      registryAddress: '0x00000000000000000000000000000000000000AA',
      tokenAddress: '0x00000000000000000000000000000000000000BB',
      signers: { settlement: '0x00000000000000000000000000000000000000CC' },
      baseFee: 7n,
      priorityFee: 3n,
      genesisTimestamp: 100n,
      blockTimeSeconds: 2n,
    });
    expect(await chain.getChainId()).toBe(5);
    expect(chain.registryAddress).toBe('0x00000000000000000000000000000000000000aa');
    expect(chain.tokenAddress).toBe('0x00000000000000000000000000000000000000bb');
    expect(chain.signerAddress('settlement')).toBe('0x00000000000000000000000000000000000000cc');
    expect(await chain.estimateFees()).toEqual({ maxFeePerGas: 17n, maxPriorityFeePerGas: 3n });
    chain.mine();
    expect((await chain.getBlock(1n))?.timestamp).toBe(102n);
  });

  it('rejects an unknown signer name', async () => {
    const chain = new FakeChainGateway();
    expect(() => chain.signerAddress('nobody' as SignerName)).toThrow(ChainError);
    await expect(chain.getNonce('nobody' as SignerName)).rejects.toThrow(ChainError);
    expect(() => chain.setSignerBalance('nobody' as SignerName, 1n)).toThrow(ChainError);
  });

  it('is deterministic: two chains given the same inputs produce the same hashes', async () => {
    const a = setup();
    const b = setup();
    const ha = await a.d.verify(alice);
    const hb = await b.d.verify(alice);
    expect(ha).toBe(hb);
    expect((await a.chain.getBlock(1n))?.hash).toBe((await b.chain.getBlock(1n))?.hash);
  });
});

describe('FakeChainGateway: registry rules', () => {
  it('sets and clears verification, emits VerificationSet, and only the compliance signer may', async () => {
    const { chain, d } = setup();
    const r = d.nextRef();
    const hash = await d.send({ kind: 'setVerified', account: alice, verified: true, ref: r });
    expect(await d.status(hash)).toEqual({ status: 'success', reason: undefined });
    expect(chain.complianceOf(alice)).toEqual({ verified: true, frozen: false });
    expect(chain.registryReferenceUsed(r)).toBe(true);
    expect(chain.tokenReferenceUsed(r)).toBe(false);
    const events = await chain.getEvents({ fromBlock: 0n, toBlock: 10n });
    expect(events).toEqual([
      expect.objectContaining({ kind: 'VerificationSet', account: alice, verified: true, ref: r }),
    ]);

    await d.verify(alice, false);
    expect(await chain.readCompliance(alice)).toEqual({ verified: false, frozen: false });
  });

  it('sets and clears the freeze flag and emits FrozenSet', async () => {
    const { chain, d } = setup();
    await d.freeze(alice);
    expect(chain.complianceOf(alice).frozen).toBe(true);
    await d.freeze(alice, false);
    expect(chain.complianceOf(alice).frozen).toBe(false);
    const kinds = (await chain.getEvents({ fromBlock: 0n, toBlock: 99n })).map((e) => e.kind);
    expect(kinds).toEqual(['FrozenSet', 'FrozenSet']);
  });

  it('rejects the zero reference, a reused reference and the zero address, consuming nothing', async () => {
    const { chain, d } = setup();
    const zero = await d.send({
      kind: 'setVerified',
      account: alice,
      verified: true,
      ref: ZERO_REF,
    });
    expect(await d.status(zero)).toEqual({ status: 'reverted', reason: 'InvalidReference' });

    const r = d.nextRef();
    await d.send({ kind: 'setVerified', account: alice, verified: true, ref: r });
    const again = await d.send({ kind: 'setFrozen', account: bob, frozen: true, ref: r });
    expect(await d.status(again)).toEqual({ status: 'reverted', reason: 'ReferenceAlreadyUsed' });
    expect(chain.complianceOf(bob).frozen).toBe(false);

    const r2 = d.nextRef();
    const toZero = await d.send({
      kind: 'setFrozen',
      account: ZERO_ADDRESS,
      frozen: true,
      ref: r2,
    });
    expect(await d.status(toZero)).toEqual({ status: 'reverted', reason: 'ZeroAddress' });
    expect(chain.registryReferenceUsed(r2)).toBe(false);
    const toZero2 = await d.send({
      kind: 'setVerified',
      account: ZERO_ADDRESS,
      verified: true,
      ref: r2,
    });
    expect(await d.status(toZero2)).toEqual({ status: 'reverted', reason: 'ZeroAddress' });
  });

  it('keeps the registry and token reference sets separate, as the contracts do', async () => {
    const { chain, d } = setup();
    const r = d.nextRef();
    await d.send({ kind: 'setVerified', account: alice, verified: true, ref: r });
    const mint = await d.mint(alice, ONE, r);
    expect(await d.status(mint)).toEqual({ status: 'success', reason: undefined });
    expect(chain.tokenReferenceUsed(r)).toBe(true);
    expect(chain.registryReferenceUsed(r)).toBe(true);
  });
});

describe('FakeChainGateway: token rules', () => {
  async function verified() {
    const s = setup();
    await s.d.verify(alice);
    await s.d.verify(bob);
    return s;
  }

  it('mints, emitting Transfer then Minted, and grows the supply', async () => {
    const { chain, d } = await verified();
    const r = d.nextRef();
    const hash = await d.mint(alice, 5n * ONE, r);
    expect(chain.balanceOf(alice)).toBe(5n * ONE);
    expect(chain.totalSupply()).toBe(5n * ONE);
    const receipt = await chain.getReceipt(hash);
    const events = await chain.getEvents({
      fromBlock: receipt!.blockNumber,
      toBlock: receipt!.blockNumber,
    });
    expect(events).toEqual([
      {
        kind: 'Transfer',
        from: ZERO_ADDRESS,
        to: alice,
        amount: 5n * ONE,
        blockNumber: receipt!.blockNumber,
        blockHash: receipt!.blockHash,
        txHash: hash,
        logIndex: 0,
      },
      {
        kind: 'Minted',
        to: alice,
        amount: 5n * ONE,
        ref: r,
        blockNumber: receipt!.blockNumber,
        blockHash: receipt!.blockHash,
        txHash: hash,
        logIndex: 1,
      },
    ]);
  });

  it('burns, emitting Transfer then Burned, and shrinks the supply', async () => {
    const { chain, d } = await verified();
    await d.mint(alice, 5n * ONE);
    const hash = await d.burn(alice, 2n * ONE);
    expect(await d.status(hash)).toEqual({ status: 'success', reason: undefined });
    expect(chain.balanceOf(alice)).toBe(3n * ONE);
    expect(chain.totalSupply()).toBe(3n * ONE);
    const events = await chain.getEvents({ fromBlock: 4n, toBlock: 4n });
    expect(events.map((e) => e.kind)).toEqual(['Transfer', 'Burned']);
    expect(events[0]).toMatchObject({ from: alice, to: ZERO_ADDRESS, amount: 2n * ONE });
  });

  it('settles a transfer without changing the supply, emitting Transfer then SettledTransfer', async () => {
    const { chain, d } = await verified();
    await d.mint(alice, 5n * ONE);
    const r = d.nextRef();
    await d.settle(alice, bob, 2n * ONE, r);
    expect(chain.balanceOf(alice)).toBe(3n * ONE);
    expect(chain.balanceOf(bob)).toBe(2n * ONE);
    expect(chain.totalSupply()).toBe(5n * ONE);
    const events = await chain.getEvents({ fromBlock: 4n, toBlock: 4n });
    expect(events).toEqual([
      expect.objectContaining({ kind: 'Transfer', from: alice, to: bob, amount: 2n * ONE }),
      expect.objectContaining({
        kind: 'SettledTransfer',
        from: alice,
        to: bob,
        amount: 2n * ONE,
        ref: r,
      }),
    ]);
  });

  it('checks the reference before the amount, and the amount before reuse', async () => {
    const { d } = await verified();
    expect(await d.status(await d.mint(alice, 0n, ZERO_REF))).toEqual({
      status: 'reverted',
      reason: 'InvalidReference',
    });
    const r = d.nextRef();
    await d.mint(alice, ONE, r);
    expect(await d.status(await d.mint(alice, 0n, r))).toEqual({
      status: 'reverted',
      reason: 'ZeroAmount',
    });
    expect(await d.status(await d.burn(alice, 0n))).toEqual({
      status: 'reverted',
      reason: 'ZeroAmount',
    });
    expect(await d.status(await d.settle(alice, bob, 0n))).toEqual({
      status: 'reverted',
      reason: 'ZeroAmount',
    });
    expect(await d.status(await d.burn(alice, ONE, ZERO_REF))).toEqual({
      status: 'reverted',
      reason: 'InvalidReference',
    });
  });

  it('shares one reference set across mint, burn and settleTransfer', async () => {
    const { chain, d } = await verified();
    await d.mint(alice, 2n * ONE);
    const r = d.nextRef();
    await d.mint(alice, ONE, r);
    expect(await d.status(await d.mint(alice, ONE, r))).toEqual({
      status: 'reverted',
      reason: 'ReferenceAlreadyUsed',
    });
    expect(await d.status(await d.burn(alice, ONE, r))).toEqual({
      status: 'reverted',
      reason: 'ReferenceAlreadyUsed',
    });
    expect(await d.status(await d.settle(alice, bob, ONE, r))).toEqual({
      status: 'reverted',
      reason: 'ReferenceAlreadyUsed',
    });
    expect(chain.balanceOf(alice)).toBe(3n * ONE);
    expect(chain.totalSupply()).toBe(3n * ONE);
  });

  it('a failed operation does not consume its reference, so it can be retried', async () => {
    const { chain, d } = await verified();
    const r = d.nextRef();
    expect(await d.status(await d.mint(carol, ONE, r))).toEqual({
      status: 'reverted',
      reason: 'NotAllowed',
    });
    expect(chain.tokenReferenceUsed(r)).toBe(false);
    expect(await d.status(await d.mint(alice, ONE, r))).toEqual({
      status: 'success',
      reason: undefined,
    });
  });

  it('requires both ends to be allowed on every balance change', async () => {
    const { chain, d } = await verified();
    await d.mint(alice, 3n * ONE);
    // unverified receiver
    expect(await d.status(await d.settle(alice, carol, ONE))).toEqual({
      status: 'reverted',
      reason: 'NotAllowed',
    });
    // unverified sender
    await d.verify(alice, false);
    expect(await d.status(await d.settle(alice, bob, ONE))).toEqual({
      status: 'reverted',
      reason: 'NotAllowed',
    });
    expect(await d.status(await d.burn(alice, ONE))).toEqual({
      status: 'reverted',
      reason: 'NotAllowed',
    });
    expect(chain.balanceOf(alice)).toBe(3n * ONE);
  });

  it('a frozen holder cannot send, receive or be burned from', async () => {
    const { chain, d } = await verified();
    await d.mint(alice, 3n * ONE);
    await d.mint(bob, ONE);
    await d.freeze(alice);
    expect(await d.status(await d.settle(alice, bob, ONE))).toEqual({
      status: 'reverted',
      reason: 'NotAllowed',
    });
    expect(await d.status(await d.settle(bob, alice, ONE))).toEqual({
      status: 'reverted',
      reason: 'NotAllowed',
    });
    expect(await d.status(await d.burn(alice, ONE))).toEqual({
      status: 'reverted',
      reason: 'NotAllowed',
    });
    expect(await d.status(await d.mint(alice, ONE))).toEqual({
      status: 'reverted',
      reason: 'NotAllowed',
    });
    expect(chain.balanceOf(alice)).toBe(3n * ONE);
    await d.freeze(alice, false);
    expect(await d.status(await d.settle(alice, bob, ONE))).toEqual({
      status: 'success',
      reason: undefined,
    });
  });

  it('reverts with ERC20InsufficientBalance beyond the balance', async () => {
    const { d } = await verified();
    await d.mint(alice, ONE);
    expect(await d.status(await d.burn(alice, ONE + 1n))).toEqual({
      status: 'reverted',
      reason: 'ERC20InsufficientBalance',
    });
    expect(await d.status(await d.settle(alice, bob, ONE + 1n))).toEqual({
      status: 'reverted',
      reason: 'ERC20InsufficientBalance',
    });
  });

  it('rejects the zero address as receiver or sender the way OpenZeppelin does', async () => {
    const { d } = await verified();
    await d.mint(alice, ONE);
    expect(await d.status(await d.mint(ZERO_ADDRESS, ONE))).toEqual({
      status: 'reverted',
      reason: 'ERC20InvalidReceiver',
    });
    expect(await d.status(await d.burn(ZERO_ADDRESS, ONE))).toEqual({
      status: 'reverted',
      reason: 'ERC20InvalidSender',
    });
    expect(await d.status(await d.settle(ZERO_ADDRESS, bob, ONE))).toEqual({
      status: 'reverted',
      reason: 'ERC20InvalidSender',
    });
    expect(await d.status(await d.settle(alice, ZERO_ADDRESS, ONE))).toEqual({
      status: 'reverted',
      reason: 'ERC20InvalidReceiver',
    });
  });

  it('panics on supply overflow', async () => {
    const { chain, d } = await verified();
    const max = 2n ** 256n - 1n;
    await d.mint(alice, max);
    expect(await d.status(await d.mint(bob, 1n))).toEqual({ status: 'reverted', reason: 'Panic' });
    expect(chain.totalSupply()).toBe(max);
  });

  it('pause stops every balance change with EnforcedPause; unpause restores it', async () => {
    const { chain, d } = await verified();
    await d.mint(alice, 2n * ONE);
    chain.setHolderTransfersEnabled(true); // so the holder path reaches the pause check
    const pause = chain.setPaused(true);
    expect(await d.status(pause)).toEqual({ status: 'success', reason: undefined });
    expect(chain.isPaused()).toBe(true);
    expect(await d.status(await d.mint(alice, ONE))).toEqual({
      status: 'reverted',
      reason: 'EnforcedPause',
    });
    expect(await d.status(await d.burn(alice, ONE))).toEqual({
      status: 'reverted',
      reason: 'EnforcedPause',
    });
    expect(await d.status(await d.settle(alice, bob, ONE))).toEqual({
      status: 'reverted',
      reason: 'EnforcedPause',
    });
    expect(await d.status(chain.injectTransfer(alice, bob, ONE))).toEqual({
      status: 'reverted',
      reason: 'EnforcedPause',
    });
    // Registry changes are not paused.
    expect(await d.status(await d.freeze(carol))).toEqual({ status: 'success', reason: undefined });
    expect(await d.status(chain.setPaused(true))).toEqual({
      status: 'reverted',
      reason: 'EnforcedPause',
    });
    expect(await d.status(chain.setPaused(false))).toEqual({
      status: 'success',
      reason: undefined,
    });
    expect(await d.status(chain.setPaused(false))).toEqual({
      status: 'reverted',
      reason: 'ExpectedPause',
    });
    expect(await d.status(await d.mint(alice, ONE))).toEqual({
      status: 'success',
      reason: undefined,
    });
    // Pausing emits no bridge event.
    const pauseBlock = (await chain.getReceipt(pause))!.blockNumber;
    expect(await chain.getEvents({ fromBlock: pauseBlock, toBlock: pauseBlock })).toEqual([]);
  });
});

describe('FakeChainGateway: rogue holder transfers', () => {
  it('emits only Transfer, with no reference event, in the next block', async () => {
    const { chain, d } = setup({ automine: false });
    chain.setHolderTransfersEnabled(true);
    await d.verify(alice);
    await d.verify(bob);
    await d.mint(alice, 3n * ONE);
    chain.mine();
    const head = await chain.getHeadBlock();
    const hash = chain.injectTransfer(alice, bob, ONE);
    expect(await chain.getReceipt(hash)).toBeNull();
    expect(chain.mempoolSize()).toBe(1);
    chain.mine();
    const receipt = await chain.getReceipt(hash);
    expect(receipt).toMatchObject({ status: 'success', blockNumber: head + 1n });
    const events = await chain.getEvents({ fromBlock: head + 1n, toBlock: head + 1n });
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'Transfer',
        from: alice,
        to: bob,
        amount: ONE,
        txHash: hash,
      }),
    ]);
    expect(chain.balanceOf(bob)).toBe(ONE);
    // It is not a bridge transaction, so the gateway reports no signer for it.
    expect(await chain.getTransaction(hash)).toBeNull();
  });

  it('is still subject to the token rules', async () => {
    const { chain, d } = setup();
    chain.setHolderTransfersEnabled(true);
    await d.verify(alice);
    await d.mint(alice, ONE);
    expect(await d.status(chain.injectTransfer(alice, carol, ONE))).toEqual({
      status: 'reverted',
      reason: 'NotAllowed',
    });
    expect(await d.status(chain.injectTransfer(alice, ZERO_ADDRESS, ONE))).toEqual({
      status: 'reverted',
      reason: 'ERC20InvalidReceiver',
    });
    expect(await d.status(chain.injectTransfer(ZERO_ADDRESS, alice, ONE))).toEqual({
      status: 'reverted',
      reason: 'ERC20InvalidSender',
    });
    expect(() => chain.injectTransfer('0x12' as Address, alice, ONE)).toThrow(RangeError);
    expect(() => chain.injectTransfer(alice, bob, -1n)).toThrow(RangeError);
  });

  it('two identical rogue transfers get different hashes', () => {
    const { chain } = setup({ automine: false });
    expect(chain.injectTransfer(alice, bob, 1n)).not.toBe(chain.injectTransfer(alice, bob, 1n));
  });
});

describe('FakeChainGateway: holder-signed path (switch, approve, transferFrom, transfer)', () => {
  async function funded() {
    const s = setup();
    await s.d.verify(alice);
    await s.d.verify(bob);
    await s.d.verify(dave);
    await s.d.mint(alice, 10n * ONE);
    return s;
  }

  it('is off after deployment: transfer, approve and transferFrom revert HolderTransfersDisabled first', async () => {
    const { chain, d } = await funded();
    expect(chain.holderTransfersEnabled()).toBe(false);
    // Even with every other check failing too, the switch is reported first.
    chain.setPaused(true);
    for (const hash of [
      chain.injectTransfer(alice, carol, 100n * ONE),
      chain.injectApprove(carol, ZERO_ADDRESS, ONE),
      chain.injectTransferFrom(carol, alice, carol, 100n * ONE),
    ]) {
      expect(await d.status(hash)).toEqual({
        status: 'reverted',
        reason: 'HolderTransfersDisabled',
      });
    }
    expect(chain.balanceOf(alice)).toBe(10n * ONE);
  });

  it('the switch is a mined admin transaction that emits no bridge event and never reverts', async () => {
    const { chain, d } = await funded();
    const on = chain.setHolderTransfersEnabled(true);
    expect(await d.status(on)).toEqual({ status: 'success', reason: undefined });
    expect(await d.status(chain.setHolderTransfersEnabled(true))).toEqual({
      status: 'success',
      reason: undefined,
    });
    const block = (await chain.getReceipt(on))!.blockNumber;
    expect(await chain.getEvents({ fromBlock: block, toBlock: block })).toEqual([]);
    expect(chain.holderTransfersEnabled()).toBe(true);
    chain.setHolderTransfersEnabled(false);
    expect(chain.holderTransfersEnabled()).toBe(false);
  });

  it('mint, burn and settleTransfer ignore the switch', async () => {
    const { chain, d } = await funded();
    expect(chain.holderTransfersEnabled()).toBe(false);
    expect(await d.status(await d.settle(alice, bob, ONE))).toEqual({
      status: 'success',
      reason: undefined,
    });
    expect(await d.status(await d.burn(bob, ONE))).toEqual({
      status: 'success',
      reason: undefined,
    });
    expect(await d.status(await d.mint(bob, ONE))).toEqual({
      status: 'success',
      reason: undefined,
    });
  });

  it('approve: switch, then EnforcedPause, then NotAllowed(owner), then ERC20InvalidSpender', async () => {
    const { chain, d } = await funded();
    chain.setHolderTransfersEnabled(true);
    chain.setPaused(true);
    expect(await d.status(chain.injectApprove(carol, ZERO_ADDRESS, ONE))).toEqual({
      status: 'reverted',
      reason: 'EnforcedPause',
    });
    chain.setPaused(false);
    expect(await d.status(chain.injectApprove(carol, ZERO_ADDRESS, ONE))).toEqual({
      status: 'reverted',
      reason: 'NotAllowed',
    });
    expect(await d.status(chain.injectApprove(alice, ZERO_ADDRESS, ONE))).toEqual({
      status: 'reverted',
      reason: 'ERC20InvalidSpender',
    });
    // The spender is not checked at approve time.
    expect(await d.status(chain.injectApprove(alice, carol, 3n * ONE))).toEqual({
      status: 'success',
      reason: undefined,
    });
    expect(chain.allowance(alice, carol)).toBe(3n * ONE);
    const block = await chain.getHeadBlock();
    expect(await chain.getEvents({ fromBlock: block, toBlock: block })).toEqual([]);
  });

  it('approve of zero (a revocation) is accepted whatever the switch, pause or owner state', async () => {
    const { chain, d } = await funded();
    chain.setHolderTransfersEnabled(true);
    chain.injectApprove(alice, carol, 3n * ONE);
    chain.setHolderTransfersEnabled(false);
    chain.setPaused(true);
    expect(await d.status(chain.injectApprove(alice, carol, 0n))).toEqual({
      status: 'success',
      reason: undefined,
    });
    expect(chain.allowance(alice, carol)).toBe(0n);
    // An unverified owner may also revoke, but a non-zero approval is still refused.
    expect(await d.status(chain.injectApprove(carol, alice, 0n))).toEqual({
      status: 'success',
      reason: undefined,
    });
    expect(await d.status(chain.injectApprove(alice, carol, ONE))).toEqual({
      status: 'reverted',
      reason: 'HolderTransfersDisabled',
    });
    // A zero spender is still invalid.
    expect(await d.status(chain.injectApprove(alice, ZERO_ADDRESS, 0n))).toEqual({
      status: 'reverted',
      reason: 'ERC20InvalidSpender',
    });
  });

  it('transferFrom: switch, then NotAllowed(spender), then allowance, then the transfer checks', async () => {
    const { chain, d } = await funded();
    chain.setHolderTransfersEnabled(true);
    chain.injectApprove(alice, carol, 3n * ONE);
    chain.injectApprove(alice, dave, 3n * ONE);
    // carol (the spender) is not allowed, even though alice and bob are.
    expect(await d.status(chain.injectTransferFrom(carol, alice, bob, ONE))).toEqual({
      status: 'reverted',
      reason: 'NotAllowed',
    });
    // dave is allowed; more than the allowance fails before the receiver is looked at.
    expect(await d.status(chain.injectTransferFrom(dave, alice, carol, 4n * ONE))).toEqual({
      status: 'reverted',
      reason: 'ERC20InsufficientAllowance',
    });
    expect(await d.status(chain.injectTransferFrom(dave, alice, carol, ONE))).toEqual({
      status: 'reverted',
      reason: 'NotAllowed',
    });
    expect(chain.allowance(alice, dave)).toBe(3n * ONE); // a revert spends nothing
    const ok = chain.injectTransferFrom(dave, alice, bob, 2n * ONE);
    expect(await d.status(ok)).toEqual({ status: 'success', reason: undefined });
    expect(chain.allowance(alice, dave)).toBe(ONE);
    expect(chain.balanceOf(bob)).toBe(2n * ONE);
    const block = (await chain.getReceipt(ok))!.blockNumber;
    expect(await chain.getEvents({ fromBlock: block, toBlock: block })).toEqual([
      expect.objectContaining({
        kind: 'Transfer',
        from: alice,
        to: bob,
        amount: 2n * ONE,
        txHash: ok,
      }),
    ]);
    // Paused: transferFrom has no pause check of its own; _update reverts and nothing changes.
    chain.setPaused(true);
    expect(await d.status(chain.injectTransferFrom(dave, alice, bob, ONE))).toEqual({
      status: 'reverted',
      reason: 'EnforcedPause',
    });
    expect(chain.allowance(alice, dave)).toBe(ONE);
  });

  it('an infinite allowance is never decreased; zero owner or receiver follow OpenZeppelin', async () => {
    const { chain, d } = await funded();
    chain.setHolderTransfersEnabled(true);
    const max = 2n ** 256n - 1n;
    chain.injectApprove(alice, dave, max);
    expect(await d.status(chain.injectTransferFrom(dave, alice, bob, ONE))).toMatchObject({
      status: 'success',
    });
    expect(chain.allowance(alice, dave)).toBe(max);
    expect(await d.status(chain.injectTransferFrom(dave, alice, ZERO_ADDRESS, ONE))).toEqual({
      status: 'reverted',
      reason: 'ERC20InvalidReceiver',
    });
    // From the zero address with a zero amount: the allowance check passes, _approve refuses.
    expect(await d.status(chain.injectTransferFrom(dave, ZERO_ADDRESS, bob, 0n))).toEqual({
      status: 'reverted',
      reason: 'ERC20InvalidApprover',
    });
    expect(() => chain.injectApprove('0x12' as Address, bob, 1n)).toThrow(RangeError);
    expect(() => chain.injectTransferFrom(dave, alice, bob, -1n)).toThrow(RangeError);
  });

  it('allowances survive the switch going off and are usable again when it comes back', async () => {
    const { chain, d } = await funded();
    chain.setHolderTransfersEnabled(true);
    chain.injectApprove(alice, dave, 2n * ONE);
    chain.setHolderTransfersEnabled(false);
    expect(await d.status(chain.injectTransferFrom(dave, alice, bob, ONE))).toEqual({
      status: 'reverted',
      reason: 'HolderTransfersDisabled',
    });
    expect(chain.allowance(alice, dave)).toBe(2n * ONE);
    chain.setHolderTransfersEnabled(true);
    expect(await d.status(chain.injectTransferFrom(dave, alice, bob, ONE))).toMatchObject({
      status: 'success',
    });
  });

  it('settleTransfer to the same account reverts SelfTransfer, after the reference and amount checks', async () => {
    const { chain, d } = await funded();
    const used = d.nextRef();
    await d.mint(alice, ONE, used);
    expect(await d.status(await d.settle(alice, alice, ONE, ZERO_REF))).toEqual({
      status: 'reverted',
      reason: 'InvalidReference',
    });
    expect(await d.status(await d.settle(alice, alice, 0n))).toEqual({
      status: 'reverted',
      reason: 'ZeroAmount',
    });
    expect(await d.status(await d.settle(alice, alice, ONE, used))).toEqual({
      status: 'reverted',
      reason: 'ReferenceAlreadyUsed',
    });
    const r = d.nextRef();
    expect(await d.status(await d.settle(alice, alice, ONE, r))).toEqual({
      status: 'reverted',
      reason: 'SelfTransfer',
    });
    expect(chain.tokenReferenceUsed(r)).toBe(false);
    // Before the zero-address and compliance checks too.
    expect(await d.status(await d.settle(ZERO_ADDRESS, ZERO_ADDRESS, ONE))).toEqual({
      status: 'reverted',
      reason: 'SelfTransfer',
    });
    expect(await d.status(await d.settle(carol, carol, ONE))).toEqual({
      status: 'reverted',
      reason: 'SelfTransfer',
    });
  });
});

describe('FakeChainGateway: readReferenceUsed and getNonce at a block', () => {
  it("reads each contract's own reference set, at the head and at past blocks", async () => {
    const { chain, d } = setup();
    const r = d.nextRef();
    await d.send({ kind: 'setVerified', account: alice, verified: true, ref: r }); // block 1
    await d.mint(alice, ONE, r); // block 2: the same ref on the token
    expect(await chain.readReferenceUsed('registry', r)).toBe(true);
    expect(await chain.readReferenceUsed('token', r)).toBe(true);
    expect(await chain.readReferenceUsed('token', r, 1n)).toBe(false);
    expect(await chain.readReferenceUsed('registry', r, 1n)).toBe(true);
    expect(await chain.readReferenceUsed('registry', r, 0n)).toBe(false);
    const upper = `0x${r.slice(2).toUpperCase()}` as typeof r;
    expect(await chain.readReferenceUsed('token', upper)).toBe(true);
    expect(await chain.readReferenceUsed('token', d.nextRef())).toBe(false);
    await expect(chain.readReferenceUsed('token', r, 9n)).rejects.toBeInstanceOf(ChainError);
    await expect(chain.readReferenceUsed('token', '0x12' as typeof r)).rejects.toBeInstanceOf(
      ChainError,
    );
    await expect(chain.readReferenceUsed('vault' as 'token', r)).rejects.toBeInstanceOf(ChainError);
  });

  it('a reverted operation leaves the reference unused', async () => {
    const { chain, d } = setup();
    const r = d.nextRef();
    await d.mint(carol, ONE, r); // carol is not verified
    expect(await chain.readReferenceUsed('token', r)).toBe(false);
  });

  it('getNonce at a block reports what was mined up to and including it, with no pool', async () => {
    const { chain } = setup({ automine: false });
    await chain.submit(mintRequest(0, FEES, ref(1)));
    chain.mine(); // block 1 holds nonce 0
    await chain.submit(mintRequest(1, FEES, ref(2)));
    chain.mine(); // block 2 holds nonce 1
    await chain.submit(mintRequest(2, FEES, ref(3))); // pending
    expect(await chain.getNonce('settlement')).toEqual({ confirmed: 2, pending: 3 });
    expect(await chain.getNonce('settlement', 0n)).toEqual({ confirmed: 0, pending: 0 });
    expect(await chain.getNonce('settlement', 1n)).toEqual({ confirmed: 1, pending: 1 });
    expect(await chain.getNonce('settlement', 2n)).toEqual({ confirmed: 2, pending: 2 });
    expect(await chain.getNonce('compliance', 2n)).toEqual({ confirmed: 0, pending: 0 });
    await expect(chain.getNonce('settlement', 3n)).rejects.toBeInstanceOf(ChainError);
    // A reorg undoes a mined nonce, so a nonce is only final below head - depth + 1.
    chain.reorg({ depth: 1 });
    expect(await chain.getNonce('settlement', 2n)).toEqual({ confirmed: 1, pending: 1 });
  });
});

describe('FakeChainGateway: submission rules', () => {
  it('rejects a call sent with the wrong signer, without consuming anything', async () => {
    const { chain } = setup();
    await expect(chain.submit({ ...mintRequest(0), signer: 'compliance' })).rejects.toBeInstanceOf(
      SubmissionRejectedError,
    );
    await expect(
      chain.submit({
        signer: 'settlement',
        call: { kind: 'setFrozen', account: alice, frozen: true, ref: ref(1) },
        nonce: 0,
        fees: FEES,
      }),
    ).rejects.toThrow(/must be sent by the compliance signer/);
    expect(await chain.getNonce('settlement')).toEqual({ confirmed: 0, pending: 0 });
    expect(await chain.getHeadBlock()).toBe(0n);
  });

  it('rejects malformed requests', async () => {
    const { chain } = setup();
    const bad = async (request: unknown) =>
      expect(chain.submit(request as SubmitRequest)).rejects.toBeInstanceOf(
        SubmissionRejectedError,
      );
    await bad({ signer: 'settlement', call: { kind: 'explode' }, nonce: 0, fees: FEES });
    await bad({ signer: 'settlement', call: undefined, nonce: 0, fees: FEES });
    await bad(mintRequest(-1));
    await bad(mintRequest(1.5));
    await bad(mintRequest(0, { maxFeePerGas: 1n, maxPriorityFeePerGas: 2n }));
    await bad(mintRequest(0, { maxFeePerGas: -1n, maxPriorityFeePerGas: 0n }));
    await bad({ ...mintRequest(0), fees: undefined });
    await bad(mintRequest(0, FEES, '0x1234' as never));
    await bad(mintRequest(0, FEES, ref(1), -1n));
    await bad(mintRequest(0, FEES, ref(1), 2n ** 256n));
    await bad({ ...mintRequest(0), call: { kind: 'mint', to: '0xnope', amount: 1n, ref: ref(1) } });
    await bad({
      ...mintRequest(0),
      call: { kind: 'burn', from: '0xnope', amount: 1n, ref: ref(1) },
    });
    await bad({ ...mintRequest(0), call: { kind: 'burn', from: alice, amount: 'x', ref: ref(1) } });
    await bad({
      ...mintRequest(0),
      call: { kind: 'settleTransfer', from: '0xnope', to: bob, amount: 1n, ref: ref(1) },
    });
    await bad({
      ...mintRequest(0),
      call: { kind: 'settleTransfer', from: alice, to: '0xnope', amount: 1n, ref: ref(1) },
    });
    await bad({
      ...mintRequest(0),
      call: { kind: 'settleTransfer', from: alice, to: bob, amount: -5n, ref: ref(1) },
    });
    const compliance = (call: unknown) => ({ signer: 'compliance', call, nonce: 0, fees: FEES });
    await bad(compliance({ kind: 'setVerified', account: '0xnope', verified: true, ref: ref(1) }));
    await bad(compliance({ kind: 'setVerified', account: alice, verified: 'yes', ref: ref(1) }));
    await bad(compliance({ kind: 'setFrozen', account: '0xnope', frozen: true, ref: ref(1) }));
    await bad(compliance({ kind: 'setFrozen', account: alice, frozen: 1, ref: ref(1) }));
    expect(await chain.getHeadBlock()).toBe(0n);
  });

  it('accepts mixed-case input and stores it lowercase', async () => {
    const { chain, d } = setup();
    const mixed = '0x00000000000000000000000000000000000ABCDE' as Address;
    const upperRef = `0x${'AB'.repeat(32)}` as Address;
    await chain.submit({
      signer: 'compliance',
      call: { kind: 'setVerified', account: mixed, verified: true, ref: upperRef },
      nonce: 0,
      fees: FEES,
    });
    expect(chain.complianceOf(mixed.toLowerCase() as Address).verified).toBe(true);
    expect(chain.registryReferenceUsed(upperRef.toLowerCase() as Address)).toBe(true);
    await d.mint(mixed, ONE);
    expect(await chain.readBalance(mixed)).toBe(ONE);
  });

  it('throws NonceTooLowError for a nonce already mined, including the same transaction again', async () => {
    const { chain } = setup();
    const req = mintRequest(0);
    await chain.submit(req);
    expect(await chain.getNonce('settlement')).toEqual({ confirmed: 1, pending: 1 });
    await expect(chain.submit(req)).rejects.toBeInstanceOf(NonceTooLowError);
    await expect(chain.submit(mintRequest(0, FEES, ref(2)))).rejects.toBeInstanceOf(
      NonceTooLowError,
    );
  });

  it('a reverted transaction is mined: it consumes the nonce and changes nothing', async () => {
    const { chain } = setup();
    const hash = await chain.submit(mintRequest(0)); // alice is not verified
    expect(await chain.getReceipt(hash)).toMatchObject({
      status: 'reverted',
      revertReason: 'NotAllowed',
    });
    expect(await chain.getNonce('settlement')).toEqual({ confirmed: 1, pending: 1 });
    expect(chain.totalSupply()).toBe(0n);
    expect(await chain.getEvents({ fromBlock: 0n, toBlock: 1n })).toEqual([]);
    expect(await chain.getTransaction(hash)).toEqual({
      hash,
      signer: 'settlement',
      nonce: 0,
      fees: FEES,
      blockNumber: 1n,
    });
  });

  it('throws AlreadyKnownError, with the hash, for an identical pending transaction', async () => {
    const { chain } = setup({ automine: false });
    const hash = await chain.submit(mintRequest(0));
    const error = await chain.submit(mintRequest(0)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AlreadyKnownError);
    expect((error as AlreadyKnownError).txHash).toBe(hash);
    expect(chain.mempoolSize()).toBe(1);
  });

  it('throws InsufficientFundsError when gas at maxFeePerGas exceeds the balance', async () => {
    const { chain } = setup({ signerBalance: 300_000n * 100n, gasLimit: 300_000n });
    await expect(
      chain.submit(mintRequest(0, { maxFeePerGas: 101n, maxPriorityFeePerGas: 1n })),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    await expect(
      chain.submit(mintRequest(0, { maxFeePerGas: 100n, maxPriorityFeePerGas: 1n })),
    ).resolves.toMatch(/^0x/);
    chain.setSignerBalance('compliance', 0n);
    await expect(
      chain.submit({
        signer: 'compliance',
        call: { kind: 'setVerified', account: alice, verified: true, ref: ref(1) },
        nonce: 0,
        fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it('hashes are a function of signer, nonce, call and fees', async () => {
    const { chain } = setup({ automine: false });
    const h1 = await chain.submit(mintRequest(0));
    const h2 = await chain.submit(mintRequest(1));
    const h3 = await chain.submit(mintRequest(0, scale(FEES, 2n, 1n)));
    expect(new Set([h1, h2, h3]).size).toBe(3);
    const other = new FakeChainGateway({ automine: false });
    expect(await other.submit(mintRequest(0))).toBe(h1);
  });
});

describe('FakeChainGateway: replacement (same signer and nonce)', () => {
  async function pendingOne() {
    const s = setup({ automine: false });
    const first = await s.chain.submit(mintRequest(0));
    return { ...s, first };
  }

  it('exactly +12.5% on both fee fields replaces the pending transaction', async () => {
    const { chain, first } = await pendingOne();
    const second = await chain.submit(mintRequest(0, scale(FEES, 1125n, 1000n), ref(2)));
    expect(second).not.toBe(first);
    expect(await chain.getTransaction(first)).toBeNull();
    expect(await chain.getTransaction(second)).toMatchObject({ blockNumber: null, nonce: 0 });
    expect(chain.mempoolSize()).toBe(1);
    chain.mine();
    expect(await chain.getReceipt(first)).toBeNull();
    expect((await chain.getReceipt(second))?.blockNumber).toBe(1n);
  });

  it('+12.49% is underpriced', async () => {
    const { chain } = await pendingOne();
    await expect(
      chain.submit(mintRequest(0, scale(FEES, 11249n, 10000n), ref(2))),
    ).rejects.toBeInstanceOf(ReplacementUnderpricedError);
  });

  it('bumping only one fee field is underpriced', async () => {
    const { chain } = await pendingOne();
    await expect(
      chain.submit(
        mintRequest(
          0,
          { maxFeePerGas: FEES.maxFeePerGas * 2n, maxPriorityFeePerGas: FEES.maxPriorityFeePerGas },
          ref(2),
        ),
      ),
    ).rejects.toBeInstanceOf(ReplacementUnderpricedError);
    await expect(
      chain.submit(
        mintRequest(
          0,
          { maxFeePerGas: FEES.maxFeePerGas, maxPriorityFeePerGas: FEES.maxPriorityFeePerGas * 2n },
          ref(2),
        ),
      ),
    ).rejects.toBeInstanceOf(ReplacementUnderpricedError);
  });

  it('the same fees with a different call is underpriced, not already known', async () => {
    const { chain } = await pendingOne();
    await expect(chain.submit(mintRequest(0, FEES, ref(2)))).rejects.toBeInstanceOf(
      ReplacementUnderpricedError,
    );
  });

  it('signers have independent nonce sequences', async () => {
    const { chain } = await pendingOne();
    await chain.submit({
      signer: 'compliance',
      call: { kind: 'setVerified', account: alice, verified: true, ref: ref(1) },
      nonce: 0,
      fees: FEES,
    });
    expect(chain.mempoolSize()).toBe(2);
    expect(await chain.getNonce('compliance')).toEqual({ confirmed: 0, pending: 1 });
  });
});

describe('FakeChainGateway: mempool, automine, fees', () => {
  it('without automine, transactions wait until mine() and pending nonces count them', async () => {
    const { chain } = setup({ automine: false });
    const h0 = await chain.submit(mintRequest(0, FEES, ref(1)));
    const h1 = await chain.submit(mintRequest(1, FEES, ref(2)));
    expect(await chain.getNonce('settlement')).toEqual({ confirmed: 0, pending: 2 });
    expect(await chain.getReceipt(h0)).toBeNull();
    expect(await chain.getTransaction(h0)).toMatchObject({ blockNumber: null });
    expect(chain.mempoolHashes()).toEqual([h0, h1]);
    expect(chain.mine()).toBe(1n);
    expect(await chain.getNonce('settlement')).toEqual({ confirmed: 2, pending: 2 });
    expect((await chain.getReceipt(h1))?.blockNumber).toBe(1n);
    expect(chain.mempoolSize()).toBe(0);
  });

  it('a nonce gap holds later transactions until the gap is filled', async () => {
    const { chain } = setup({ automine: false });
    const later = await chain.submit(mintRequest(1, FEES, ref(2)));
    expect(await chain.getNonce('settlement')).toEqual({ confirmed: 0, pending: 0 });
    chain.mine();
    expect(await chain.getReceipt(later)).toBeNull();
    await chain.submit(mintRequest(0, FEES, ref(1)));
    expect(await chain.getNonce('settlement')).toEqual({ confirmed: 0, pending: 2 });
    chain.mine();
    expect(await chain.getReceipt(later)).not.toBeNull();
  });

  it('mine(n) produces n blocks, empty ones too, with linked hashes and rising timestamps', async () => {
    const { chain } = setup();
    expect(chain.mine(3)).toBe(3n);
    const b1 = await chain.getBlock(1n);
    const b2 = await chain.getBlock(2n);
    expect(b2?.parentHash).toBe(b1?.hash);
    expect(b2!.timestamp - b1!.timestamp).toBe(12n);
    expect(() => chain.mine(0)).toThrow(RangeError);
  });

  it('a transaction below the base fee is stuck until the base fee drops', async () => {
    const { chain } = setup();
    chain.setBaseFee(parseGwei('20'));
    expect((await chain.estimateFees()).maxFeePerGas).toBe(parseGwei('41'));
    const hash = await chain.submit(mintRequest(0)); // maxFee 10 gwei < 20 gwei
    expect(await chain.getReceipt(hash)).toBeNull();
    chain.mine(2);
    expect(await chain.getReceipt(hash)).toBeNull();
    expect(chain.mempoolSize()).toBe(1);
    chain.setBaseFee(parseGwei('10')); // exactly the max fee: includable
    chain.mine();
    expect(await chain.getReceipt(hash)).toMatchObject({ blockNumber: 4n });
    expect(() => chain.setBaseFee(-1n)).toThrow(RangeError);
  });

  it('a stuck transaction can be replaced with higher fees and then mines', async () => {
    const { chain } = setup({ baseFee: parseGwei('20') });
    const stuck = await chain.submit(mintRequest(0));
    const replacement = await chain.submit(mintRequest(0, scale(FEES, 3n, 1n)));
    expect(await chain.getReceipt(replacement)).toMatchObject({ status: 'reverted' }); // alice unverified
    expect(await chain.getTransaction(stuck)).toBeNull();
  });

  it('orders a block by effective tip, highest first, then by arrival', async () => {
    const { chain } = setup({ automine: false });
    const low = await chain.submit({
      signer: 'compliance',
      call: { kind: 'setVerified', account: alice, verified: true, ref: ref(1) },
      nonce: 0,
      fees: { maxFeePerGas: parseGwei('10'), maxPriorityFeePerGas: parseGwei('1') },
    });
    const high = await chain.submit(
      mintRequest(0, { maxFeePerGas: parseGwei('10'), maxPriorityFeePerGas: parseGwei('5') }),
    );
    chain.mine();
    const events = await chain.getEvents({ fromBlock: 1n, toBlock: 1n });
    // The mint ran first (higher tip) and reverted because alice was not yet verified.
    expect(await chain.getReceipt(high)).toMatchObject({
      status: 'reverted',
      revertReason: 'NotAllowed',
    });
    expect(events.map((e) => e.txHash)).toEqual([low]);

    // Equal tips: arrival order. Tip is capped by the fee headroom over the base fee.
    const { chain: c2 } = setup({ automine: false, baseFee: parseGwei('9') });
    const first = await c2.submit({
      signer: 'compliance',
      call: { kind: 'setVerified', account: alice, verified: true, ref: ref(1) },
      nonce: 0,
      fees: { maxFeePerGas: parseGwei('10'), maxPriorityFeePerGas: parseGwei('5') }, // effective tip 1
    });
    const second = await c2.submit(
      mintRequest(0, { maxFeePerGas: parseGwei('10'), maxPriorityFeePerGas: parseGwei('1') }),
    );
    c2.mine();
    expect(await c2.getReceipt(first)).toMatchObject({ status: 'success' });
    expect(await c2.getReceipt(second)).toMatchObject({ status: 'success' });
    expect((await c2.getEvents({ fromBlock: 1n, toBlock: 1n })).map((e) => e.kind)).toEqual([
      'VerificationSet',
      'Transfer',
      'Minted',
    ]);
  });

  it('control transactions run before bridge transactions in a block', async () => {
    const { chain } = setup({ automine: false });
    const mint = await chain.submit(mintRequest(0));
    const pause = chain.setPaused(true);
    chain.mine();
    expect(await chain.getReceipt(pause)).toMatchObject({ status: 'success' });
    expect(await chain.getReceipt(mint)).toMatchObject({
      status: 'reverted',
      revertReason: 'EnforcedPause',
    });
  });

  it('setAutomine toggles mining on submission', async () => {
    const { chain } = setup();
    chain.setAutomine(false);
    await chain.submit(mintRequest(0));
    expect(await chain.getHeadBlock()).toBe(0n);
    chain.setAutomine(true);
    await chain.submit(mintRequest(1, FEES, ref(2)));
    expect(await chain.getHeadBlock()).toBe(1n);
    expect(chain.mempoolSize()).toBe(0);
  });
});

describe('FakeChainGateway: dropped transactions', () => {
  it('the node forgets a dropped transaction; its nonce is free and can be resubmitted', async () => {
    const { chain } = setup({ automine: false });
    const hash = await chain.submit(mintRequest(0));
    expect(chain.dropTransaction(hash)).toBe(true);
    expect(chain.dropTransaction(hash)).toBe(false);
    expect(await chain.getTransaction(hash)).toBeNull();
    expect(await chain.getNonce('settlement')).toEqual({ confirmed: 0, pending: 0 });
    chain.mine();
    expect(await chain.getReceipt(hash)).toBeNull();
    const again = await chain.submit(mintRequest(0));
    expect(again).toBe(hash); // the same transaction is welcome again
    chain.mine();
    expect(await chain.getReceipt(hash)).toMatchObject({ blockNumber: 2n });
  });

  it('a mined transaction cannot be dropped', async () => {
    const { chain } = setup();
    const hash = await chain.submit(mintRequest(0));
    expect(chain.dropTransaction(hash)).toBe(false);
    expect(await chain.getReceipt(hash)).not.toBeNull();
  });
});

describe('FakeChainGateway: reorgs', () => {
  it('removes mined blocks, returns their transactions to the pool, and re-mines them in a new block', async () => {
    const { chain, d } = setup();
    await d.verify(alice);
    const mintHash = await d.mint(alice, ONE); // block 2
    const before = await chain.getReceipt(mintHash);
    const oldBlock2 = await chain.getBlock(2n);
    const oldBlock1 = await chain.getBlock(1n);

    chain.reorg({ depth: 1 });
    expect(await chain.getHeadBlock()).toBe(2n);
    const newBlock2 = await chain.getBlock(2n);
    expect(newBlock2?.hash).not.toBe(oldBlock2?.hash);
    expect(newBlock2?.parentHash).toBe(oldBlock1?.hash);
    expect(await chain.getBlock(1n)).toEqual(oldBlock1);
    expect(await chain.getReceipt(mintHash)).toBeNull();
    expect(await chain.getTransaction(mintHash)).toMatchObject({ blockNumber: null });
    expect(await chain.getEvents({ fromBlock: 2n, toBlock: 2n })).toEqual([]);
    expect(chain.balanceOf(alice)).toBe(0n);
    expect(await chain.getNonce('settlement')).toEqual({ confirmed: 0, pending: 1 });

    // Resubmitting the reorged-out transaction is "already known".
    await expect(
      chain.submit({
        signer: 'settlement',
        call: { kind: 'mint', to: alice, amount: ONE, ref: ref(1002) },
        nonce: 0,
        fees: FEES,
      }),
    ).rejects.toBeInstanceOf(AlreadyKnownError);

    chain.mine();
    const after = await chain.getReceipt(mintHash);
    expect(after?.status).toBe('success');
    expect(after?.blockNumber).toBe(3n);
    expect(after?.blockHash).not.toBe(before?.blockHash);
    expect(chain.balanceOf(alice)).toBe(ONE);
    const events = await chain.getEvents({ fromBlock: 0n, toBlock: 3n });
    expect(events.filter((e) => e.kind === 'Minted')).toEqual([
      expect.objectContaining({ blockNumber: 3n, blockHash: after?.blockHash, txHash: mintHash }),
    ]);
  });

  it('with dropTransactions: true, the removed transactions are forgotten and their nonces freed', async () => {
    const { chain, d } = setup();
    await d.verify(alice);
    const mintHash = await d.mint(alice, ONE);
    chain.reorg({ depth: 2, dropTransactions: true });
    expect(chain.mempoolSize()).toBe(0);
    expect(await chain.getTransaction(mintHash)).toBeNull();
    expect(chain.complianceOf(alice).verified).toBe(false);
    expect(await chain.getNonce('settlement')).toEqual({ confirmed: 0, pending: 0 });
    expect(await chain.getNonce('compliance')).toEqual({ confirmed: 0, pending: 0 });
    chain.mine(3);
    expect(await chain.getReceipt(mintHash)).toBeNull();
  });

  it('with a list, only the listed transactions are dropped', async () => {
    const { chain, d } = setup({ automine: false });
    const v = await d.verify(alice);
    const m = await d.mint(alice, ONE);
    chain.mine();
    chain.reorg({ depth: 1, dropTransactions: [m.toUpperCase().replace('0X', '0x') as TxHash] });
    expect(chain.mempoolHashes()).toEqual([v]);
    chain.mine();
    expect(await chain.getReceipt(v)).toMatchObject({ status: 'success' });
    expect(await chain.getReceipt(m)).toBeNull();
  });

  it('rogue transfers can be reorged out too', async () => {
    const { chain, d } = setup();
    await d.verify(alice);
    await d.verify(bob);
    await d.mint(alice, ONE);
    chain.setHolderTransfersEnabled(true);
    const rogue = chain.injectTransfer(alice, bob, ONE);
    chain.reorg({ depth: 1 });
    expect(await chain.getReceipt(rogue)).toBeNull();
    expect(chain.mempoolSize()).toBe(1);
    chain.mine();
    expect(await chain.getReceipt(rogue)).toMatchObject({ status: 'success' });
  });

  it('replacement blocks get new hashes even when the removed blocks were empty', async () => {
    const { chain } = setup();
    chain.mine(2);
    const old1 = await chain.getBlock(1n);
    const old2 = await chain.getBlock(2n);
    chain.reorg({ depth: 2 });
    const new1 = await chain.getBlock(1n);
    const new2 = await chain.getBlock(2n);
    expect(new1?.hash).not.toBe(old1?.hash);
    expect(new2?.hash).not.toBe(old2?.hash);
    expect(new2?.parentHash).toBe(new1?.hash);
    expect(new1?.parentHash).toBe((await chain.getBlock(0n))?.hash);
  });

  it('rejects an impossible depth', () => {
    const { chain } = setup();
    chain.mine(2);
    expect(() => chain.reorg({ depth: 0 })).toThrow(RangeError);
    expect(() => chain.reorg({ depth: 3 })).toThrow(RangeError);
    expect(() => chain.reorg({ depth: 1.5 })).toThrow(RangeError);
  });
});

describe('FakeChainGateway: historical reads', () => {
  it('reads balances, supply and flags as of any past block', async () => {
    const { chain, d } = setup();
    await d.verify(alice); // 1
    await d.verify(bob); // 2
    await d.mint(alice, 5n * ONE); // 3
    await d.settle(alice, bob, 2n * ONE); // 4
    await d.freeze(bob); // 5
    expect(await chain.readBalance(alice, 2n)).toBe(0n);
    expect(await chain.readBalance(alice, 3n)).toBe(5n * ONE);
    expect(await chain.readBalance(alice, 4n)).toBe(3n * ONE);
    expect(await chain.readBalance(bob)).toBe(2n * ONE);
    expect(await chain.readTotalSupply(2n)).toBe(0n);
    expect(await chain.readTotalSupply()).toBe(5n * ONE);
    expect(await chain.readCompliance(bob, 1n)).toEqual({ verified: false, frozen: false });
    expect(await chain.readCompliance(bob, 4n)).toEqual({ verified: true, frozen: false });
    expect(await chain.readCompliance(bob)).toEqual({ verified: true, frozen: true });
  });

  it('a block beyond the head (or before genesis) is an error', async () => {
    const { chain } = setup();
    await expect(chain.readBalance(alice, 5n)).rejects.toBeInstanceOf(ChainError);
    await expect(chain.readTotalSupply(-1n)).rejects.toThrow(/not in the chain/);
    await expect(chain.readCompliance(alice, 1n)).rejects.toBeInstanceOf(ChainError);
  });

  it('getEvents clamps the range to the chain and returns nothing for an empty range', async () => {
    const { chain, d } = setup();
    await d.verify(alice);
    expect(await chain.getEvents({ fromBlock: -5n, toBlock: 100n })).toHaveLength(1);
    expect(await chain.getEvents({ fromBlock: 2n, toBlock: 1n })).toEqual([]);
    expect(await chain.getEvents({ fromBlock: 50n, toBlock: 100n })).toEqual([]);
  });

  it('logIndex counts across the transactions of a block', async () => {
    const { chain, d } = setup({ automine: false });
    await d.verify(alice);
    await d.mint(alice, ONE);
    chain.mine();
    const events = await chain.getEvents({ fromBlock: 1n, toBlock: 1n });
    expect(events.map((e) => [e.kind, e.logIndex])).toEqual([
      ['VerificationSet', 0],
      ['Transfer', 1],
      ['Minted', 2],
    ]);
  });
});

describe('FakeChainGateway: failure controls', () => {
  it('setUnavailable makes every gateway call throw ChainUnavailableError, then recovers', async () => {
    const { chain } = setup();
    chain.setUnavailable(true);
    const calls: Array<() => Promise<unknown>> = [
      () => chain.getChainId(),
      () => chain.getHeadBlock(),
      () => chain.getBlock(0n),
      () => chain.getNonce('settlement'),
      () => chain.estimateFees(),
      () => chain.submit(mintRequest(0)),
      () => chain.getReceipt(`0x${'1'.repeat(64)}`),
      () => chain.getTransaction(`0x${'1'.repeat(64)}`),
      () => chain.getEvents({ fromBlock: 0n, toBlock: 0n }),
      () => chain.readBalance(alice),
      () => chain.readTotalSupply(),
      () => chain.readCompliance(alice),
    ];
    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(ChainUnavailableError);
    // Controls and accessors still work.
    chain.mine();
    expect(chain.totalSupply()).toBe(0n);
    expect(chain.signerAddress('settlement')).toMatch(/^0x/);
    chain.setUnavailable(false);
    expect(await chain.getHeadBlock()).toBe(1n);
  });

  it('failNextSubmit throws once without accepting anything', async () => {
    const { chain } = setup();
    chain.failNextSubmit(new ChainUnavailableError('timeout'));
    await expect(chain.submit(mintRequest(0))).rejects.toThrow('timeout');
    expect(await chain.getHeadBlock()).toBe(0n);
    expect(chain.mempoolSize()).toBe(0);
    await expect(chain.submit(mintRequest(0))).resolves.toMatch(/^0x/);
  });

  it('failNextSubmit with accept: the transaction lands even though the caller saw an error', async () => {
    const { chain } = setup({ automine: false });
    chain.failNextSubmit(new ChainUnavailableError('lost the answer'), { accept: true });
    await expect(chain.submit(mintRequest(0))).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(chain.mempoolSize()).toBe(1);
    // Resubmitting the same transaction tells the caller it is already known.
    await expect(chain.submit(mintRequest(0))).rejects.toBeInstanceOf(AlreadyKnownError);
  });

  it('failNextSubmit with accept still applies the node rules first', async () => {
    const { chain } = setup();
    chain.failNextSubmit(new ChainUnavailableError('x'), { accept: true });
    await expect(chain.submit({ ...mintRequest(0), signer: 'compliance' })).rejects.toBeInstanceOf(
      SubmissionRejectedError,
    );
  });

  it('receipts and transaction lookups for unknown hashes return null', async () => {
    const { chain } = setup();
    expect(await chain.getReceipt(`0x${'2'.repeat(64)}`)).toBeNull();
    expect(await chain.getTransaction(`0x${'2'.repeat(64)}`)).toBeNull();
  });
});

describe('FakeChainGateway: signTransaction and sendRaw', () => {
  it('signing consumes nothing, sends nothing, is deterministic and hash = keccak256(raw)', async () => {
    const { chain } = setup({ automine: false });
    const a = await chain.signTransaction(mintRequest(0));
    const b = await chain.signTransaction(mintRequest(0));
    expect(b).toEqual(a);
    expect(a.hash).toBe(keccak256(a.raw));
    // Key order in the request does not matter.
    const reordered = await chain.signTransaction({
      fees: { maxPriorityFeePerGas: FEES.maxPriorityFeePerGas, maxFeePerGas: FEES.maxFeePerGas },
      nonce: 0,
      call: { ref: ref(1), amount: ONE, to: alice, kind: 'mint' },
      signer: 'settlement',
    });
    expect(reordered).toEqual(a);
    expect(await chain.getNonce('settlement')).toEqual({ confirmed: 0, pending: 0 });
    expect(chain.mempoolSize()).toBe(0);
    expect(await chain.getHeadBlock()).toBe(0n);
    expect(await chain.getTransaction(a.hash)).toBeNull();
    // Different nonce or fees: different bytes.
    expect((await chain.signTransaction(mintRequest(1))).hash).not.toBe(a.hash);
    expect((await chain.signTransaction(mintRequest(0, scale(FEES, 2n, 1n)))).hash).not.toBe(
      a.hash,
    );
  });

  it('the signed hash is the hash submit returns for the same request', async () => {
    const { chain } = setup();
    const signed = await chain.signTransaction(mintRequest(0));
    expect(await new FakeChainGateway().submit(mintRequest(0))).toBe(signed.hash);
  });

  it('signing validates like submit and works while the node is unavailable', async () => {
    const { chain } = setup();
    await expect(
      chain.signTransaction({ ...mintRequest(0), signer: 'compliance' }),
    ).rejects.toBeInstanceOf(SubmissionRejectedError);
    await expect(chain.signTransaction(mintRequest(-1))).rejects.toBeInstanceOf(
      SubmissionRejectedError,
    );
    await expect(
      chain.signTransaction(mintRequest(0, FEES, '0x12' as never)),
    ).rejects.toBeInstanceOf(SubmissionRejectedError);
    chain.setUnavailable(true);
    await expect(chain.signTransaction(mintRequest(0))).resolves.toMatchObject({
      hash: expect.any(String),
    });
    await expect(
      chain.sendRaw((await chain.signTransaction(mintRequest(0))).raw),
    ).rejects.toBeInstanceOf(ChainUnavailableError);
  });

  it('sendRaw mines the signed transaction, and rebroadcasting known bytes returns the hash', async () => {
    const { chain, d } = setup();
    await d.verify(alice);
    const { hash, raw } = await chain.signTransaction(mintRequest(0));
    expect(await chain.sendRaw(raw)).toBe(hash);
    expect(await chain.getReceipt(hash)).toMatchObject({ status: 'success' });
    expect(chain.balanceOf(alice)).toBe(ONE);
    // Already mined: the same bytes again succeed, change nothing, and mine nothing new.
    const head = await chain.getHeadBlock();
    expect(await chain.sendRaw(raw)).toBe(hash);
    expect(await chain.sendRaw(raw.toUpperCase().replace('0X', '0x') as typeof raw)).toBe(hash);
    expect(await chain.getHeadBlock()).toBe(head);
    expect(chain.balanceOf(alice)).toBe(ONE);
    // submit keeps its strict behaviour for the same request.
    await expect(chain.submit(mintRequest(0))).rejects.toBeInstanceOf(NonceTooLowError);
  });

  it('rebroadcasting pooled bytes returns the hash (no AlreadyKnownError)', async () => {
    const { chain } = setup({ automine: false });
    const { hash, raw } = await chain.signTransaction(mintRequest(0));
    expect(await chain.sendRaw(raw)).toBe(hash);
    expect(await chain.sendRaw(raw)).toBe(hash);
    expect(chain.mempoolSize()).toBe(1);
    await expect(chain.submit(mintRequest(0))).rejects.toBeInstanceOf(AlreadyKnownError);
  });

  it('dropped or reorged-out bytes can be rebroadcast exactly', async () => {
    const { chain } = setup({ automine: false });
    const { hash, raw } = await chain.signTransaction(mintRequest(0));
    await chain.sendRaw(raw);
    chain.dropTransaction(hash);
    expect(await chain.getTransaction(hash)).toBeNull();
    expect(await chain.sendRaw(raw)).toBe(hash);
    chain.mine();
    chain.reorg({ depth: 1, dropTransactions: true });
    expect(await chain.getTransaction(hash)).toBeNull();
    expect(await chain.sendRaw(raw)).toBe(hash);
    chain.mine();
    expect(await chain.getReceipt(hash)).not.toBeNull();
  });

  it('other bytes for a used nonce, an underpriced replacement and an unaffordable fee are errors', async () => {
    const { chain } = setup({ automine: false });
    const first = await chain.signTransaction(mintRequest(0));
    await chain.sendRaw(first.raw);
    const sameFees = await chain.signTransaction(mintRequest(0, FEES, ref(2)));
    await expect(chain.sendRaw(sameFees.raw)).rejects.toBeInstanceOf(ReplacementUnderpricedError);
    const rich = await chain.signTransaction(
      mintRequest(1, { maxFeePerGas: 10n ** 30n, maxPriorityFeePerGas: 1n }),
    );
    await expect(chain.sendRaw(rich.raw)).rejects.toBeInstanceOf(InsufficientFundsError);
    chain.mine();
    const other = await chain.signTransaction(mintRequest(0, scale(FEES, 2n, 1n), ref(3)));
    await expect(chain.sendRaw(other.raw)).rejects.toBeInstanceOf(NonceTooLowError);
  });

  it('refuses bytes it cannot decode, bytes for another chain, and an unknown sender', async () => {
    const { chain } = setup();
    const refused = (raw: string) =>
      expect(chain.sendRaw(raw as `0x${string}`)).rejects.toBeInstanceOf(SubmissionRejectedError);
    await refused('0x');
    await refused('0x1234');
    await refused('not hex');
    await refused(stringToHex('fake-eip1559-tx:{not json'));
    const { raw } = await chain.signTransaction(mintRequest(0));
    // Tampered: decodes, but is not the canonical encoding (an extra space).
    await refused(stringToHex(`${hexToString(raw)} `));
    await expect(
      chain.sendRaw(
        (await new FakeChainGateway({ chainId: 5 }).signTransaction(mintRequest(0))).raw,
      ),
    ).rejects.toThrow(/invalid chain id for signer/);
    const stranger = new FakeChainGateway({ signers: { settlement: bob } });
    await expect(
      chain.sendRaw((await stranger.signTransaction(mintRequest(0))).raw),
    ).rejects.toThrow(/invalid sender/);
    expect(await chain.getHeadBlock()).toBe(0n);
  });

  it('failNextSubmit applies to sendRaw too, with and without accept', async () => {
    const { chain } = setup({ automine: false });
    const { hash, raw } = await chain.signTransaction(mintRequest(0));
    chain.failNextSubmit(new ChainUnavailableError('timeout'));
    await expect(chain.sendRaw(raw)).rejects.toThrow('timeout');
    expect(chain.mempoolSize()).toBe(0);
    chain.failNextSubmit(new ChainUnavailableError('lost the answer'), { accept: true });
    await expect(chain.sendRaw(raw)).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(chain.mempoolSize()).toBe(1);
    // The outcome was unknown; rebroadcasting the same bytes settles it safely.
    expect(await chain.sendRaw(raw)).toBe(hash);
  });
});
