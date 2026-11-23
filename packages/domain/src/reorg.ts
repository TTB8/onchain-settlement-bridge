/**
 * @file Detecting a chain reorganisation from the blocks the indexer saved, and choosing the next
 * block range to scan.
 *
 * The indexer keeps a window of recent blocks (number, hash, parent hash). After a reorg, the
 * chain's hash at some of those heights differs. Everything above the highest block that still
 * matches (the fork point) must be rolled back: its events may no longer exist. If nothing in the
 * window matches, the reorg is deeper than the window and a person must re-sync from further back.
 */

import { InvalidInputError } from './errors';
import type { Hex } from './primitives';

/** A block the indexer recorded. Structurally a subset of the chain's `BlockRef`. */
export interface StoredBlock {
  /** Its height. */
  readonly number: bigint;
  /** Its hash when it was indexed. */
  readonly hash: Hex;
  /** Its parent's hash when it was indexed. */
  readonly parentHash: Hex;
}

/** The chain's current hash at a height, or `null` if the chain has no block there (yet, or any more). */
export type CanonicalLookup = ReadonlyMap<bigint, Hex> | ((blockNumber: bigint) => Hex | null);

/** The result of comparing the stored window with the chain. */
export interface ReorgReport {
  /** Whether any stored block is no longer on the canonical chain. */
  readonly reorged: boolean;
  /**
   * The highest stored block that still matches the chain, or `null` when none does (or the window
   * is empty). Everything at or below it is safe.
   */
  readonly forkPoint: bigint | null;
  /** Stored block numbers that are no longer canonical, newest first (the order to undo them in). */
  readonly rollback: readonly bigint[];
  /** True when no stored block matches: the fork is older than the window. Needs a person. */
  readonly beyondWindow: boolean;
}

function lookupHash(canonical: CanonicalLookup, n: bigint): Hex | null {
  return typeof canonical === 'function' ? canonical(n) : (canonical.get(n) ?? null);
}

/**
 * Throws `InvalidInputError` unless the window is ascending, contiguous and hash-linked. A window
 * that is not a chain cannot be compared with one: the answer would be meaningless.
 */
function assertWindow(window: readonly StoredBlock[]): void {
  for (let i = 1; i < window.length; i += 1) {
    const prev = window[i - 1] as StoredBlock;
    const cur = window[i] as StoredBlock;
    if (cur.number !== prev.number + 1n) {
      throw new InvalidInputError(`stored window is not contiguous at block ${cur.number}`);
    }
    if (cur.parentHash !== prev.hash) {
      throw new InvalidInputError(`stored window is not hash-linked at block ${cur.number}`);
    }
  }
}

/**
 * Compares the stored window with the chain and reports the fork point and what to roll back.
 * Handles: empty window, no reorg, a shallow reorg, a chain now shorter than the window (heights
 * with no block are rolled back), and a reorg deeper than the window (`beyondWindow`).
 *
 * @param storedWindow The indexer's recent blocks, ascending and hash-linked.
 * @param canonicalHashAt The chain's current hash at a height, as a map or a function.
 */
export function detectReorg(
  storedWindow: readonly StoredBlock[],
  canonicalHashAt: CanonicalLookup,
): ReorgReport {
  assertWindow(storedWindow);
  const rollback: bigint[] = [];
  // Walk down from the newest block. Blocks are hash-linked, so the first match from the top
  // implies every block below it matches too.
  for (let i = storedWindow.length - 1; i >= 0; i -= 1) {
    const block = storedWindow[i] as StoredBlock;
    if (lookupHash(canonicalHashAt, block.number) === block.hash) {
      return {
        reorged: rollback.length > 0,
        forkPoint: block.number,
        rollback,
        beyondWindow: false,
      };
    }
    rollback.push(block.number);
  }
  return {
    reorged: rollback.length > 0,
    forkPoint: null,
    rollback,
    beyondWindow: rollback.length > 0,
  };
}

/** Inputs to `nextScanRange`. */
export interface ScanInputs {
  /** The highest block whose events are stored. Use one below the deploy block to start. */
  readonly lastIndexed: bigint;
  /** The chain's newest block. */
  readonly head: bigint;
  /** Confirmations before a block is final (>= 1). Blocks above `head - depth + 1` may still change. */
  readonly depth: number;
  /** The most blocks to scan in one call (>= depth, so the unconfirmed tail always fits). */
  readonly maxBatch: number;
}

/** An inclusive block range. Structurally identical to the chain's `BlockRange`. */
export interface ScanRange {
  /** First block, inclusive. */
  readonly fromBlock: bigint;
  /** Last block, inclusive. */
  readonly toBlock: bigint;
}

/**
 * The next inclusive range for the indexer, or `null` when there is nothing to scan.
 *
 * It starts at the earlier of "just after what is stored" and "the first block that is not yet
 * final", so the unconfirmed tail is re-scanned on every pass (events there can change in a reorg).
 * It never goes past `head` and never spans more than `maxBatch` blocks.
 *
 * `maxBatch` must be at least `depth`: otherwise, once caught up, every pass would start at the
 * tail and stop before the head, and the newest blocks would never be scanned.
 */
export function nextScanRange(inputs: ScanInputs): ScanRange | null {
  const { lastIndexed, head, depth, maxBatch } = inputs;
  if (!Number.isSafeInteger(depth) || depth < 1) {
    throw new InvalidInputError(`depth must be an integer >= 1, got ${depth}`);
  }
  if (!Number.isSafeInteger(maxBatch) || maxBatch < depth) {
    throw new InvalidInputError(`maxBatch must be an integer >= depth (${depth}), got ${maxBatch}`);
  }
  if (lastIndexed < -1n || head < 0n) {
    throw new InvalidInputError('lastIndexed must be >= -1 and head >= 0');
  }
  const firstUnfinal = head - BigInt(depth) + 2n;
  let fromBlock = lastIndexed + 1n < firstUnfinal ? lastIndexed + 1n : firstUnfinal;
  if (fromBlock < 0n) fromBlock = 0n;
  if (fromBlock > head) return null;
  const batchEnd = fromBlock + BigInt(maxBatch) - 1n;
  return { fromBlock, toBlock: batchEnd < head ? batchEnd : head };
}
