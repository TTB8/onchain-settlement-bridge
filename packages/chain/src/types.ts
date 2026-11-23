/**
 * @file The chain contract of the bridge: every call the system can make, every event it can read,
 * and the one interface (`ChainGateway`) that the rest of the code uses to reach a chain.
 *
 * The interface speaks the language of our two contracts, not of a chain library. That lets an
 * in-memory fake stand in for a real node in tests (including failures a real node only produces
 * by accident), and keeps viem out of every package except the one real implementation.
 *
 * Conventions: amounts are `bigint` in the token's smallest unit; addresses are lowercase hex;
 * every on-chain action carries a single-use 32-byte reference that names the off-chain operation
 * it settles.
 */

import type { ChainError } from './errors';

/** A lowercase `0x`-prefixed 20-byte address. */
export type Address = `0x${string}`;

/** A `0x`-prefixed hex string of any length. */
export type Hex = `0x${string}`;

/** A 32-byte value, as `0x` plus 64 hex characters. */
export type Bytes32 = `0x${string}`;

/** The hash of a transaction. */
export type TxHash = `0x${string}`;

/**
 * The accounts the bridge signs with. The engine names a signer; only the gateway ever holds a key.
 * - `settlement` holds the minter and settler roles on the token.
 * - `compliance` holds the compliance role on the registry.
 * Each has its own nonce sequence.
 */
export type SignerName = 'settlement' | 'compliance';

/** Every state-changing call the bridge makes on its two contracts. */
export type ContractCall =
  | { kind: 'mint'; to: Address; amount: bigint; ref: Bytes32 }
  | { kind: 'burn'; from: Address; amount: bigint; ref: Bytes32 }
  | { kind: 'settleTransfer'; from: Address; to: Address; amount: bigint; ref: Bytes32 }
  | { kind: 'setVerified'; account: Address; verified: boolean; ref: Bytes32 }
  | { kind: 'setFrozen'; account: Address; frozen: boolean; ref: Bytes32 };

/** Which signer must send a given call. The gateway rejects a mismatch. */
export const SIGNER_FOR_CALL: Readonly<Record<ContractCall['kind'], SignerName>> = {
  mint: 'settlement',
  burn: 'settlement',
  settleTransfer: 'settlement',
  setVerified: 'compliance',
  setFrozen: 'compliance',
};

/** EIP-1559 fee fields, in wei. */
export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Everything needed to send one transaction. The caller owns the nonce and the fees. */
export interface SubmitRequest {
  signer: SignerName;
  call: ContractCall;
  /** The signer's transaction count to use. Reusing a pending nonce with higher fees replaces it. */
  nonce: number;
  fees: Fees;
}

/**
 * A transaction signed but not sent: the exact bytes to broadcast, and their hash
 * (`hash === keccak256(raw)`). The engine persists both BEFORE broadcasting, so after a crash it
 * can rebroadcast exactly the same bytes, and look the transaction up by hash.
 */
export interface SignedTransaction {
  hash: TxHash;
  raw: Hex;
}

/** The identifying fields of a block, enough to detect a reorganisation. */
export interface BlockRef {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  /** Seconds since the epoch, UTC. */
  timestamp: bigint;
}

/** The outcome of a transaction that was mined. */
export interface Receipt {
  txHash: TxHash;
  /** `reverted` means it was mined, spent its gas, and changed nothing. */
  status: 'success' | 'reverted';
  blockNumber: bigint;
  blockHash: Hex;
  /**
   * For a reverted transaction, the name of the contract error when it could be decoded, such as
   * `ReferenceAlreadyUsed` or `NotAllowed`. Absent when unknown.
   */
  revertReason?: string;
}

/** What the node knows about a transaction by hash. */
export interface TransactionInfo {
  hash: TxHash;
  signer: SignerName;
  nonce: number;
  fees: Fees;
  /** `null` while it is still waiting in the node's pool. */
  blockNumber: bigint | null;
}

/** Where an event was emitted, shared by every event kind. */
export interface EventPosition {
  blockNumber: bigint;
  blockHash: Hex;
  txHash: TxHash;
  logIndex: number;
}

/**
 * Every event the bridge reads from its two contracts. The four reference-carrying events say
 * which off-chain operation caused them. A `Transfer` with no reference event from the same
 * transaction was not caused by the bridge, which is what a reconciler looks for.
 */
export type ChainEvent = EventPosition &
  (
    | { kind: 'Minted'; to: Address; amount: bigint; ref: Bytes32 }
    | { kind: 'Burned'; from: Address; amount: bigint; ref: Bytes32 }
    | { kind: 'SettledTransfer'; from: Address; to: Address; amount: bigint; ref: Bytes32 }
    | { kind: 'Transfer'; from: Address; to: Address; amount: bigint }
    | { kind: 'VerificationSet'; account: Address; verified: boolean; ref: Bytes32 }
    | { kind: 'FrozenSet'; account: Address; frozen: boolean; ref: Bytes32 }
  );

/** An account's standing in the compliance registry. */
export interface ComplianceStatus {
  verified: boolean;
  frozen: boolean;
}

/** An inclusive range of block numbers. */
export interface BlockRange {
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * Everything the bridge needs from a chain. Implemented by a viem-backed gateway for real chains
 * and by an in-memory fake for tests.
 *
 * Failures to submit or to reach the node throw a `ChainError` subclass (see `errors.ts`). A
 * transaction that was mined and reverted is NOT an error: it is a `Receipt` with status
 * `reverted`. Reads accept an optional block number so that a reconciler can look at one
 * consistent point in history.
 */
export interface ChainGateway {
  /** The chain id the node reports. */
  getChainId(): Promise<number>;

  /** The number of the newest block. */
  getHeadBlock(): Promise<bigint>;

  /** The block with this number, or `null` if the chain has none (for example after a reorg). */
  getBlock(number: bigint): Promise<BlockRef | null>;

  /** The address a signer sends from. Lowercase. */
  signerAddress(signer: SignerName): Address;

  /**
   * The signer's transaction count as the node sees it: `confirmed` counts mined transactions,
   * `pending` also counts those waiting in the pool. The next free nonce is `pending`.
   *
   * With `blockNumber`, both `confirmed` and `pending` are the count mined up to and including
   * that block (there is no pool at a past block). Read it at `head - depth + 1` to learn whether
   * a nonce is FINALLY used: a nonce below that count can no longer be undone by a reorg of
   * fewer than `depth` blocks.
   */
  getNonce(
    signer: SignerName,
    blockNumber?: bigint,
  ): Promise<{ confirmed: number; pending: number }>;

  /** A fee suggestion for the next block, from the node. */
  estimateFees(): Promise<Fees>;

  /**
   * Sends a transaction. Throws `NonceTooLowError`, `ReplacementUnderpricedError`,
   * `AlreadyKnownError`, `InsufficientFundsError`, `ChainUnavailableError` (outcome unknown) or
   * `SubmissionRejectedError`. Throws `SubmissionRejectedError` if the call is for the wrong signer.
   *
   * Fail-safe: `SubmissionRejectedError` is only thrown for an allowlist of answers that mean THIS
   * node refused THIS submission. That is not proof the transaction can never be mined: another
   * node may already hold the same signed bytes, so a rejected attempt still counts in the
   * engine's `attemptCanStillMine` check. Any node error the gateway does not recognise is a
   * `ChainUnavailableError`: the transaction may have been forwarded and may still be mined. So
   * the caller must keep a record of EVERY transaction it signed (hash, nonce, fees, reference),
   * whatever error came back, until that nonce is final (see `getNonce` with a block), and look up
   * those records and the reference (`readReferenceUsed`) before treating an operation as not
   * sent.
   */
  submit(request: SubmitRequest): Promise<TxHash>;

  /**
   * Signs a transaction with the named signer's key and returns its bytes and hash, WITHOUT
   * sending it and without consuming anything: the nonce and fees are used exactly as given (no
   * nonce is allocated or reserved), and the node is not contacted, so it works during an outage.
   * The same request always yields the same bytes and hash. Validates like `submit`: throws
   * `SubmissionRejectedError` for a call sent with the wrong signer or for arguments that cannot be
   * encoded, before signing.
   *
   * This is the first half of "persist every signed transaction before broadcasting": sign,
   * store `{ hash, raw }` with the operation, then `sendRaw(raw)`.
   */
  signTransaction(request: SubmitRequest): Promise<SignedTransaction>;

  /**
   * Broadcasts exactly these signed bytes and returns their hash. Idempotent: bytes the node
   * already knows (waiting in its pool, or already mined) return the hash successfully, so a
   * rebroadcast after a crash or a timeout is always safe. Every other failure follows the same
   * fail-safe discipline as `submit`: `NonceTooLowError` (the nonce was used by OTHER bytes),
   * `ReplacementUnderpricedError`, `InsufficientFundsError`, `SubmissionRejectedError` (THIS node
   * refused; the attempt still counts until its nonce is final) or `ChainUnavailableError`
   * (outcome unknown). It never throws `AlreadyKnownError`.
   */
  sendRaw(raw: Hex): Promise<TxHash>;

  /** The receipt, or `null` if the transaction has not been mined. */
  getReceipt(hash: TxHash): Promise<Receipt | null>;

  /** What the node knows about the transaction, or `null` if it has never seen it or dropped it. */
  getTransaction(hash: TxHash): Promise<TransactionInfo | null>;

  /**
   * Every bridge event in the range from both contracts, in chain order: by block, then log index.
   * Includes the token's standard `Transfer` events.
   */
  getEvents(range: BlockRange): Promise<ChainEvent[]>;

  /** The token balance of a holder, at a block or at the head. */
  readBalance(holder: Address, blockNumber?: bigint): Promise<bigint>;

  /** The token's total supply, at a block or at the head. */
  readTotalSupply(blockNumber?: bigint): Promise<bigint>;

  /**
   * The contract's own single-use flag for a reference (`referenceUsed(ref)` on the token or on
   * the registry; the two contracts keep separate sets), at a block or at the head. This is the
   * authoritative answer: a `ReferenceAlreadyUsed` revert with no matching event in our index
   * means the index is incomplete and the operation already happened on chain.
   */
  readReferenceUsed(
    contract: 'token' | 'registry',
    ref: Bytes32,
    blockNumber?: bigint,
  ): Promise<boolean>;

  /** The registry's verification and freeze flags for an account, at a block or at the head. */
  readCompliance(account: Address, blockNumber?: bigint): Promise<ComplianceStatus>;
}

/** Re-exported so callers can type a catch clause without importing two modules. */
export type { ChainError };
