/**
 * @file The real `ChainGateway`: talks to a node over JSON-RPC with viem, signs locally with the
 * two bridge signers, and translates every node and transport failure into the typed `ChainError`
 * subclasses from `errors.ts`.
 *
 * Safety properties:
 * - It refuses to do anything (except report the node's chain id) until it has checked, once, that
 *   the node's chain id is the configured one.
 * - Key material never leaves the account objects: no error message, cause or log line carries a
 *   key. A configured key that cannot be parsed fails with a message that does not echo it.
 * - A call sent with the wrong signer is refused before anything touches the network.
 * - Transactions are sent with a fixed gas limit instead of an estimate, so a call that would
 *   revert is still mined and yields a `reverted` receipt with a decoded reason, exactly like the
 *   fake. (An estimate would refuse it before it reached the chain.)
 */

import {
  BaseError,
  BlockNotFoundError,
  HttpRequestError,
  TimeoutError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  decodeErrorResult,
  decodeEventLog,
  encodeFunctionData,
  http,
  isAddress,
  keccak256,
  type Abi,
  type LocalAccount,
  type Log,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { complianceRegistryAbi, settlementTokenAbi } from './abi';
import {
  AlreadyKnownError,
  ChainError,
  ChainUnavailableError,
  InsufficientFundsError,
  NonceTooLowError,
  ReplacementUnderpricedError,
  SubmissionRejectedError,
} from './errors';
import {
  SIGNER_FOR_CALL,
  type Address,
  type BlockRange,
  type BlockRef,
  type Bytes32,
  type ChainEvent,
  type ChainGateway,
  type ComplianceStatus,
  type ContractCall,
  type Fees,
  type Hex,
  type Receipt,
  type SignerName,
  type SubmitRequest,
  type TransactionInfo,
  type TxHash,
} from './types';

/** The node reports a different chain id than the gateway was configured for. Never retried. */
export class ChainIdMismatchError extends ChainError {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`chain id mismatch: configured for ${expected}, but the node reports ${actual}`);
  }
}

/** A signer: a viem local account, or a `0x` private key that the gateway turns into one. */
export type SignerSecret = LocalAccount | Hex;

/** How to reach the node and who signs. */
export interface ViemChainGatewayOptions {
  rpcUrl: string;
  /** The chain the gateway must be talking to. Checked against the node before the first call. */
  chainId: number;
  registryAddress: Address;
  tokenAddress: Address;
  signers: Record<SignerName, SignerSecret>;
  /** Gas limit for every transaction. Default 300_000, well above what any of the five calls use. */
  gasLimit?: bigint;
  /** Per-request timeout. Default 10 seconds. */
  timeoutMs?: number;
  /**
   * Transport-level retries. Default 0: the caller decides when to retry, because a retried send
   * after a timeout can look like a new submission.
   */
  retryCount?: number;
}

type EventBody = ChainEvent extends infer E
  ? E extends ChainEvent
    ? Omit<E, 'blockNumber' | 'blockHash' | 'txHash' | 'logIndex'>
    : never
  : never;

/** Whether a viem error (or anything in its cause chain) is a transport failure. */
function isTransportError(error: unknown): boolean {
  if (error instanceof HttpRequestError || error instanceof TimeoutError) return true;
  if (error instanceof BaseError) {
    return Boolean(error.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError));
  }
  return false;
}

/** Every `details`/`shortMessage` string in a viem error chain, lowercased, for matching. */
function nodeText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 10; depth += 1) {
    if (current instanceof BaseError) {
      parts.push(current.details ?? '', current.shortMessage ?? '');
    } else if (current instanceof Error) {
      parts.push(current.message);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ').toLowerCase();
}

/** The node's own one-line reason, when viem has one, for an error message. */
function nodeDetails(error: unknown): string {
  return error instanceof BaseError && error.details ? `: ${error.details}` : '';
}

/** The revert data carried by a failed `eth_call`, if any. */
function revertData(error: unknown): Hex | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const found = error.walk((e) => {
    const data = (e as { data?: unknown }).data;
    return typeof data === 'string' && data.startsWith('0x');
  }) as { data?: Hex } | null;
  return found?.data;
}

/**
 * Maps a failure of `eth_sendRawTransaction` to the typed errors. `hash` is the hash the signed
 * transaction would have, reported with `AlreadyKnownError`.
 */
export function mapSubmitError(error: unknown, hash?: TxHash): ChainError {
  if (error instanceof ChainError) return error;
  if (isTransportError(error)) {
    return new ChainUnavailableError(
      'submit: the node did not answer; the outcome is unknown',
      error,
    );
  }
  const text = nodeText(error);
  if (text.includes('nonce too low')) return new NonceTooLowError('submit: nonce too low', error);
  if (
    text.includes('already known') ||
    text.includes('already imported') ||
    text.includes('known transaction')
  ) {
    return new AlreadyKnownError('submit: the node already holds this transaction', hash, error);
  }
  if (text.includes('replacement') && text.includes('underpriced')) {
    return new ReplacementUnderpricedError('submit: replacement transaction underpriced', error);
  }
  if (text.includes('insufficient funds')) {
    return new InsufficientFundsError('submit: insufficient funds for gas', error);
  }
  return new SubmissionRejectedError(`submit: rejected by the node${nodeDetails(error)}`, error);
}

/** Lowercases an address. */
function lower(address: string): Address {
  return address.toLowerCase() as Address;
}

/** A `ChainGateway` for a real node, built on viem. */
export class ViemChainGateway implements ChainGateway {
  private readonly client: PublicClient;
  private readonly chainId: number;
  private readonly registry: Address;
  private readonly token: Address;
  private readonly gasLimit: bigint;
  readonly #accounts: Record<SignerName, LocalAccount>;
  private chainCheck: Promise<void> | undefined;

  constructor(options: ViemChainGatewayOptions) {
    if (!Number.isSafeInteger(options.chainId) || options.chainId <= 0) {
      throw new ChainError('invalid chainId');
    }
    if (!isAddress(options.registryAddress, { strict: false })) {
      throw new ChainError('invalid registryAddress');
    }
    if (!isAddress(options.tokenAddress, { strict: false })) {
      throw new ChainError('invalid tokenAddress');
    }
    this.chainId = options.chainId;
    this.registry = lower(options.registryAddress);
    this.token = lower(options.tokenAddress);
    this.gasLimit = options.gasLimit ?? 300_000n;
    this.#accounts = {
      settlement: ViemChainGateway.toAccount('settlement', options.signers?.settlement),
      compliance: ViemChainGateway.toAccount('compliance', options.signers?.compliance),
    };
    this.client = createPublicClient({
      transport: http(options.rpcUrl, {
        timeout: options.timeoutMs ?? 10_000,
        retryCount: options.retryCount ?? 0,
      }),
    });
  }

  /** Turns a configured signer into a local account without ever echoing a key. */
  private static toAccount(name: SignerName, secret: SignerSecret | undefined): LocalAccount {
    if (typeof secret === 'string') {
      try {
        return privateKeyToAccount(secret);
      } catch {
        // Deliberately no cause: the underlying error could quote the input.
        throw new ChainError(`the ${name} signer's key is not a valid private key`);
      }
    }
    if (secret && typeof secret === 'object' && typeof secret.signTransaction === 'function') {
      return secret;
    }
    throw new ChainError(`the ${name} signer must be a local account or a private key`);
  }

  /** Keeps any key-bearing account out of `console.log`/`util.inspect` and JSON output. */
  toJSON(): Record<string, unknown> {
    return {
      chainId: this.chainId,
      registry: this.registry,
      token: this.token,
      signers: {
        settlement: this.signerAddress('settlement'),
        compliance: this.signerAddress('compliance'),
      },
    };
  }

  // --- ChainGateway --------------------------------------------------------------------------

  async getChainId(): Promise<number> {
    return this.run('getChainId', () => this.client.getChainId(), false);
  }

  async getHeadBlock(): Promise<bigint> {
    return this.run('getHeadBlock', () => this.client.getBlockNumber({ cacheTime: 0 }));
  }

  async getBlock(number: bigint): Promise<BlockRef | null> {
    if (number < 0n) return null;
    return this.run('getBlock', async () => {
      try {
        const block = await this.client.getBlock({ blockNumber: number });
        return {
          number: block.number,
          hash: block.hash.toLowerCase() as Hex,
          parentHash: block.parentHash.toLowerCase() as Hex,
          timestamp: block.timestamp,
        };
      } catch (error) {
        if (error instanceof BlockNotFoundError) return null;
        throw error;
      }
    });
  }

  signerAddress(signer: SignerName): Address {
    const account = this.#accounts[signer];
    if (!account) throw new ChainError(`unknown signer: ${String(signer)}`);
    return lower(account.address);
  }

  async getNonce(
    signer: SignerName,
    blockNumber?: bigint,
  ): Promise<{ confirmed: number; pending: number }> {
    const address = this.signerAddress(signer);
    return this.run('getNonce', async () => {
      if (blockNumber !== undefined) {
        // At a block there is no pool: both counts are what was mined up to and including it.
        const mined = await this.client.getTransactionCount({ address, blockNumber });
        return { confirmed: mined, pending: mined };
      }
      const [confirmed, pending] = await Promise.all([
        this.client.getTransactionCount({ address, blockTag: 'latest' }),
        this.client.getTransactionCount({ address, blockTag: 'pending' }),
      ]);
      return { confirmed, pending };
    });
  }

  async estimateFees(): Promise<Fees> {
    return this.run('estimateFees', async () => {
      // Same rule as the fake: twice the latest base fee plus the node's suggested tip, so the
      // transaction survives several full blocks of base-fee growth.
      const [block, tip] = await Promise.all([
        this.client.getBlock({ blockTag: 'latest' }),
        this.client.estimateMaxPriorityFeePerGas(),
      ]);
      const baseFee = block.baseFeePerGas ?? 0n;
      return { maxFeePerGas: baseFee * 2n + tip, maxPriorityFeePerGas: tip };
    });
  }

  async submit(request: SubmitRequest): Promise<TxHash> {
    const kind = request.call?.kind;
    const expected = SIGNER_FOR_CALL[kind];
    if (!expected) throw new SubmissionRejectedError('submit: unknown call kind');
    if (request.signer !== expected) {
      throw new SubmissionRejectedError(
        `submit: ${kind} must be sent by the ${expected} signer, not ${String(request.signer)}`,
      );
    }
    const { nonce, fees } = request;
    if (!Number.isSafeInteger(nonce) || nonce < 0) {
      throw new SubmissionRejectedError('submit: nonce must be a non-negative integer');
    }
    if (
      typeof fees?.maxFeePerGas !== 'bigint' ||
      typeof fees.maxPriorityFeePerGas !== 'bigint' ||
      fees.maxPriorityFeePerGas < 0n ||
      fees.maxPriorityFeePerGas > fees.maxFeePerGas
    ) {
      throw new SubmissionRejectedError(
        'submit: fees must satisfy 0 <= maxPriorityFeePerGas <= maxFeePerGas',
      );
    }

    let to: Address;
    let data: Hex;
    try {
      ({ to, data } = this.encode(request.call));
    } catch (error) {
      throw new SubmissionRejectedError(`submit: invalid arguments for ${kind}`, error);
    }

    await this.ensureChain();
    const account = this.#accounts[expected];
    let raw: Hex;
    try {
      raw = await account.signTransaction({
        type: 'eip1559',
        chainId: this.chainId,
        nonce,
        to,
        data,
        value: 0n,
        gas: this.gasLimit,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
    } catch {
      // Deliberately no cause: signing errors come from the key holder.
      throw new SubmissionRejectedError('submit: the transaction could not be signed');
    }
    const hash = keccak256(raw);
    try {
      const sent = await this.client.sendRawTransaction({ serializedTransaction: raw });
      return sent.toLowerCase() as TxHash;
    } catch (error) {
      throw mapSubmitError(error, hash);
    }
  }

  async getReceipt(hash: TxHash): Promise<Receipt | null> {
    return this.run('getReceipt', async () => {
      let receipt;
      try {
        receipt = await this.client.getTransactionReceipt({ hash });
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
      const result: Receipt = {
        txHash: receipt.transactionHash.toLowerCase() as TxHash,
        status: receipt.status === 'success' ? 'success' : 'reverted',
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash.toLowerCase() as Hex,
      };
      if (result.status === 'reverted') {
        const reason = await this.revertReason(hash, receipt.blockNumber);
        if (reason !== undefined) result.revertReason = reason;
      }
      return result;
    });
  }

  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    return this.run('getTransaction', async () => {
      let tx;
      try {
        tx = await this.client.getTransaction({ hash });
      } catch (error) {
        if (error instanceof TransactionNotFoundError) return null;
        throw error;
      }
      const from = lower(tx.from);
      const signer = (Object.keys(this.#accounts) as SignerName[]).find(
        (name) => this.signerAddress(name) === from,
      );
      // Only the bridge's own transactions have a signer name; anything else is not reported.
      if (!signer) return null;
      const maxFeePerGas = tx.maxFeePerGas ?? tx.gasPrice ?? 0n;
      return {
        hash: tx.hash.toLowerCase() as TxHash,
        signer,
        nonce: tx.nonce,
        fees: { maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? maxFeePerGas },
        blockNumber: tx.blockNumber ?? null,
      };
    });
  }

  async getEvents(range: BlockRange): Promise<ChainEvent[]> {
    return this.run('getEvents', async () => {
      const head = await this.client.getBlockNumber({ cacheTime: 0 });
      const fromBlock = range.fromBlock < 0n ? 0n : range.fromBlock;
      const toBlock = range.toBlock > head ? head : range.toBlock;
      if (fromBlock > toBlock) return [];
      const logs = await this.client.getLogs({
        address: [this.registry, this.token],
        fromBlock,
        toBlock,
      });
      const events: ChainEvent[] = [];
      for (const log of logs) {
        const body = this.decodeLog(log);
        if (!body || log.blockHash === null || log.transactionHash === null) continue;
        events.push({
          ...body,
          blockNumber: log.blockNumber as bigint,
          blockHash: log.blockHash.toLowerCase() as Hex,
          txHash: log.transactionHash.toLowerCase() as TxHash,
          logIndex: log.logIndex as number,
        } as ChainEvent);
      }
      // Chain order, whatever order the node answered in.
      return events.sort((a, b) =>
        a.blockNumber === b.blockNumber
          ? a.logIndex - b.logIndex
          : a.blockNumber < b.blockNumber
            ? -1
            : 1,
      );
    });
  }

  async readBalance(holder: Address, blockNumber?: bigint): Promise<bigint> {
    return this.run('readBalance', () =>
      this.client.readContract({
        address: this.token,
        abi: settlementTokenAbi,
        functionName: 'balanceOf',
        args: [lower(holder)],
        blockNumber,
      }),
    );
  }

  async readTotalSupply(blockNumber?: bigint): Promise<bigint> {
    return this.run('readTotalSupply', () =>
      this.client.readContract({
        address: this.token,
        abi: settlementTokenAbi,
        functionName: 'totalSupply',
        blockNumber,
      }),
    );
  }

  async readReferenceUsed(
    contract: 'token' | 'registry',
    ref: Bytes32,
    blockNumber?: bigint,
  ): Promise<boolean> {
    if (contract !== 'token' && contract !== 'registry') {
      throw new ChainError(`unknown contract: ${String(contract)}`);
    }
    return this.run('readReferenceUsed', () =>
      contract === 'token'
        ? this.client.readContract({
            address: this.token,
            abi: settlementTokenAbi,
            functionName: 'referenceUsed',
            args: [ref],
            blockNumber,
          })
        : this.client.readContract({
            address: this.registry,
            abi: complianceRegistryAbi,
            functionName: 'referenceUsed',
            args: [ref],
            blockNumber,
          }),
    );
  }

  async readCompliance(account: Address, blockNumber?: bigint): Promise<ComplianceStatus> {
    return this.run('readCompliance', async () => {
      const args = [lower(account)] as const;
      const [verified, frozen] = await Promise.all([
        this.client.readContract({
          address: this.registry,
          abi: complianceRegistryAbi,
          functionName: 'isVerified',
          args,
          blockNumber,
        }),
        this.client.readContract({
          address: this.registry,
          abi: complianceRegistryAbi,
          functionName: 'isFrozen',
          args,
          blockNumber,
        }),
      ]);
      return { verified, frozen };
    });
  }

  // --- internals -----------------------------------------------------------------------------

  /** Checks the node's chain id once. A mismatch is remembered; an unreachable node is retried. */
  private ensureChain(): Promise<void> {
    if (!this.chainCheck) {
      this.chainCheck = (async () => {
        let actual: number;
        try {
          actual = await this.client.getChainId();
        } catch (error) {
          this.chainCheck = undefined;
          throw isTransportError(error)
            ? new ChainUnavailableError('chain id check: the node did not answer', error)
            : new ChainError('chain id check failed', error);
        }
        if (actual !== this.chainId) throw new ChainIdMismatchError(this.chainId, actual);
      })();
    }
    return this.chainCheck;
  }

  /** Runs a node call behind the chain-id check and maps its failures to `ChainError`s. */
  private async run<T>(op: string, fn: () => Promise<T>, checkChain = true): Promise<T> {
    if (checkChain) await this.ensureChain();
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ChainError) throw error;
      if (isTransportError(error)) {
        throw new ChainUnavailableError(`${op}: the node did not answer`, error);
      }
      throw new ChainError(`${op} failed${nodeDetails(error)}`, error);
    }
  }

  /** The target contract and calldata for a bridge call. */
  private encode(call: ContractCall): { to: Address; data: Hex } {
    switch (call.kind) {
      case 'mint':
        return {
          to: this.token,
          data: encodeFunctionData({
            abi: settlementTokenAbi,
            functionName: 'mint',
            args: [lower(call.to), call.amount, call.ref],
          }),
        };
      case 'burn':
        return {
          to: this.token,
          data: encodeFunctionData({
            abi: settlementTokenAbi,
            functionName: 'burn',
            args: [lower(call.from), call.amount, call.ref],
          }),
        };
      case 'settleTransfer':
        return {
          to: this.token,
          data: encodeFunctionData({
            abi: settlementTokenAbi,
            functionName: 'settleTransfer',
            args: [lower(call.from), lower(call.to), call.amount, call.ref],
          }),
        };
      case 'setVerified':
        return {
          to: this.registry,
          data: encodeFunctionData({
            abi: complianceRegistryAbi,
            functionName: 'setVerified',
            args: [lower(call.account), call.verified, call.ref],
          }),
        };
      case 'setFrozen':
        return {
          to: this.registry,
          data: encodeFunctionData({
            abi: complianceRegistryAbi,
            functionName: 'setFrozen',
            args: [lower(call.account), call.frozen, call.ref],
          }),
        };
    }
  }

  /** Decodes one of the six bridge events from a log, or undefined for anything else. */
  private decodeLog(log: Log): EventBody | undefined {
    const address = lower(log.address);
    const abi: Abi =
      address === this.token
        ? settlementTokenAbi
        : address === this.registry
          ? complianceRegistryAbi
          : [];
    let decoded: { eventName?: string; args?: unknown };
    try {
      decoded = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
    } catch {
      return undefined;
    }
    const a = decoded.args as Record<string, unknown>;
    switch (decoded.eventName) {
      case 'Minted':
        return {
          kind: 'Minted',
          to: lower(a.to as string),
          amount: a.amount as bigint,
          ref: a.ref as Hex,
        };
      case 'Burned':
        return {
          kind: 'Burned',
          from: lower(a.from as string),
          amount: a.amount as bigint,
          ref: a.ref as Hex,
        };
      case 'SettledTransfer':
        return {
          kind: 'SettledTransfer',
          from: lower(a.from as string),
          to: lower(a.to as string),
          amount: a.amount as bigint,
          ref: a.ref as Hex,
        };
      case 'Transfer':
        return {
          kind: 'Transfer',
          from: lower(a.from as string),
          to: lower(a.to as string),
          amount: a.value as bigint,
        };
      case 'VerificationSet':
        return {
          kind: 'VerificationSet',
          account: lower(a.account as string),
          verified: a.verified as boolean,
          ref: a.ref as Hex,
        };
      case 'FrozenSet':
        return {
          kind: 'FrozenSet',
          account: lower(a.account as string),
          frozen: a.frozen as boolean,
          ref: a.ref as Hex,
        };
      default:
        return undefined;
    }
  }

  /**
   * Best-effort name of the custom error a mined transaction reverted with: replays the call with
   * `eth_call` at the transaction's block and decodes the revert data against the target's ABI.
   * The replay runs on the state after that block, which matches the original execution unless a
   * later transaction in the same block changed the outcome. Undefined when it cannot be decoded
   * (for example an out-of-gas failure, which carries no data).
   */
  private async revertReason(hash: TxHash, blockNumber: bigint): Promise<string | undefined> {
    const tx = await this.client.getTransaction({ hash });
    if (!tx.to) return undefined;
    const to = lower(tx.to);
    const abi: Abi =
      to === this.token ? settlementTokenAbi : to === this.registry ? complianceRegistryAbi : [];
    try {
      await this.client.call({
        account: tx.from,
        to,
        data: tx.input,
        gas: tx.gas,
        blockNumber,
      });
      return undefined;
    } catch (error) {
      if (isTransportError(error)) throw error;
      const data = revertData(error);
      if (!data || data === '0x') return undefined;
      try {
        return decodeErrorResult({ abi, data }).errorName;
      } catch {
        return undefined;
      }
    }
  }
}
