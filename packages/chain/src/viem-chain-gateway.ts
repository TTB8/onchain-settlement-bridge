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
 * - The RPC URL (whose path or query often holds an API key) never reaches an error either: every
 *   cause is a scrubbed copy (`safeCause`), and the client lives in a `#private` field that
 *   `util.inspect` and `JSON.stringify` do not show.
 * - Submission errors fail safe: only this node's definite refusals are `SubmissionRejectedError`; any
 *   error it does not recognise means "outcome unknown" (`ChainUnavailableError`).
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
  isHex,
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
  type Deployment,
  type Fees,
  type Hex,
  type Receipt,
  type SignerName,
  type SignedTransaction,
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

/**
 * Replaces every URL that LOOKS like one in a text: `scheme://...`, its JSON-escaped form
 * (`https:\\/\\/host\\/path`) and its percent-encoded form (`https%3A%2F%2F...`). This is the
 * generic layer only: a host and path without a scheme cannot be recognised by pattern, which is
 * why the gateway also redacts its own configured URL literally (`makeRedactor`).
 */
export function redactUrls(text: string): string {
  return text.replace(
    /\b[a-z][a-z0-9+.-]*(?::\/\/|:\\\/\\\/|%3A%2F%2F)[^\s"'<>|]+/gi,
    '<redacted-url>',
  );
}

/** A function that removes secrets from a text. */
export type Redact = (text: string) => string;

/** Escapes a string for use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Pieces of the URL shorter than this are too short to be a secret and too common to remove. */
const MIN_SECRET_LENGTH = 4;

/**
 * A redactor for one configured RPC URL. It removes, case-insensitively, the full URL and each of
 * its parts that could hold a key: host (with and without port), credentials, path, every path
 * segment and every query value. It removes each one as written, JSON-escaped (`\\/`),
 * percent-encoded and JSON-string-escaped. It then applies the generic `redactUrls`. An API key
 * therefore cannot leak through a node message that quotes the URL without its scheme ("nonce
 * too high at host/v2/KEY"), escaped, or encoded.
 */
export function makeRedactor(rpcUrl?: string): Redact {
  const secrets = new Set<string>();
  const add = (value: string | undefined | null): void => {
    if (value && value.length >= MIN_SECRET_LENGTH) secrets.add(value);
  };
  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  if (rpcUrl) {
    add(rpcUrl);
    try {
      const url = new URL(rpcUrl);
      add(url.href);
      add(url.host);
      add(url.hostname);
      add(decode(url.username));
      add(decode(url.password));
      add(`${url.host}${url.pathname}`);
      add(url.pathname.length > 1 ? url.pathname : undefined);
      add(url.search.length > 1 ? url.search.slice(1) : undefined);
      for (const segment of url.pathname.split('/')) {
        add(segment);
        add(decode(segment));
      }
      for (const [, value] of url.searchParams) add(value);
    } catch {
      // Not parseable as a URL: the literal string is all there is to remove.
    }
  }
  const variants = new Set<string>();
  for (const secret of secrets) {
    variants.add(secret);
    variants.add(secret.replace(/\//g, '\\/'));
    variants.add(encodeURIComponent(secret));
    variants.add(encodeURI(secret));
    variants.add(JSON.stringify(secret).slice(1, -1));
  }
  const patterns = [...variants]
    .filter((v) => v.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
    .map((v) => new RegExp(escapeRegExp(v), 'gi'));
  return (text: string): string => {
    let out = text;
    for (const pattern of patterns) out = out.replace(pattern, '<redacted>');
    return redactUrls(out);
  };
}

/**
 * Applies a redactor, in place, to the message and the stack of every error in a chain (by
 * `cause`), and returns the same error. The last step before the gateway throws anything.
 */
export function sanitizeError<E>(error: E, redact: Redact): E {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 12; depth += 1) {
    current.message = redact(current.message);
    if (typeof current.stack === 'string') current.stack = redact(current.stack);
    current = current.cause;
  }
  return error;
}

/** The node's own one-line reason, when viem has one, for an error message. Redacted. */
function nodeDetails(error: unknown, redact: Redact): string {
  return error instanceof BaseError && error.details ? `: ${redact(error.details)}` : '';
}

/**
 * A copy of an error chain that is safe to keep as a `cause`: each link keeps its name, its short
 * message and the node's details (URLs redacted) and a numeric `code`, and drops everything else
 * (viem's request URL, request body and metadata). Our own `ChainError`s are kept as they are.
 */
export function safeCause(
  error: unknown,
  redact: Redact = redactUrls,
  depth = 0,
): Error | undefined {
  if (error === undefined || error === null || depth > 8) return undefined;
  if (error instanceof ChainError) return error;
  let name = 'Error';
  let text: string;
  if (error instanceof BaseError) {
    name = error.name;
    text = [error.shortMessage, error.details].filter(Boolean).join(' Details: ');
  } else if (error instanceof Error) {
    name = error.name;
    text = error.message;
  } else {
    text = String(error);
  }
  const inner = safeCause((error as { cause?: unknown }).cause, redact, depth + 1);
  const copy = new Error(redact(text), inner ? { cause: inner } : undefined);
  copy.name = name;
  if (typeof copy.stack === 'string') copy.stack = redact(copy.stack);
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number' || typeof code === 'string') {
    (copy as Error & { code?: unknown }).code = code;
  }
  return copy;
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

const NONCE_TOO_LOW = /nonce (is )?too low|nonce has already been used/;
const ALREADY_KNOWN =
  /already known|already imported|known transaction|already in (the )?(mem)?pool/;
const REPLACEMENT_UNDERPRICED = /replacement[^|]*underpriced|underpriced replacement/;
const INSUFFICIENT_FUNDS = /insufficient funds/;

/**
 * Node answers that mean THIS node refused THIS submission, so resending the same bytes to it
 * cannot help. They do not prove the transaction can never be mined (another node may already
 * hold the same signed bytes), so the attempt must still be kept until its nonce is final.
 * Anything not on this list (and not one of the specific cases above) is an unknown outcome.
 */
const DEFINITE_REJECTIONS: readonly RegExp[] = [
  /invalid (transaction )?signature|invalid sender|signature (is )?invalid/,
  /intrinsic gas too low/,
  /fee (per gas |cap )?(is )?(less than|below|lower than)[^|]*base ?fee|fee ?cap too low/,
  /exceeds (the )?block gas limit|gas limit (is )?(above|exceeds|higher than) (the )?block/,
  /invalid chain ?id|chain ?id mismatch|incompatible chain ?id|wrong chain ?id/,
  /nonce (is )?too high|nonce gap/,
  /priority fee per gas higher than max fee per gas|tip (above|higher than) fee cap/,
  /failed to decode transaction|rlp: |empty transaction data|transaction type not supported|invalid transaction encoding/,
];

/**
 * Maps a failure of `eth_sendRawTransaction` to the typed errors. `hash` is the hash the signed
 * transaction would have, reported with `AlreadyKnownError`.
 *
 * Fail-safe: only the allowlisted refusals by this node become `SubmissionRejectedError`. Every
 * error it does not recognise (a proxy that forwarded the transaction and then failed, a
 * `-32603`, "header not found", a provider's own wording) is `ChainUnavailableError`: the
 * outcome is unknown and the caller must check by hash and by reference before re-sending.
 * Matching is case-insensitive. The cause kept on the result is scrubbed of URLs.
 */
export function mapSubmitError(
  error: unknown,
  hash?: TxHash,
  redact: Redact = redactUrls,
): ChainError {
  if (error instanceof ChainError) return sanitizeError(error, redact);
  const cause = safeCause(error, redact);
  if (isTransportError(error)) {
    return new ChainUnavailableError(
      'submit: the node did not answer; the outcome is unknown',
      cause,
    );
  }
  const text = nodeText(error);
  if (NONCE_TOO_LOW.test(text)) return new NonceTooLowError('submit: nonce too low', cause);
  if (ALREADY_KNOWN.test(text)) {
    return new AlreadyKnownError('submit: the node already holds this transaction', hash, cause);
  }
  if (REPLACEMENT_UNDERPRICED.test(text)) {
    return new ReplacementUnderpricedError('submit: replacement transaction underpriced', cause);
  }
  if (INSUFFICIENT_FUNDS.test(text)) {
    return new InsufficientFundsError('submit: insufficient funds for gas', cause);
  }
  if (DEFINITE_REJECTIONS.some((pattern) => pattern.test(text))) {
    return new SubmissionRejectedError(
      `submit: this node refused the submission${nodeDetails(error, redact)}`,
      cause,
    );
  }
  return new ChainUnavailableError(
    `submit: unrecognised node error, the outcome is unknown${nodeDetails(error, redact)}`,
    cause,
  );
}

/** Lowercases an address. */
function lower(address: string): Address {
  return address.toLowerCase() as Address;
}

/** A `ChainGateway` for a real node, built on viem. */
export class ViemChainGateway implements ChainGateway {
  readonly #client: PublicClient;
  /** Removes the configured RPC URL and its parts from anything the gateway throws. */
  readonly #redact: Redact;
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
    this.#redact = makeRedactor(options.rpcUrl);
    this.#client = createPublicClient({
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
    return this.run('getChainId', () => this.#client.getChainId(), false);
  }

  async getHeadBlock(): Promise<bigint> {
    return this.run('getHeadBlock', () => this.#client.getBlockNumber({ cacheTime: 0 }));
  }

  async getBlock(number: bigint): Promise<BlockRef | null> {
    if (number < 0n) return null;
    return this.run('getBlock', async () => {
      try {
        const block = await this.#client.getBlock({ blockNumber: number });
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

  /** What this gateway was constructed with: the configured chain id, token and registry. */
  deployment(): Deployment {
    return { chainId: this.chainId, token: this.token, registry: this.registry };
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
        const mined = await this.#client.getTransactionCount({ address, blockNumber });
        return { confirmed: mined, pending: mined };
      }
      const [confirmed, pending] = await Promise.all([
        this.#client.getTransactionCount({ address, blockTag: 'latest' }),
        this.#client.getTransactionCount({ address, blockTag: 'pending' }),
      ]);
      return { confirmed, pending };
    });
  }

  async estimateFees(): Promise<Fees> {
    return this.run('estimateFees', async () => {
      // Same rule as the fake: twice the latest base fee plus the node's suggested tip, so the
      // transaction survives several full blocks of base-fee growth.
      const [block, tip] = await Promise.all([
        this.#client.getBlock({ blockTag: 'latest' }),
        this.#client.estimateMaxPriorityFeePerGas(),
      ]);
      const baseFee = block.baseFeePerGas ?? 0n;
      return { maxFeePerGas: baseFee * 2n + tip, maxPriorityFeePerGas: tip };
    });
  }

  async submit(request: SubmitRequest): Promise<TxHash> {
    try {
      const signed = await this.#sign(request, 'submit');
      return await this.#broadcast(signed.raw, signed.hash, false);
    } catch (error) {
      throw sanitizeError(error, this.#redact);
    }
  }

  /**
   * Signs locally with the named signer's account (EIP-1559, the configured chain id, the fixed
   * gas limit, value 0), exactly as `submit` would, and returns the bytes and their hash. The node
   * is not contacted: this works during an outage and does not run the chain-id check (`sendRaw`
   * does). Signing is deterministic (RFC 6979), so the same request gives the same bytes.
   */
  async signTransaction(request: SubmitRequest): Promise<SignedTransaction> {
    try {
      return await this.#sign(request, 'signTransaction');
    } catch (error) {
      throw sanitizeError(error, this.#redact);
    }
  }

  /**
   * Broadcasts exactly these bytes, after the chain-id check. Idempotent: "already known" returns
   * the hash; "nonce too low" returns the hash only if the node knows a transaction with exactly
   * this hash (pooled or mined), and otherwise stays `NonceTooLowError` (other bytes used the
   * nonce). Every other failure is mapped by `mapSubmitError`, so an unrecognised answer is an
   * unknown outcome, and every error is redacted.
   */
  async sendRaw(raw: Hex): Promise<TxHash> {
    try {
      if (typeof raw !== 'string' || !isHex(raw, { strict: true }) || raw.length <= 2) {
        throw new SubmissionRejectedError(
          'sendRaw: not signed transaction bytes (empty or not hex)',
        );
      }
      const bytes = raw.toLowerCase() as Hex;
      return await this.#broadcast(bytes, keccak256(bytes), true);
    } catch (error) {
      throw sanitizeError(error, this.#redact);
    }
  }

  /** Validates, encodes and signs a request. Nothing is sent. */
  async #sign(request: SubmitRequest, op: string): Promise<SignedTransaction> {
    const kind = request.call?.kind;
    const expected = SIGNER_FOR_CALL[kind];
    if (!expected) throw new SubmissionRejectedError(`${op}: unknown call kind`);
    if (request.signer !== expected) {
      throw new SubmissionRejectedError(
        `${op}: ${kind} must be sent by the ${expected} signer, not ${String(request.signer)}`,
      );
    }
    const { nonce, fees } = request;
    if (!Number.isSafeInteger(nonce) || nonce < 0) {
      throw new SubmissionRejectedError(`${op}: nonce must be a non-negative integer`);
    }
    if (
      typeof fees?.maxFeePerGas !== 'bigint' ||
      typeof fees.maxPriorityFeePerGas !== 'bigint' ||
      fees.maxPriorityFeePerGas < 0n ||
      fees.maxPriorityFeePerGas > fees.maxFeePerGas
    ) {
      throw new SubmissionRejectedError(
        `${op}: fees must satisfy 0 <= maxPriorityFeePerGas <= maxFeePerGas`,
      );
    }

    let to: Address;
    let data: Hex;
    try {
      ({ to, data } = this.encode(request.call));
    } catch (error) {
      throw new SubmissionRejectedError(
        `${op}: invalid arguments for ${kind}`,
        safeCause(error, this.#redact),
      );
    }

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
      throw new SubmissionRejectedError(`${op}: the transaction could not be signed`);
    }
    const bytes = raw.toLowerCase() as Hex;
    return { hash: keccak256(bytes), raw: bytes };
  }

  /**
   * Sends signed bytes after the chain-id check. `idempotent` turns "the node already has these
   * exact bytes" into success (`sendRaw`); without it the typed errors are thrown (`submit`).
   */
  async #broadcast(raw: Hex, hash: TxHash, idempotent: boolean): Promise<TxHash> {
    await this.ensureChain();
    try {
      const sent = await this.#client.sendRawTransaction({ serializedTransaction: raw });
      return sent.toLowerCase() as TxHash;
    } catch (error) {
      const mapped = mapSubmitError(error, hash, this.#redact);
      if (!idempotent) throw mapped;
      if (mapped instanceof AlreadyKnownError) return hash;
      if (mapped instanceof NonceTooLowError && (await this.#nodeKnows(hash))) return hash;
      throw mapped;
    }
  }

  /** Whether the node knows a transaction with this hash (pooled or mined), from any sender. */
  async #nodeKnows(hash: TxHash): Promise<boolean> {
    try {
      await this.#client.getTransaction({ hash });
      return true;
    } catch (error) {
      if (error instanceof TransactionNotFoundError) return false;
      // The nonce is used and we cannot tell by whom: the outcome is unknown.
      throw new ChainUnavailableError(
        'sendRaw: nonce too low and the lookup by hash failed; the outcome is unknown',
        safeCause(error, this.#redact),
      );
    }
  }

  async getReceipt(hash: TxHash): Promise<Receipt | null> {
    return this.run('getReceipt', async () => {
      let receipt;
      try {
        receipt = await this.#client.getTransactionReceipt({ hash });
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
        tx = await this.#client.getTransaction({ hash });
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
      const head = await this.#client.getBlockNumber({ cacheTime: 0 });
      const fromBlock = range.fromBlock < 0n ? 0n : range.fromBlock;
      const toBlock = range.toBlock > head ? head : range.toBlock;
      if (fromBlock > toBlock) return [];
      const logs = await this.#client.getLogs({
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
      this.#client.readContract({
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
      this.#client.readContract({
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
        ? this.#client.readContract({
            address: this.token,
            abi: settlementTokenAbi,
            functionName: 'referenceUsed',
            args: [ref],
            blockNumber,
          })
        : this.#client.readContract({
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
        this.#client.readContract({
          address: this.registry,
          abi: complianceRegistryAbi,
          functionName: 'isVerified',
          args,
          blockNumber,
        }),
        this.#client.readContract({
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
          actual = await this.#client.getChainId();
        } catch (error) {
          this.chainCheck = undefined;
          throw isTransportError(error)
            ? new ChainUnavailableError(
                'chain id check: the node did not answer',
                safeCause(error, this.#redact),
              )
            : new ChainError('chain id check failed', safeCause(error, this.#redact));
        }
        if (actual !== this.chainId) throw new ChainIdMismatchError(this.chainId, actual);
      })();
    }
    return this.chainCheck;
  }

  /** Runs a node call behind the chain-id check and maps its failures to `ChainError`s. */
  private async run<T>(op: string, fn: () => Promise<T>, checkChain = true): Promise<T> {
    try {
      if (checkChain) await this.ensureChain();
      return await fn();
    } catch (error) {
      if (error instanceof ChainError) throw sanitizeError(error, this.#redact);
      if (isTransportError(error)) {
        throw sanitizeError(
          new ChainUnavailableError(
            `${op}: the node did not answer`,
            safeCause(error, this.#redact),
          ),
          this.#redact,
        );
      }
      throw sanitizeError(
        new ChainError(
          `${op} failed${nodeDetails(error, this.#redact)}`,
          safeCause(error, this.#redact),
        ),
        this.#redact,
      );
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
    const tx = await this.#client.getTransaction({ hash });
    if (!tx.to) return undefined;
    const to = lower(tx.to);
    const abi: Abi =
      to === this.token ? settlementTokenAbi : to === this.registry ? complianceRegistryAbi : [];
    try {
      await this.#client.call({
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
