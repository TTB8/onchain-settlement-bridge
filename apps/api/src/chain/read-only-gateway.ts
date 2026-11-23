/**
 * @file The API's chain access: read-only, and holding no private key.
 *
 * Why: the API is the internet-facing process. It reserves funds and enqueues calls (database
 * only), reads balances and runs reconciliations (chain reads only); signing is the worker's job.
 * Giving the API the signer keys would let any remote-code bug in the HTTP tier sign mints. So
 * the viem gateway is built with two placeholder accounts that refuse to sign (the gateway
 * requires an account per signer), and is wrapped in `ReadOnlyChainGateway`, which refuses every
 * signing and sending method before it reaches the inner gateway.
 */

import {
  type Address,
  type BlockRange,
  type BlockRef,
  type Bytes32,
  type ChainEvent,
  ChainError,
  type ChainGateway,
  type ComplianceStatus,
  type Deployment,
  type Fees,
  type Hex,
  type Receipt,
  type SignedTransaction,
  type SignerName,
  type SubmitRequest,
  type TransactionInfo,
  type TxHash,
  ViemChainGateway,
} from '@bridge/chain';
import type { ChainSettings } from '@bridge/engine/env';
import { toAccount } from 'viem/accounts';

/** Thrown by every signing or sending method of the read-only gateway. */
export class ReadOnlyGatewayError extends ChainError {
  /** @param method The refused method. */
  constructor(method: string) {
    super(`the API's chain gateway is read-only: ${method} is refused`);
  }
}

/** A `ChainGateway` that delegates reads and refuses to sign, send or name a signer. */
export class ReadOnlyChainGateway implements ChainGateway {
  /** @param inner The gateway reads go to. */
  constructor(private readonly inner: ChainGateway) {}

  /** @inheritdoc */
  getChainId(): Promise<number> {
    return this.inner.getChainId();
  }

  /** @inheritdoc */
  getHeadBlock(): Promise<bigint> {
    return this.inner.getHeadBlock();
  }

  /** @inheritdoc */
  getBlock(number: bigint): Promise<BlockRef | null> {
    return this.inner.getBlock(number);
  }

  /** @inheritdoc */
  deployment(): Deployment {
    return this.inner.deployment();
  }

  /** Refused: the API has no signer. */
  signerAddress(_signer: SignerName): Address {
    throw new ReadOnlyGatewayError('signerAddress');
  }

  /** @inheritdoc */
  getNonce(signer: SignerName, blockNumber?: bigint) {
    return this.inner.getNonce(signer, blockNumber);
  }

  /** @inheritdoc */
  estimateFees(): Promise<Fees> {
    return this.inner.estimateFees();
  }

  /** Refused: the API never sends. */
  submit(_request: SubmitRequest): Promise<TxHash> {
    return Promise.reject(new ReadOnlyGatewayError('submit'));
  }

  /** Refused: the API never signs. */
  signTransaction(_request: SubmitRequest): Promise<SignedTransaction> {
    return Promise.reject(new ReadOnlyGatewayError('signTransaction'));
  }

  /** Refused: the API never sends. */
  sendRaw(_raw: Hex): Promise<TxHash> {
    return Promise.reject(new ReadOnlyGatewayError('sendRaw'));
  }

  /** @inheritdoc */
  getReceipt(hash: TxHash): Promise<Receipt | null> {
    return this.inner.getReceipt(hash);
  }

  /** @inheritdoc */
  getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    return this.inner.getTransaction(hash);
  }

  /** @inheritdoc */
  getEvents(range: BlockRange): Promise<ChainEvent[]> {
    return this.inner.getEvents(range);
  }

  /** @inheritdoc */
  readBalance(holder: Address, blockNumber?: bigint): Promise<bigint> {
    return this.inner.readBalance(holder, blockNumber);
  }

  /** @inheritdoc */
  readTotalSupply(blockNumber?: bigint): Promise<bigint> {
    return this.inner.readTotalSupply(blockNumber);
  }

  /** @inheritdoc */
  readReferenceUsed(
    contract: 'token' | 'registry',
    ref: Bytes32,
    blockNumber?: bigint,
  ): Promise<boolean> {
    return this.inner.readReferenceUsed(contract, ref, blockNumber);
  }

  /** @inheritdoc */
  readCompliance(account: Address, blockNumber?: bigint): Promise<ComplianceStatus> {
    return this.inner.readCompliance(account, blockNumber);
  }
}

/** A viem account that refuses every signature (the zero address; it is never used to sign). */
export function refusingAccount(name: string) {
  const refuse = (): never => {
    throw new ReadOnlyGatewayError(`signing as ${name}`);
  };
  return toAccount({
    address: '0x0000000000000000000000000000000000000000',
    signMessage: async () => refuse(),
    signTransaction: async () => refuse(),
    signTypedData: async () => refuse(),
  });
}

/**
 * The production read-only gateway: viem on `RPC_URL`, no keys.
 *
 * @param chain The validated chain settings.
 */
export function buildReadOnlyGateway(chain: ChainSettings): ReadOnlyChainGateway {
  return new ReadOnlyChainGateway(
    new ViemChainGateway({
      rpcUrl: chain.rpcUrl.reveal(),
      chainId: chain.chainId,
      tokenAddress: chain.tokenAddress,
      registryAddress: chain.registryAddress,
      signers: {
        settlement: refusingAccount('settlement'),
        compliance: refusingAccount('compliance'),
      },
      timeoutMs: chain.rpcTimeoutMs,
    }),
  );
}
