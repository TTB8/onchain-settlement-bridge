/**
 * @file An in-memory chain that implements `ChainGateway` and mirrors the rules of the two
 * contracts (`ComplianceRegistry`, `SettlementToken`) exactly, so that every other package can be
 * tested without a node. It also models what a real node does to transactions: numbered blocks
 * with hashes, a mempool, per-signer nonces, EIP-1559 fee inclusion, replacement rules, dropped
 * and stuck transactions, and reorganisations.
 *
 * Everything is deterministic: transaction hashes are a function of (chain id, signer, nonce,
 * call, fees), block hashes of (fork, number, parent, timestamp, transactions). Run the same test
 * twice and you get the same hashes.
 *
 * Test controls (`mine`, `setAutomine`, `setBaseFee`, `dropTransaction`, `reorg`,
 * `setUnavailable`, `failNextSubmit`, `injectTransfer`, `setPaused`, `setSignerBalance`) and the
 * read-only accessors are synchronous and are never affected by `setUnavailable`.
 */

import {
  isAddress,
  isHex,
  keccak256,
  maxUint256,
  parseEther,
  parseGwei,
  size,
  hexToString,
  stringToHex,
  zeroAddress,
  zeroHash,
} from 'viem';

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
  type SignedTransaction,
  type SubmitRequest,
  type TransactionInfo,
  type TxHash,
} from './types';

/** The token's decimals, as `SettlementToken.decimals()` returns them. */
export const TOKEN_DECIMALS = 6;

/**
 * A replacement must pay at least this much more on BOTH fee fields, as a fraction
 * (`REPLACEMENT_BUMP_NUMERATOR / REPLACEMENT_BUMP_DENOMINATOR` = 12.5%).
 */
export const REPLACEMENT_BUMP_NUMERATOR = 1n;

/** See `REPLACEMENT_BUMP_NUMERATOR`. */
export const REPLACEMENT_BUMP_DENOMINATOR = 8n;

/** Options for a new fake chain. Every field has a sensible default. */
export interface FakeChainOptions {
  /** Default 31337 (Anvil's). */
  chainId?: number;
  /** Lowercased on the way in. */
  registryAddress?: Address;
  /** Lowercased on the way in. */
  tokenAddress?: Address;
  /** The address each signer sends from. Lowercased on the way in. */
  signers?: Partial<Record<SignerName, Address>>;
  /** The base fee every block uses until `setBaseFee` changes it. Default 1 gwei. */
  baseFee?: bigint;
  /** The tip `estimateFees` suggests. Default 1 gwei. */
  priorityFee?: bigint;
  /** Whether each accepted submission mines a block at once. Default true. */
  automine?: boolean;
  /** Timestamp of block 0, in seconds. Default 1_700_000_000. */
  genesisTimestamp?: bigint;
  /** Seconds between blocks. Default 12. */
  blockTimeSeconds?: bigint;
  /** Each signer's starting balance in wei. Default 10_000 ether. */
  signerBalance?: bigint;
  /**
   * The gas limit the fake assumes for every transaction, used only for the affordability check
   * (`gasLimit * maxFeePerGas` must not exceed the signer's balance). Default 300_000.
   */
  gasLimit?: bigint;
}

/** Options for `reorg`. */
export interface ReorgOptions {
  /** How many blocks at the head vanish. They are replaced by as many new, empty blocks. */
  depth: number;
  /**
   * Which of the removed blocks' transactions the node forgets instead of returning them to the
   * pool: `true` for all of them, or a list of hashes. Default: none (all go back to the pool).
   */
  dropTransactions?: boolean | readonly TxHash[];
}

/** Options for `failNextSubmit`. */
export interface FailNextSubmitOptions {
  /**
   * When true, the transaction is accepted into the pool (and mined, under automine) BEFORE the
   * error is thrown: the "the node took it but the answer was lost" case. Default false: nothing
   * happens except the error.
   */
  accept?: boolean;
}

/** A transaction the bridge's signers sent. */
interface BridgeTx {
  type: 'bridge';
  hash: TxHash;
  seq: number;
  signer: SignerName;
  nonce: number;
  call: ContractCall;
  fees: Fees;
}

/** A transaction from outside the bridge, created by a test control. */
interface ControlTx {
  type: 'control';
  hash: TxHash;
  seq: number;
  action:
    | { kind: 'transfer'; from: Address; to: Address; amount: bigint }
    | { kind: 'transferFrom'; spender: Address; from: Address; to: Address; amount: bigint }
    | { kind: 'approve'; owner: Address; spender: Address; amount: bigint }
    | { kind: 'pause'; paused: boolean }
    | { kind: 'holderTransfers'; enabled: boolean };
}

type FakeTx = BridgeTx | ControlTx;

/** An event before it has a position in a block. */
type EventBody = ChainEvent extends infer E
  ? E extends ChainEvent
    ? Omit<E, 'blockNumber' | 'blockHash' | 'txHash' | 'logIndex'>
    : never
  : never;

/** A contract revert: the name of the custom error. */
class Revert {
  constructor(readonly reason: string) {}
}

/** Everything the two contracts store, plus each signer's mined nonce count. */
class WorldState {
  verified = new Set<Address>();
  frozen = new Set<Address>();
  registryRefs = new Set<Bytes32>();
  tokenRefs = new Set<Bytes32>();
  balances = new Map<Address, bigint>();
  totalSupply = 0n;
  paused = false;
  /** `SettlementToken.holderTransfersEnabled`: false after deployment. */
  holderTransfersEnabled = false;
  /** ERC-20 allowances, keyed `owner:spender`. */
  allowances = new Map<string, bigint>();
  nonces: Record<SignerName, number> = { settlement: 0, compliance: 0 };

  clone(): WorldState {
    const copy = new WorldState();
    copy.verified = new Set(this.verified);
    copy.frozen = new Set(this.frozen);
    copy.registryRefs = new Set(this.registryRefs);
    copy.tokenRefs = new Set(this.tokenRefs);
    copy.balances = new Map(this.balances);
    copy.totalSupply = this.totalSupply;
    copy.paused = this.paused;
    copy.holderTransfersEnabled = this.holderTransfersEnabled;
    copy.allowances = new Map(this.allowances);
    copy.nonces = { ...this.nonces };
    return copy;
  }

  balanceOf(holder: Address): bigint {
    return this.balances.get(holder) ?? 0n;
  }

  isAllowed(account: Address): boolean {
    return this.verified.has(account) && !this.frozen.has(account);
  }

  allowance(owner: Address, spender: Address): bigint {
    return this.allowances.get(`${owner}:${spender}`) ?? 0n;
  }
}

/** One block: its identity, what it included, and the state after it. */
interface FakeBlock {
  ref: BlockRef;
  txs: FakeTx[];
  receipts: Map<TxHash, Receipt>;
  events: ChainEvent[];
  state: WorldState;
}

/** A stable pseudo-address for a label, so defaults never collide with each other. */
function labelAddress(label: string): Address {
  return `0x${keccak256(stringToHex(`fake-chain:${label}`)).slice(-40)}`;
}

/** JSON with bigints, for hashing. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return `${v}n`;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // Sorted keys: identical requests encode identically whatever order their keys were in.
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
    }
    return v;
  });
}

/** The prefix of the fake's signed-transaction encoding. */
const RAW_PREFIX = 'fake-eip1559-tx:';

/** What the fake's raw bytes carry: everything a real signed EIP-1559 transaction pins down. */
interface DecodedRaw {
  chainId: number;
  from: Address;
  signer: SignerName;
  nonce: number;
  call: ContractCall;
  fees: Fees;
}

/** Decodes the fake's raw encoding, or returns undefined for bytes it did not produce. */
function decodeRaw(raw: unknown): DecodedRaw | undefined {
  if (typeof raw !== 'string' || !isHex(raw, { strict: true }) || raw.length <= 2) return undefined;
  try {
    const text = hexToString(raw as Hex);
    if (!text.startsWith(RAW_PREFIX)) return undefined;
    return JSON.parse(text.slice(RAW_PREFIX.length), (_key, v: unknown) =>
      typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
    ) as DecodedRaw;
  } catch {
    return undefined;
  }
}

function isUint256(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= maxUint256;
}

function isBytes32(value: unknown): value is Bytes32 {
  return typeof value === 'string' && isHex(value, { strict: true }) && size(value) === 32;
}

function isPlainAddress(value: unknown): value is Address {
  return typeof value === 'string' && isAddress(value, { strict: false });
}

/** Throws `SubmissionRejectedError` unless the call's arguments could be ABI-encoded. */
function validateCall(call: ContractCall): ContractCall {
  const bad = (field: string): never => {
    throw new SubmissionRejectedError(`invalid ${field} for ${call.kind}`);
  };
  if (!isBytes32(call.ref)) bad('ref');
  const lower = (a: Address): Address => a.toLowerCase() as Address;
  switch (call.kind) {
    case 'mint':
      if (!isPlainAddress(call.to)) bad('to');
      if (!isUint256(call.amount)) bad('amount');
      return { ...call, to: lower(call.to), ref: call.ref.toLowerCase() as Bytes32 };
    case 'burn':
      if (!isPlainAddress(call.from)) bad('from');
      if (!isUint256(call.amount)) bad('amount');
      return { ...call, from: lower(call.from), ref: call.ref.toLowerCase() as Bytes32 };
    case 'settleTransfer':
      if (!isPlainAddress(call.from)) bad('from');
      if (!isPlainAddress(call.to)) bad('to');
      if (!isUint256(call.amount)) bad('amount');
      return {
        ...call,
        from: lower(call.from),
        to: lower(call.to),
        ref: call.ref.toLowerCase() as Bytes32,
      };
    case 'setVerified':
      if (!isPlainAddress(call.account)) bad('account');
      if (typeof call.verified !== 'boolean') bad('verified');
      return { ...call, account: lower(call.account), ref: call.ref.toLowerCase() as Bytes32 };
    case 'setFrozen':
      if (!isPlainAddress(call.account)) bad('account');
      if (typeof call.frozen !== 'boolean') bad('frozen');
      return { ...call, account: lower(call.account), ref: call.ref.toLowerCase() as Bytes32 };
  }
}

/** Whether `next` raises `prev` by at least the replacement bump (12.5%). */
function bumped(next: bigint, prev: bigint): boolean {
  return (
    next * REPLACEMENT_BUMP_DENOMINATOR >=
    prev * (REPLACEMENT_BUMP_DENOMINATOR + REPLACEMENT_BUMP_NUMERATOR)
  );
}

/**
 * An in-memory `ChainGateway`. See the file overview for what it models; see each control's
 * documentation for how to drive it from a test.
 */
export class FakeChainGateway implements ChainGateway {
  readonly chainId: number;
  readonly registryAddress: Address;
  readonly tokenAddress: Address;

  private readonly signerAddresses: Record<SignerName, Address>;
  private readonly signerBalances: Record<SignerName, bigint>;
  private readonly priorityFee: bigint;
  private readonly blockTimeSeconds: bigint;
  private readonly gasLimit: bigint;

  private readonly blocks: FakeBlock[] = [];
  private readonly pool = new Map<TxHash, FakeTx>();
  private readonly minedIn = new Map<TxHash, number>();
  private currentBaseFee: bigint;
  private automine: boolean;
  private unavailable = false;
  private pendingFailure: { error: Error; accept: boolean } | undefined;
  private fork = 0;
  private seq = 0;

  constructor(options: FakeChainOptions = {}) {
    this.chainId = options.chainId ?? 31337;
    this.registryAddress = (
      options.registryAddress ?? labelAddress('registry')
    ).toLowerCase() as Address;
    this.tokenAddress = (options.tokenAddress ?? labelAddress('token')).toLowerCase() as Address;
    this.signerAddresses = {
      settlement: (
        options.signers?.settlement ?? labelAddress('settlement')
      ).toLowerCase() as Address,
      compliance: (
        options.signers?.compliance ?? labelAddress('compliance')
      ).toLowerCase() as Address,
    };
    const balance = options.signerBalance ?? parseEther('10000');
    this.signerBalances = { settlement: balance, compliance: balance };
    this.currentBaseFee = options.baseFee ?? parseGwei('1');
    this.priorityFee = options.priorityFee ?? parseGwei('1');
    this.automine = options.automine ?? true;
    this.blockTimeSeconds = options.blockTimeSeconds ?? 12n;
    this.gasLimit = options.gasLimit ?? 300_000n;

    const genesisTimestamp = options.genesisTimestamp ?? 1_700_000_000n;
    this.blocks.push({
      ref: {
        number: 0n,
        hash: this.blockHash(0n, zeroHash, genesisTimestamp, []),
        parentHash: zeroHash,
        timestamp: genesisTimestamp,
      },
      txs: [],
      receipts: new Map(),
      events: [],
      state: new WorldState(),
    });
  }

  // --- ChainGateway --------------------------------------------------------------------------

  async getChainId(): Promise<number> {
    this.ensureAvailable();
    return this.chainId;
  }

  async getHeadBlock(): Promise<bigint> {
    this.ensureAvailable();
    return this.head.ref.number;
  }

  async getBlock(number: bigint): Promise<BlockRef | null> {
    this.ensureAvailable();
    const block = this.blockAt(number);
    return block ? { ...block.ref } : null;
  }

  signerAddress(signer: SignerName): Address {
    const address = this.signerAddresses[signer];
    if (!address) throw new ChainError(`unknown signer: ${String(signer)}`);
    return address;
  }

  async getNonce(
    signer: SignerName,
    blockNumber?: bigint,
  ): Promise<{ confirmed: number; pending: number }> {
    this.ensureAvailable();
    this.signerAddress(signer);
    if (blockNumber !== undefined) {
      // At a block, there is no pool: both counts are what was mined up to and including it.
      const mined = this.stateAt(blockNumber).nonces[signer];
      return { confirmed: mined, pending: mined };
    }
    const confirmed = this.head.state.nonces[signer];
    let pending = confirmed;
    while (this.findPooled(signer, pending)) pending += 1;
    return { confirmed, pending };
  }

  async estimateFees(): Promise<Fees> {
    this.ensureAvailable();
    return {
      maxFeePerGas: this.currentBaseFee * 2n + this.priorityFee,
      maxPriorityFeePerGas: this.priorityFee,
    };
  }

  async submit(request: SubmitRequest): Promise<TxHash> {
    this.ensureAvailable();
    return this.withInjectedFailure(() => this.admit(this.sign(request), false));
  }

  /**
   * Signs without sending or consuming anything. Local, like a real key: it works while the fake
   * is unavailable. The fake has no keys, so its `raw` is a deterministic encoding of
   * `{ chainId, from, signer, nonce, call, fees }`, not a real Ethereum transaction; `hash` is
   * `keccak256(raw)`, and it is the same hash `submit` returns for the same request.
   */
  async signTransaction(request: SubmitRequest): Promise<SignedTransaction> {
    const { hash, raw } = this.sign(request);
    return { hash, raw };
  }

  /**
   * Broadcasts bytes from `signTransaction` (of a fake with the same signer addresses).
   * Idempotent: bytes already in the pool or already mined return their hash. Bytes it cannot
   * decode, bytes for another chain id, and bytes from a sender it does not know are refused
   * with `SubmissionRejectedError`, worded like a node. Every other rule, and `failNextSubmit`,
   * apply exactly as for `submit`.
   */
  async sendRaw(raw: Hex): Promise<TxHash> {
    this.ensureAvailable();
    return this.withInjectedFailure(() => this.admit(this.verifyRaw(raw), true));
  }

  async getReceipt(hash: TxHash): Promise<Receipt | null> {
    this.ensureAvailable();
    const at = this.minedIn.get(hash.toLowerCase() as TxHash);
    if (at === undefined) return null;
    const receipt = this.blocks[at]?.receipts.get(hash.toLowerCase() as TxHash);
    return receipt ? { ...receipt } : null;
  }

  async getTransaction(hash: TxHash): Promise<TransactionInfo | null> {
    this.ensureAvailable();
    const key = hash.toLowerCase() as TxHash;
    const pooled = this.pool.get(key);
    const at = this.minedIn.get(key);
    const tx =
      pooled ?? (at === undefined ? undefined : this.blocks[at]?.txs.find((t) => t.hash === key));
    // Transactions from outside the bridge have no signer name: the gateway does not report them.
    if (!tx || tx.type !== 'bridge') return null;
    return {
      hash: tx.hash,
      signer: tx.signer,
      nonce: tx.nonce,
      fees: { ...tx.fees },
      blockNumber: pooled ? null : BigInt(at as number),
    };
  }

  async getEvents(range: BlockRange): Promise<ChainEvent[]> {
    this.ensureAvailable();
    const head = this.head.ref.number;
    const to = range.toBlock > head ? head : range.toBlock;
    const out: ChainEvent[] = [];
    for (let n = range.fromBlock < 0n ? 0n : range.fromBlock; n <= to; n += 1n) {
      for (const event of this.blocks[Number(n)]?.events ?? []) out.push({ ...event });
    }
    return out;
  }

  async readBalance(holder: Address, blockNumber?: bigint): Promise<bigint> {
    this.ensureAvailable();
    return this.stateAt(blockNumber).balanceOf(holder.toLowerCase() as Address);
  }

  async readTotalSupply(blockNumber?: bigint): Promise<bigint> {
    this.ensureAvailable();
    return this.stateAt(blockNumber).totalSupply;
  }

  async readReferenceUsed(
    contract: 'token' | 'registry',
    ref: Bytes32,
    blockNumber?: bigint,
  ): Promise<boolean> {
    this.ensureAvailable();
    if (contract !== 'token' && contract !== 'registry') {
      throw new ChainError(`unknown contract: ${String(contract)}`);
    }
    if (!isBytes32(ref)) throw new ChainError('readReferenceUsed: ref must be 32 bytes');
    const state = this.stateAt(blockNumber);
    const key = ref.toLowerCase() as Bytes32;
    return contract === 'token' ? state.tokenRefs.has(key) : state.registryRefs.has(key);
  }

  async readCompliance(account: Address, blockNumber?: bigint): Promise<ComplianceStatus> {
    this.ensureAvailable();
    const state = this.stateAt(blockNumber);
    const key = account.toLowerCase() as Address;
    return { verified: state.verified.has(key), frozen: state.frozen.has(key) };
  }

  // --- test controls -------------------------------------------------------------------------

  /** When on (the default), every accepted submission mines one block at once. */
  setAutomine(enabled: boolean): void {
    this.automine = enabled;
  }

  /**
   * Mines `count` blocks (default 1). Each block takes every ready transaction from the pool: a
   * bridge transaction is ready when its nonce is the signer's next one and its `maxFeePerGas`
   * covers the current base fee; control transactions are always ready and go first. Bridge
   * transactions are ordered by effective tip, highest first, then by arrival. An empty pool
   * still produces (empty) blocks. Returns the new head number.
   */
  mine(count = 1): bigint {
    if (!Number.isInteger(count) || count < 1) throw new RangeError('mine: count must be >= 1');
    for (let i = 0; i < count; i += 1) this.mineBlock(true);
    return this.head.ref.number;
  }

  /** Sets the base fee of every following block. Transactions below it stay in the pool, stuck. */
  setBaseFee(baseFee: bigint): void {
    if (baseFee < 0n) throw new RangeError('setBaseFee: must be >= 0');
    this.currentBaseFee = baseFee;
  }

  /** The base fee the next block will use. */
  get baseFee(): bigint {
    return this.currentBaseFee;
  }

  /**
   * The node forgets a pooled transaction, as if it had been evicted; its nonce is free again.
   * Returns whether it was in the pool (mined transactions cannot be dropped).
   */
  dropTransaction(hash: TxHash): boolean {
    return this.pool.delete(hash.toLowerCase() as TxHash);
  }

  /**
   * The last `depth` blocks vanish and as many new, empty blocks with different hashes take their
   * place, so the head height is unchanged. Their events and receipts disappear. Their
   * transactions go back to the pool (unless dropped by `dropTransactions`) and are mined again by
   * the next `mine()` or automined submission, in a block with a new hash.
   */
  reorg(options: ReorgOptions): void {
    const { depth } = options;
    const head = Number(this.head.ref.number);
    if (!Number.isInteger(depth) || depth < 1 || depth > head) {
      throw new RangeError(`reorg: depth must be between 1 and ${head}`);
    }
    const drop = options.dropTransactions ?? false;
    const dropped = new Set(Array.isArray(drop) ? drop.map((h) => h.toLowerCase() as TxHash) : []);
    const removed = this.blocks.splice(this.blocks.length - depth, depth);
    this.fork += 1;
    for (const block of removed) {
      for (const tx of block.txs) {
        this.minedIn.delete(tx.hash);
        if (drop === true || dropped.has(tx.hash)) continue;
        this.pool.set(tx.hash, tx);
      }
    }
    for (let i = 0; i < depth; i += 1) this.mineBlock(false);
  }

  /** While on, every `ChainGateway` method throws `ChainUnavailableError`. */
  setUnavailable(unavailable: boolean): void {
    this.unavailable = unavailable;
  }

  /**
   * The next `submit` or `sendRaw` throws `error`. By default nothing else happens; with
   * `accept: true` the transaction is accepted first (the outcome-unknown case a real timeout
   * produces).
   */
  failNextSubmit(error: Error, options: FailNextSubmitOptions = {}): void {
    this.pendingFailure = { error, accept: options.accept ?? false };
  }

  /**
   * A holder-signed plain ERC-20 `transfer` from `from` to `to`, outside the bridge. It is mined in
   * the next block (at once under automine). While holder transfers are switched off (the
   * default, see `setHolderTransfersEnabled`) it reverts `HolderTransfersDisabled`; when on, it is
   * subject to the token's other rules and, if it succeeds, emits only the standard `Transfer`
   * event and no reference event. Returns its hash.
   */
  injectTransfer(from: Address, to: Address, amount: bigint): TxHash {
    if (!isPlainAddress(from) || !isPlainAddress(to) || !isUint256(amount)) {
      throw new RangeError('injectTransfer: invalid address or amount');
    }
    return this.addControl({
      kind: 'transfer',
      from: from.toLowerCase() as Address,
      to: to.toLowerCase() as Address,
      amount,
    });
  }

  /**
   * A holder-signed `approve(spender, amount)` by `owner`, mined in the next block (at once under
   * automine). Reverts `HolderTransfersDisabled` while the switch is off, then `EnforcedPause`,
   * then `NotAllowed` for the owner, then `ERC20InvalidSpender`. Emits no bridge event.
   */
  injectApprove(owner: Address, spender: Address, amount: bigint): TxHash {
    if (!isPlainAddress(owner) || !isPlainAddress(spender) || !isUint256(amount)) {
      throw new RangeError('injectApprove: invalid address or amount');
    }
    return this.addControl({
      kind: 'approve',
      owner: owner.toLowerCase() as Address,
      spender: spender.toLowerCase() as Address,
      amount,
    });
  }

  /**
   * A holder-approved `transferFrom(from, to, amount)` sent by `spender`, mined in the next block.
   * Reverts `HolderTransfersDisabled` while the switch is off, then `NotAllowed` for the spender,
   * then `ERC20InsufficientAllowance`, then the usual transfer checks. Emits only `Transfer`.
   */
  injectTransferFrom(spender: Address, from: Address, to: Address, amount: bigint): TxHash {
    if (
      !isPlainAddress(spender) ||
      !isPlainAddress(from) ||
      !isPlainAddress(to) ||
      !isUint256(amount)
    ) {
      throw new RangeError('injectTransferFrom: invalid address or amount');
    }
    return this.addControl({
      kind: 'transferFrom',
      spender: spender.toLowerCase() as Address,
      from: from.toLowerCase() as Address,
      to: to.toLowerCase() as Address,
      amount,
    });
  }

  /**
   * The admin calls `setHolderTransfersEnabled(enabled)`, mined in the next block (at once under
   * automine). It never reverts and emits no bridge event. Off after deployment.
   */
  setHolderTransfersEnabled(enabled: boolean): TxHash {
    return this.addControl({ kind: 'holderTransfers', enabled });
  }

  /**
   * The pauser calls `pause()` or `unpause()`, mined in the next block (at once under automine).
   * Pausing a paused token reverts with `EnforcedPause`, unpausing an unpaused one with
   * `ExpectedPause`, as on chain. Returns its hash.
   */
  setPaused(paused: boolean): TxHash {
    return this.addControl({ kind: 'pause', paused });
  }

  /** Sets a signer's native balance, which the affordability check reads. */
  setSignerBalance(signer: SignerName, wei: bigint): void {
    this.signerAddress(signer);
    this.signerBalances[signer] = wei;
  }

  // --- read-only accessors (head state, never affected by setUnavailable) ---------------------

  /** A holder's balance at the head. */
  balanceOf(holder: Address): bigint {
    return this.head.state.balanceOf(holder.toLowerCase() as Address);
  }

  /** The total supply at the head. */
  totalSupply(): bigint {
    return this.head.state.totalSupply;
  }

  /** An account's registry flags at the head. */
  complianceOf(account: Address): ComplianceStatus {
    const key = account.toLowerCase() as Address;
    return { verified: this.head.state.verified.has(key), frozen: this.head.state.frozen.has(key) };
  }

  /** Whether the holder-signed ERC-20 path is switched on at the head. */
  holderTransfersEnabled(): boolean {
    return this.head.state.holderTransfersEnabled;
  }

  /** An ERC-20 allowance at the head. */
  allowance(owner: Address, spender: Address): bigint {
    return this.head.state.allowance(
      owner.toLowerCase() as Address,
      spender.toLowerCase() as Address,
    );
  }

  /** Whether the token is paused at the head. */
  isPaused(): boolean {
    return this.head.state.paused;
  }

  /** Whether the token has consumed a reference (mint, burn and settleTransfer share one set). */
  tokenReferenceUsed(ref: Bytes32): boolean {
    return this.head.state.tokenRefs.has(ref.toLowerCase() as Bytes32);
  }

  /** Whether the registry has consumed a reference (separate from the token's set, as on chain). */
  registryReferenceUsed(ref: Bytes32): boolean {
    return this.head.state.registryRefs.has(ref.toLowerCase() as Bytes32);
  }

  /** How many transactions wait in the pool (stuck, gapped, or not mined yet). */
  mempoolSize(): number {
    return this.pool.size;
  }

  /** The hashes waiting in the pool, in arrival order. */
  mempoolHashes(): TxHash[] {
    return [...this.pool.values()].sort((a, b) => a.seq - b.seq).map((t) => t.hash);
  }

  // --- internals -----------------------------------------------------------------------------

  private get head(): FakeBlock {
    return this.blocks[this.blocks.length - 1] as FakeBlock;
  }

  private ensureAvailable(): void {
    if (this.unavailable) throw new ChainUnavailableError('fake chain: node unavailable');
  }

  private blockAt(number: bigint): FakeBlock | undefined {
    if (number < 0n || number > this.head.ref.number) return undefined;
    return this.blocks[Number(number)];
  }

  private stateAt(blockNumber: bigint | undefined): WorldState {
    if (blockNumber === undefined) return this.head.state;
    const block = this.blockAt(blockNumber);
    if (!block) {
      throw new ChainError(
        `block ${blockNumber} is not in the chain (head is ${this.head.ref.number})`,
      );
    }
    return block.state;
  }

  private findPooled(signer: SignerName, nonce: number): BridgeTx | undefined {
    for (const tx of this.pool.values()) {
      if (tx.type === 'bridge' && tx.signer === signer && tx.nonce === nonce) return tx;
    }
    return undefined;
  }

  private txHash(payload: unknown): TxHash {
    return keccak256(stringToHex(stableJson({ chainId: this.chainId, payload })));
  }

  private blockHash(number: bigint, parentHash: Hex, timestamp: bigint, txs: FakeTx[]): Hex {
    return keccak256(
      stringToHex(
        stableJson({ fork: this.fork, number, parentHash, timestamp, txs: txs.map((t) => t.hash) }),
      ),
    );
  }

  /** Runs a submission, unless a failure was injected for it (see `failNextSubmit`). */
  private withInjectedFailure(run: () => TxHash): TxHash {
    const failure = this.pendingFailure;
    if (failure) {
      this.pendingFailure = undefined;
      if (failure.accept) run();
      throw failure.error;
    }
    return run();
  }

  /** Validates a request the way `submit` does and returns its canonical signed form. */
  private sign(request: SubmitRequest): SignedTransaction & DecodedRaw {
    const { signer, nonce, fees } = request;
    const expected = SIGNER_FOR_CALL[request.call?.kind];
    if (!expected) throw new SubmissionRejectedError('unknown call kind');
    if (signer !== expected) {
      throw new SubmissionRejectedError(
        `${request.call.kind} must be sent by the ${expected} signer, not ${String(signer)}`,
      );
    }
    if (!Number.isSafeInteger(nonce) || nonce < 0) {
      throw new SubmissionRejectedError('nonce must be a non-negative integer');
    }
    if (
      !isUint256(fees?.maxFeePerGas) ||
      !isUint256(fees?.maxPriorityFeePerGas) ||
      fees.maxPriorityFeePerGas > fees.maxFeePerGas
    ) {
      throw new SubmissionRejectedError(
        'fees must satisfy 0 <= maxPriorityFeePerGas <= maxFeePerGas',
      );
    }
    const decoded: DecodedRaw = {
      chainId: this.chainId,
      from: this.signerAddress(signer),
      signer,
      nonce,
      call: validateCall(request.call),
      fees: { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas },
    };
    const raw = stringToHex(`${RAW_PREFIX}${stableJson(decoded)}`);
    return { ...decoded, raw, hash: keccak256(raw) };
  }

  /** Checks raw bytes the way a node does before it looks at the pool. */
  private verifyRaw(raw: Hex): SignedTransaction & DecodedRaw {
    const decoded = decodeRaw(raw);
    if (!decoded) {
      throw new SubmissionRejectedError(
        'submit: this node refused the submission: failed to decode transaction',
      );
    }
    if (decoded.chainId !== this.chainId) {
      throw new SubmissionRejectedError(
        'submit: this node refused the submission: invalid chain id for signer',
      );
    }
    if (this.signerAddresses[decoded.signer] !== decoded.from) {
      // A real node would accept any validly signed sender; the fake only knows its two signers.
      throw new SubmissionRejectedError('submit: this node refused the submission: invalid sender');
    }
    const canonical = this.sign(decoded);
    if (canonical.raw !== raw.toLowerCase()) {
      throw new SubmissionRejectedError(
        'submit: this node refused the submission: failed to decode transaction',
      );
    }
    return canonical;
  }

  /**
   * Admits a signed transaction to the pool under the node's rules (and automines). With
   * `idempotent`, bytes the node already knows (pooled or mined) return their hash instead of
   * `AlreadyKnownError` or `NonceTooLowError`.
   */
  private admit(tx: SignedTransaction & DecodedRaw, idempotent: boolean): TxHash {
    const { hash, signer, nonce, call } = tx;
    const cleanFees = tx.fees;
    if (idempotent && (this.pool.has(hash) || this.minedIn.has(hash))) return hash;

    const confirmed = this.head.state.nonces[signer];
    if (nonce < confirmed) {
      throw new NonceTooLowError(
        `nonce ${nonce} is below the ${signer} signer's next nonce ${confirmed}`,
      );
    }
    if (this.pool.has(hash)) throw new AlreadyKnownError('transaction already known', hash);
    if (this.gasLimit * cleanFees.maxFeePerGas > this.signerBalances[signer]) {
      throw new InsufficientFundsError(`the ${signer} signer cannot pay for gas at this fee`);
    }
    const existing = this.findPooled(signer, nonce);
    if (existing) {
      if (
        !bumped(cleanFees.maxFeePerGas, existing.fees.maxFeePerGas) ||
        !bumped(cleanFees.maxPriorityFeePerGas, existing.fees.maxPriorityFeePerGas)
      ) {
        throw new ReplacementUnderpricedError(
          'replacement must raise both fee fields by at least 12.5%',
        );
      }
      this.pool.delete(existing.hash);
    }

    this.pool.set(hash, {
      type: 'bridge',
      hash,
      seq: this.seq++,
      signer,
      nonce,
      call,
      fees: cleanFees,
    });
    if (this.automine) this.mineBlock(true);
    return hash;
  }

  private addControl(action: ControlTx['action']): TxHash {
    const seq = this.seq++;
    const hash = this.txHash({ control: action, seq });
    this.pool.set(hash, { type: 'control', hash, seq, action });
    if (this.automine) this.mineBlock(true);
    return hash;
  }

  /** The next transaction to include, or undefined when nothing in the pool is ready. */
  private nextReady(state: WorldState, baseFee: bigint): FakeTx | undefined {
    let best: FakeTx | undefined;
    let bestTip = -1n;
    for (const tx of this.pool.values()) {
      if (tx.type === 'control') {
        if (!best || best.type !== 'control' || tx.seq < best.seq) best = tx;
        continue;
      }
      if (best?.type === 'control') continue;
      if (tx.nonce !== state.nonces[tx.signer] || tx.fees.maxFeePerGas < baseFee) continue;
      const headroom = tx.fees.maxFeePerGas - baseFee;
      const tip = tx.fees.maxPriorityFeePerGas < headroom ? tx.fees.maxPriorityFeePerGas : headroom;
      if (tip > bestTip || (tip === bestTip && best !== undefined && tx.seq < best.seq)) {
        best = tx;
        bestTip = tip;
      }
    }
    return best;
  }

  private mineBlock(includePool: boolean): void {
    const parent = this.head;
    const number = parent.ref.number + 1n;
    const timestamp = parent.ref.timestamp + this.blockTimeSeconds;
    let state = parent.state.clone();
    const txs: FakeTx[] = [];
    const outcomes: {
      tx: FakeTx;
      status: Receipt['status'];
      revertReason?: string;
      events: EventBody[];
    }[] = [];

    for (let tx = includePool ? this.nextReady(state, this.currentBaseFee) : undefined; tx;) {
      this.pool.delete(tx.hash);
      const draft = state.clone();
      try {
        const events = this.execute(draft, tx);
        state = draft;
        outcomes.push({ tx, status: 'success', events });
      } catch (error) {
        if (!(error instanceof Revert)) throw error;
        outcomes.push({ tx, status: 'reverted', revertReason: error.reason, events: [] });
      }
      // A mined transaction consumes its nonce whether it succeeded or reverted.
      if (tx.type === 'bridge') state.nonces[tx.signer] = tx.nonce + 1;
      txs.push(tx);
      tx = this.nextReady(state, this.currentBaseFee);
    }

    const hash = this.blockHash(number, parent.ref.hash, timestamp, txs);
    const receipts = new Map<TxHash, Receipt>();
    const events: ChainEvent[] = [];
    for (const { tx, status, revertReason, events: bodies } of outcomes) {
      receipts.set(tx.hash, {
        txHash: tx.hash,
        status,
        blockNumber: number,
        blockHash: hash,
        ...(revertReason === undefined ? {} : { revertReason }),
      });
      for (const body of bodies) {
        events.push({
          ...body,
          blockNumber: number,
          blockHash: hash,
          txHash: tx.hash,
          logIndex: events.length,
        } as ChainEvent);
      }
      this.minedIn.set(tx.hash, Number(number));
    }
    this.blocks.push({
      ref: { number, hash, parentHash: parent.ref.hash, timestamp },
      txs,
      receipts,
      events,
      state,
    });
  }

  /** Runs one transaction against `s` (a draft). Throws `Revert` exactly where the contract would. */
  private execute(s: WorldState, tx: FakeTx): EventBody[] {
    const events: EventBody[] = [];
    if (tx.type === 'control') {
      const { action } = tx;
      switch (action.kind) {
        case 'pause':
          if (action.paused && s.paused) throw new Revert('EnforcedPause');
          if (!action.paused && !s.paused) throw new Revert('ExpectedPause');
          s.paused = action.paused;
          return events; // Paused/Unpaused are not bridge events
        case 'holderTransfers':
          s.holderTransfersEnabled = action.enabled;
          return events; // HolderTransfersSet is not a bridge event
        case 'transfer':
          // SettlementToken.transfer -> ERC20.transfer -> _transfer(msg.sender, to, value)
          if (!s.holderTransfersEnabled) throw new Revert('HolderTransfersDisabled');
          this.transferInternal(s, action.from, action.to, action.amount, events);
          return events;
        case 'transferFrom':
          // SettlementToken.transferFrom: switch, spender, then ERC20.transferFrom
          if (!s.holderTransfersEnabled) throw new Revert('HolderTransfersDisabled');
          if (!s.isAllowed(action.spender)) throw new Revert('NotAllowed');
          this.spendAllowance(s, action.from, action.spender, action.amount);
          this.transferInternal(s, action.from, action.to, action.amount, events);
          return events;
        case 'approve':
          // SettlementToken.approve: for a non-zero value the switch, pause and owner checks run
          // first, then ERC20._approve. A zero value (a revocation) skips them, so an owner can
          // always take an allowance back, even while the switch is off, paused or frozen.
          if (action.amount !== 0n) {
            if (!s.holderTransfersEnabled) throw new Revert('HolderTransfersDisabled');
            if (s.paused) throw new Revert('EnforcedPause');
            if (!s.isAllowed(action.owner)) throw new Revert('NotAllowed');
          }
          this.approveInternal(s, action.owner, action.spender, action.amount);
          return events; // Approval is not a bridge event
      }
    }

    const { call } = tx;
    switch (call.kind) {
      case 'setVerified':
        this.consumeRegistryRef(s, call.ref);
        if (call.account === zeroAddress) throw new Revert('ZeroAddress');
        if (call.verified) s.verified.add(call.account);
        else s.verified.delete(call.account);
        events.push({
          kind: 'VerificationSet',
          account: call.account,
          verified: call.verified,
          ref: call.ref,
        });
        return events;
      case 'setFrozen':
        this.consumeRegistryRef(s, call.ref);
        if (call.account === zeroAddress) throw new Revert('ZeroAddress');
        if (call.frozen) s.frozen.add(call.account);
        else s.frozen.delete(call.account);
        events.push({
          kind: 'FrozenSet',
          account: call.account,
          frozen: call.frozen,
          ref: call.ref,
        });
        return events;
      case 'mint':
        this.consumeTokenRef(s, call.ref, call.amount);
        if (call.to === zeroAddress) throw new Revert('ERC20InvalidReceiver');
        this.update(s, zeroAddress, call.to, call.amount, events);
        events.push({ kind: 'Minted', to: call.to, amount: call.amount, ref: call.ref });
        return events;
      case 'burn':
        this.consumeTokenRef(s, call.ref, call.amount);
        if (call.from === zeroAddress) throw new Revert('ERC20InvalidSender');
        this.update(s, call.from, zeroAddress, call.amount, events);
        events.push({ kind: 'Burned', from: call.from, amount: call.amount, ref: call.ref });
        return events;
      case 'settleTransfer':
        this.consumeTokenRef(s, call.ref, call.amount);
        if (call.from === call.to) throw new Revert('SelfTransfer');
        this.transferInternal(s, call.from, call.to, call.amount, events);
        events.push({
          kind: 'SettledTransfer',
          from: call.from,
          to: call.to,
          amount: call.amount,
          ref: call.ref,
        });
        return events;
    }
  }

  /** OpenZeppelin `ERC20._transfer`: zero sender, zero receiver, then `_update`. */
  private transferInternal(
    s: WorldState,
    from: Address,
    to: Address,
    value: bigint,
    events: EventBody[],
  ): void {
    if (from === zeroAddress) throw new Revert('ERC20InvalidSender');
    if (to === zeroAddress) throw new Revert('ERC20InvalidReceiver');
    this.update(s, from, to, value, events);
  }

  /** OpenZeppelin `ERC20._approve` (no event needed: Approval is not a bridge event). */
  private approveInternal(s: WorldState, owner: Address, spender: Address, value: bigint): void {
    if (owner === zeroAddress) throw new Revert('ERC20InvalidApprover');
    if (spender === zeroAddress) throw new Revert('ERC20InvalidSpender');
    s.allowances.set(`${owner}:${spender}`, value);
  }

  /** OpenZeppelin `ERC20._spendAllowance`: an infinite allowance is never decreased. */
  private spendAllowance(s: WorldState, owner: Address, spender: Address, value: bigint): void {
    const current = s.allowance(owner, spender);
    if (current === maxUint256) return;
    if (current < value) throw new Revert('ERC20InsufficientAllowance');
    this.approveInternal(s, owner, spender, current - value);
  }

  /** `ComplianceRegistry._consume`. */
  private consumeRegistryRef(s: WorldState, ref: Bytes32): void {
    if (ref === zeroHash) throw new Revert('InvalidReference');
    if (s.registryRefs.has(ref)) throw new Revert('ReferenceAlreadyUsed');
    s.registryRefs.add(ref);
  }

  /** `SettlementToken._consume`: zero reference, then zero amount, then reuse. */
  private consumeTokenRef(s: WorldState, ref: Bytes32, amount: bigint): void {
    if (ref === zeroHash) throw new Revert('InvalidReference');
    if (amount === 0n) throw new Revert('ZeroAmount');
    if (s.tokenRefs.has(ref)) throw new Revert('ReferenceAlreadyUsed');
    s.tokenRefs.add(ref);
  }

  /** `SettlementToken._update` followed by OpenZeppelin's `ERC20._update`. */
  private update(
    s: WorldState,
    from: Address,
    to: Address,
    value: bigint,
    events: EventBody[],
  ): void {
    if (s.paused) throw new Revert('EnforcedPause');
    if (from !== zeroAddress && !s.isAllowed(from)) throw new Revert('NotAllowed');
    if (to !== zeroAddress && !s.isAllowed(to)) throw new Revert('NotAllowed');
    if (from === zeroAddress) {
      if (s.totalSupply + value > maxUint256) throw new Revert('Panic');
      s.totalSupply += value;
    } else {
      const balance = s.balanceOf(from);
      if (balance < value) throw new Revert('ERC20InsufficientBalance');
      s.balances.set(from, balance - value);
    }
    if (to === zeroAddress) s.totalSupply -= value;
    else s.balances.set(to, s.balanceOf(to) + value);
    events.push({ kind: 'Transfer', from, to, amount: value });
  }
}
