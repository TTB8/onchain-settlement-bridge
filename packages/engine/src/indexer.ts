/**
 * @file The indexer: copies the bound deployment's events into `chain_event`, with the block each
 * came from, and keeps that copy consistent with the node through reorgs.
 *
 * A pass (`runOnce`):
 *
 * 1. Head, and the stored window: the newest `reorgWindow` rows of `indexed_block` up to
 *    `last_indexed_block` (the indexer records the hash and parent hash of EVERY block it scans).
 * 2. `detectReorg` against hashes read from the NODE now (`getBlock`), never from our own rows
 *    (obligation 14):
 *    - `beyondWindow`: the fork is older than anything we kept. Stop and raise
 *      `reorg_beyond_window`; nothing is written, now or on later passes, until a person acts.
 *    - `reorged`: in ONE transaction, remove the orphaned blocks above the fork point (their
 *      events go with them, see below), rewind `last_indexed_block` to the fork point, and write
 *      an audit row. The next pass re-scans from there.
 *    - `nodeBehind` (the node has no block at a stored height, and no hash differs): neither roll
 *      back nor advance. A lagging node behind a load balancer is not a reorg.
 * 3. The next range from `nextScanRange` (it always re-scans the not-yet-final tail and never
 *    goes past the head). The blocks of the range are read from the node and must hash-link to
 *    each other and to the stored block below; every event must name the block hash the node just
 *    gave for its height. Anything else means the chain moved during the pass: nothing is written
 *    and the next pass starts over.
 * 4. In ONE transaction: insert the new blocks, insert the events (unique on deployment + block
 *    hash + log index, `skipDuplicates`, so re-scanning a range writes no duplicate), and advance
 *    `last_indexed_block`. A stored block at a scanned height with a different hash aborts the
 *    write (a reorg raced the pass; step 2 handles it next time).
 *
 * Finality is not stored: whether an event is final is `head - block + 1 >= depth` at the moment
 * someone acts on it, and whether it is canonical is a comparison with the node's hash at that
 * moment (the monitor does both). A stored flag would be stale the instant the head moves.
 *
 * Deviation from the brief, forced by the schema: `chain_event` has no "canonical" column and its
 * foreign key to `indexed_block` is ON DELETE CASCADE, and `indexed_block` keeps one row per
 * height. So an orphaned block and its events are deleted on rollback (the audit row records the
 * rollback). Nothing relies on orphaned rows surviving: every consumer re-checks block hashes
 * against the node. See the engine README's open questions.
 */

import {
  type BlockRef,
  ChainError,
  type ChainEvent as GatewayEvent,
  type ChainGateway,
} from '@bridge/chain';
import { Prisma, type PrismaClient } from '@bridge/db';
import { auditEntryFor, detectReorg, nextScanRange, type StoredBlock } from '@bridge/domain';

import type { AlarmSink } from './alarms';
import { writeAudit } from './ledger-writes';
import type { Clock } from './ports';
import { bindingOf, type DeploymentBinding, loadBoundDeployment } from './signer-binding';
import { runTransaction, type TransactionOptions, type Tx } from './transaction';

/** Indexer limits. */
export interface IndexerPolicy {
  /** Confirmations before a block is final (>= 1). */
  readonly confirmationDepth: number;
  /** Most blocks per pass (>= depth). */
  readonly maxBatch: number;
  /** Stored blocks compared with the node each pass (>= depth). */
  readonly reorgWindow: number;
  /** Passes in a row without progress (unknown / node behind) before `indexer_stalled`. Default 10. */
  readonly stallPasses?: number;
}

/** Construction options for `Indexer`. */
export interface IndexerOptions {
  /** The database. */
  readonly prisma: PrismaClient;
  /** The chain. */
  readonly gateway: ChainGateway;
  /** The time source (audit rows, alarms). */
  readonly clock: Clock;
  /** Limits. */
  readonly policy: IndexerPolicy;
  /** Where alarms go. */
  readonly alarms: AlarmSink;
  /** Transaction settings. */
  readonly transactions?: TransactionOptions;
}

/** What one pass did. */
export type IndexerResult =
  /** No bound deployment row, or a read failed / the chain moved mid-pass: nothing written. */
  | { readonly status: 'unknown' }
  /** The node is behind a stored block: no rollback, no advance. */
  | { readonly status: 'node_behind' }
  /** A reorg older than the window: stopped, a person must act. */
  | { readonly status: 'halted' }
  /** Orphaned blocks removed and the cursor rewound to `forkPoint`. */
  | { readonly status: 'rolled_back'; readonly forkPoint: bigint; readonly removed: number }
  /** Nothing new to scan. */
  | { readonly status: 'idle'; readonly lastIndexed: bigint }
  /** Scanned `fromBlock..toBlock`. */
  | {
      readonly status: 'scanned';
      readonly fromBlock: bigint;
      readonly toBlock: bigint;
      readonly events: number;
    };

class ChainMovedError extends Error {}

/** The `chain_event` columns for one gateway event. */
function eventRow(deploymentId: string, e: GatewayEvent): Prisma.ChainEventCreateManyInput {
  const base = {
    deploymentId,
    blockNumber: e.blockNumber,
    blockHash: e.blockHash.toLowerCase(),
    txHash: e.txHash.toLowerCase(),
    logIndex: e.logIndex,
    kind: e.kind,
  };
  switch (e.kind) {
    case 'Minted':
      return {
        ...base,
        toAddress: e.to,
        amount: new Prisma.Decimal(e.amount.toString()),
        ref: e.ref,
      };
    case 'Burned':
      return {
        ...base,
        fromAddress: e.from,
        amount: new Prisma.Decimal(e.amount.toString()),
        ref: e.ref,
      };
    case 'SettledTransfer':
      return {
        ...base,
        fromAddress: e.from,
        toAddress: e.to,
        amount: new Prisma.Decimal(e.amount.toString()),
        ref: e.ref,
      };
    case 'Transfer':
      return {
        ...base,
        fromAddress: e.from,
        toAddress: e.to,
        amount: new Prisma.Decimal(e.amount.toString()),
      };
    case 'VerificationSet':
      return { ...base, account: e.account, flagValue: e.verified, ref: e.ref };
    case 'FrozenSet':
      return { ...base, account: e.account, flagValue: e.frozen, ref: e.ref };
  }
}

/** Copies the bound deployment's events into the database. See the file comment. */
export class Indexer {
  private readonly prisma: PrismaClient;
  private readonly gateway: ChainGateway;
  private readonly clock: Clock;
  private readonly binding: DeploymentBinding;
  private readonly policy: IndexerPolicy;
  private readonly alarms: AlarmSink;
  private readonly transactions: TransactionOptions;
  private stuckPasses = 0;

  /** @param options Database, gateway, clock, binding, limits and alarm sink. */
  constructor(options: IndexerOptions) {
    const p = options.policy;
    if (!Number.isSafeInteger(p.confirmationDepth) || p.confirmationDepth < 1) {
      throw new RangeError('confirmationDepth must be an integer >= 1');
    }
    if (!Number.isSafeInteger(p.maxBatch) || p.maxBatch < p.confirmationDepth) {
      throw new RangeError('maxBatch must be an integer >= confirmationDepth');
    }
    if (!Number.isSafeInteger(p.reorgWindow) || p.reorgWindow < p.confirmationDepth) {
      throw new RangeError('reorgWindow must be an integer >= confirmationDepth');
    }
    this.prisma = options.prisma;
    this.gateway = options.gateway;
    this.clock = options.clock;
    this.binding = bindingOf(options.gateway);
    this.policy = p;
    this.alarms = options.alarms;
    this.transactions = options.transactions ?? {};
  }

  /** One pass. Never throws for a chain read: a failed read is `unknown` with nothing written. */
  async runOnce(): Promise<IndexerResult> {
    const result = await this.pass();
    // An indexer that cannot make progress is as bad as a stalled head (review L-1).
    if (result.status === 'unknown' || result.status === 'node_behind') {
      this.stuckPasses += 1;
      const limit = this.policy.stallPasses ?? 10;
      if (this.stuckPasses >= limit) {
        this.alarms.raise({
          kind: 'indexer_stalled',
          detail: `no indexer progress for ${this.stuckPasses} pass(es) (last: ${result.status})`,
          at: this.clock.now(),
        });
      }
    } else {
      this.stuckPasses = 0;
    }
    return result;
  }

  /** One pass, without the stall bookkeeping. */
  private async pass(): Promise<IndexerResult> {
    const d = await loadBoundDeployment(this.prisma, this.binding);
    if (d === null) return { status: 'unknown' };
    const state = await this.prisma.indexerState.findUnique({ where: { deploymentId: d.id } });
    const lastIndexed = state?.lastIndexedBlock ?? d.deploymentBlock - 1n;

    try {
      const chainId = await this.gateway.getChainId();
      if (BigInt(chainId) !== this.binding.chainId) return { status: 'unknown' };
      const head = await this.gateway.getHeadBlock();

      // 1-2. The stored window against the node.
      const stored = await this.prisma.indexedBlock.findMany({
        where: { deploymentId: d.id, number: { lte: lastIndexed } },
        orderBy: { number: 'desc' },
        take: this.policy.reorgWindow,
      });
      const window: StoredBlock[] = stored.reverse().map((b) => ({
        number: b.number,
        hash: b.hash as `0x${string}`,
        parentHash: b.parentHash as `0x${string}`,
      }));
      const canonical = new Map<bigint, `0x${string}`>();
      for (const b of window) {
        const ref = await this.gateway.getBlock(b.number);
        if (ref !== null) canonical.set(b.number, ref.hash);
      }
      const report = detectReorg(window, canonical);
      if (report.beyondWindow) {
        this.alarms.raise({
          kind: 'reorg_beyond_window',
          detail: `no stored block in the last ${window.length} matches the node`,
          at: this.clock.now(),
        });
        return { status: 'halted' };
      }
      if (report.reorged && report.forkPoint !== null) {
        return this.rollback(d.id, report.forkPoint, lastIndexed, d.deploymentBlock);
      }
      if (report.nodeBehind) return { status: 'node_behind' };

      // 3. The range, its blocks and its events, all from the node.
      const range = nextScanRange({
        lastIndexed,
        head,
        depth: this.policy.confirmationDepth,
        maxBatch: this.policy.maxBatch,
      });
      if (range === null) return { status: 'idle', lastIndexed };
      const blocks: BlockRef[] = [];
      for (let n = range.fromBlock; n <= range.toBlock; n += 1n) {
        const b = await this.gateway.getBlock(n);
        if (b === null) return { status: 'node_behind' };
        blocks.push(b);
      }
      const below = window.find((b) => b.number === range.fromBlock - 1n);
      for (let i = 0; i < blocks.length; i += 1) {
        const b = blocks[i] as BlockRef;
        const parent = i === 0 ? below?.hash : blocks[i - 1]?.hash;
        if (parent !== undefined && b.parentHash !== parent) return { status: 'unknown' };
      }
      const hashAt = new Map(blocks.map((b) => [b.number, b.hash.toLowerCase()]));
      const events = await this.gateway.getEvents(range);
      if (events.some((e) => hashAt.get(e.blockNumber) !== e.blockHash.toLowerCase())) {
        return { status: 'unknown' };
      }

      // 4. One transaction: blocks, events (idempotent), cursor.
      await runTransaction(
        this.prisma,
        async (tx) => {
          await lockIndexer(tx, d.id, lastIndexed, d.deploymentBlock);
          const existing = await tx.indexedBlock.findMany({
            where: { deploymentId: d.id, number: { gte: range.fromBlock, lte: range.toBlock } },
          });
          const have = new Map(existing.map((b) => [b.number, b.hash]));
          for (const b of blocks) {
            const h = have.get(b.number);
            if (h !== undefined && h !== b.hash.toLowerCase()) throw new ChainMovedError();
          }
          await tx.indexedBlock.createMany({
            data: blocks
              .filter((b) => !have.has(b.number))
              .map((b) => ({
                deploymentId: d.id,
                number: b.number,
                hash: b.hash.toLowerCase(),
                parentHash: b.parentHash.toLowerCase(),
                timestamp: new Date(Number(b.timestamp) * 1000),
              })),
            skipDuplicates: true,
          });
          await tx.chainEvent.createMany({
            data: events.map((e) => eventRow(d.id, e)),
            skipDuplicates: true,
          });
          const next = range.toBlock > lastIndexed ? range.toBlock : lastIndexed;
          await tx.indexerState.upsert({
            where: { deploymentId: d.id },
            create: { deploymentId: d.id, lastIndexedBlock: next },
            update: { lastIndexedBlock: next },
          });
        },
        this.transactions,
      );
      return {
        status: 'scanned',
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        events: events.length,
      };
    } catch (err) {
      if (err instanceof ChainMovedError) return { status: 'unknown' };
      // A chain read failed: unknown, nothing written (obligation 3).
      if (err instanceof ChainError) return { status: 'unknown' };
      throw err;
    }
  }

  /** Removes the blocks above `forkPoint` and rewinds the cursor, in one transaction. */
  private async rollback(
    deploymentId: string,
    forkPoint: bigint,
    lastIndexed: bigint,
    deploymentBlock: bigint,
  ): Promise<IndexerResult> {
    const at = this.clock.now();
    let removed;
    try {
      removed = await runTransaction(
        this.prisma,
        async (tx) => {
          await lockIndexer(tx, deploymentId, lastIndexed, deploymentBlock);
          // Every event about to go, listed in the audit row (what the index believed, and why it
          // no longer does).
          const orphaned = await tx.chainEvent.findMany({
            where: { deploymentId, blockNumber: { gt: forkPoint } },
            orderBy: [{ blockNumber: 'asc' }, { logIndex: 'asc' }],
          });
          const del = await tx.indexedBlock.deleteMany({
            where: { deploymentId, number: { gt: forkPoint } },
          });
          await tx.indexerState.update({
            where: { deploymentId },
            data: { lastIndexedBlock: forkPoint },
          });
          await writeAudit(
            tx,
            auditEntryFor({
              entity: 'indexer',
              entityId: deploymentId,
              fromState: `last_indexed:${lastIndexed}`,
              toState: `last_indexed:${forkPoint}`,
              detail: `reorg: ${del.count} orphaned block(s) above ${forkPoint} removed with their events`,
              at,
            }),
            {
              removedBlocks: del.count,
              removedEvents: orphaned.length,
              deletedEvents: JSON.stringify(
                orphaned.map((e) => ({
                  blockNumber: e.blockNumber.toString(),
                  blockHash: e.blockHash,
                  txHash: e.txHash,
                  logIndex: e.logIndex,
                  kind: e.kind,
                  ref: e.ref,
                  amount: e.amount === null ? null : e.amount.toFixed(),
                })),
              ),
            },
          );
          return del.count;
        },
        this.transactions,
      );
    } catch (err) {
      if (err instanceof ChainMovedError) return { status: 'unknown' };
      throw err;
    }
    return { status: 'rolled_back', forkPoint, removed: removed.value };
  }
}

/**
 * Serialises indexers of one deployment (review L-2): a transaction-scoped advisory lock on the
 * deployment, then a compare-and-set on the cursor. A second indexer that read the same cursor
 * waits for the lock, then sees the cursor moved and writes nothing (`ChainMovedError`).
 */
async function lockIndexer(
  tx: Tx,
  deploymentId: string,
  expectedLast: bigint,
  deploymentBlock: bigint,
): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${deploymentId}))) AS l`;
  const state = await tx.indexerState.findUnique({ where: { deploymentId } });
  const current = state?.lastIndexedBlock ?? deploymentBlock - 1n;
  if (current !== expectedLast) throw new ChainMovedError();
}
