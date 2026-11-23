/**
 * @file Detecting a chain reorganisation from the blocks the indexer saved, and choosing the next
 * block range to scan.
 *
 * The indexer keeps a window of recent blocks (number, hash, parent hash). After a reorg, the
 * chain's hash at some of those heights differs. Everything above the highest block that still
 * matches (the fork point) must be rolled back: its events may no longer exist. If nothing in the
 * window matches, the reorg is deeper than the window and a person must re-sync from further back.
 *
 * A height where the node reports NO block is not evidence of a reorg: a lagging node, or a load
 * balancer that sent this request to a node behind the last one, simply has not seen it yet.
 * Rolling back on that would throw away good data and re-index it, and a flapping node would make
 * the indexer oscillate. So "no block" is reported as `nodeBehind` and only a DIFFERENT hash at
 * some height triggers a rollback. (A chain that really got shorter shows up as a different hash
 * at the fork height once the node has the new branch.)
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
  /** Whether some stored block has a DIFFERENT canonical hash now (proof of a reorg). */
  readonly reorged: boolean;
  /**
   * Whether the node had no block at one or more stored heights above the fork point. With no
   * differing hash, this alone causes no rollback: wait, or ask another node.
   */
  readonly nodeBehind: boolean;
  /**
   * The highest stored block that still matches the chain, or `null` when none does (or the window
   * is empty, or the node has none of its heights). Everything at or below it is safe.
   */
  readonly forkPoint: bigint | null;
  /**
   * Stored block numbers to undo, newest first. Empty unless `reorged`. When `reorged`, it holds
   * every stored block above the fork point, including heights the node had no block for (they
   * descend from a replaced block, so they are not canonical either).
   */
  readonly rollback: readonly bigint[];
  /** True when a reorg was proven and no stored block matches: the fork is older than the window. */
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
 * Handles: empty window, no reorg, a shallow reorg, a node that has not reached some (or any) of
 * the stored heights (`nodeBehind`, no rollback), and a reorg deeper than the window
 * (`beyondWindow`).
 *
 * @param storedWindow The indexer's recent blocks, ascending and hash-linked.
 * @param canonicalHashAt The chain's current hash at a height, as a map or a function.
 */
export function detectReorg(
  storedWindow: readonly StoredBlock[],
  canonicalHashAt: CanonicalLookup,
): ReorgReport {
  assertWindow(storedWindow);
  const above: bigint[] = [];
  let differs = false;
  let missing = false;
  let forkPoint: bigint | null = null;
  // Walk down from the newest block. Blocks are hash-linked, so the first match from the top
  // implies every block below it matches too.
  for (let i = storedWindow.length - 1; i >= 0; i -= 1) {
    const block = storedWindow[i] as StoredBlock;
    const canonical = lookupHash(canonicalHashAt, block.number);
    if (canonical === block.hash) {
      forkPoint = block.number;
      break;
    }
    if (canonical === null) missing = true;
    else differs = true;
    above.push(block.number);
  }
  return {
    reorged: differs,
    nodeBehind: missing,
    forkPoint,
    rollback: differs ? above : [],
    beyondWindow: differs && forkPoint === null,
  };
}

/** Inputs to `nextScanRange`. */
export interface ScanInputs {
  /**
   * The highest block whose events are stored. To start, pass one below the first block to scan:
   * `deployBlock - 1n`, or `-1n` to scan from genesis (block 0). Values below `-1n` are refused.
   */
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
 * tail and stop before the head, and the newest blocks would never be scanned. `lastIndexed = -1n`
 * means "nothing indexed yet, start from genesis". Both conventions were reviewed and accepted.
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
