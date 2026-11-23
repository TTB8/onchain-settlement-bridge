/**
 * @file The composition root: one `BridgeEngine` wires the operation service, the outbox
 * dispatcher with the settlement submitter, the transaction monitor and the indexer to one
 * database, one gateway (one deployment), one signer, one clock and one id source.
 *
 * `tick()` runs one pass of each, in the order that lets a pass finish an operation: dispatch
 * (sign, record, broadcast), index (copy the new events), monitor (decide on final evidence). It
 * holds no timer, so tests drive the engine deterministically. `start()` / `stop()` are a thin
 * loop around `tick()` for the worker process; the loop never overlaps two ticks.
 */

import type { ChainGateway } from '@bridge/chain';
import type { PrismaClient } from '@bridge/db';

const ADDRESS = /^0x[0-9a-f]{40}$/;

import { AlarmLog, type AlarmSink } from './alarms';
import { DeploymentMismatchError, InvalidRequestError } from './errors';
import { Indexer, type IndexerResult } from './indexer';
import { OperationService } from './operation-service';
import { type BackoffPolicy, type DispatchSummary, OutboxDispatcher } from './outbox-dispatcher';
import type { Clock, IdSource } from './ports';
import { describeError, type SanitizeOptions } from './redact';
import { SettlementSubmitter } from './settlement-submitter';
import type { RawTransactionInspector } from './signing';
import { bindingOf, type DeploymentBinding, isBound } from './signer-binding';
import type { TransactionOptions } from './transaction';
import { type MonitorSummary, TxMonitor } from './tx-monitor';

/**
 * Default resubmissions after a drop: 3. WHY: a node forgets a pooled transaction for transient
 * reasons (a restart, pool eviction under load, a load balancer switching to a node that never
 * saw it). Three rebroadcasts of the same bytes ride out those without resending forever; a
 * transaction that every node keeps dropping after that needs a person, not a fourth try. A
 * resubmission is always safe for the money (same reference, consumed once on chain), so the
 * limit only bounds noise and gas.
 */
export const DEFAULT_MAX_RESUBMITS = 3;

/**
 * Default seconds between rebroadcasts of a dropped transaction: 60. WHY: about five blocks on
 * Ethereum, enough for a restarted node to reload its pool or a peer to re-gossip, so a
 * rebroadcast is not wasted; short enough that a real drop costs a minute, not an hour.
 */
export const DEFAULT_DROP_RETRY_SECONDS = 60;

/**
 * Default seconds before a give-up is acted on: 1800. WHY: patience is time, not passes; half an
 * hour outlasts a base-fee spike, a node restart and a mempool flush, and still gets a person
 * involved (via `nonce_stuck`) well within the hour.
 */
export const DEFAULT_GIVE_UP_AFTER_SECONDS = 1800;

/** Default seconds a failed operation may stay unreversible before an alarm: 3600 (1 h). */
export const DEFAULT_FAILED_ALARM_AFTER_SECONDS = 3600;

/**
 * Default age before an unsent reserved operation is released: 900 s. WHY: it only applies once
 * the outbox row is dead (nothing can sign any more); the margin keeps a person's manual
 * re-queue of a dead row from racing the sweep.
 */
export const DEFAULT_ORPHAN_AFTER_SECONDS = 900;

/** Default fee bumps per nonce: 5 (each >= 12.5%, so the last pays about 1.8x the first). */
export const DEFAULT_MAX_BUMPS = 5;

/** Engine settings. */
export interface BridgeEngineConfig {
  /**
   * The chain this engine settles on. Optional: the gateway's `deployment()` is the binding; when
   * given it must agree (a guard against wiring the wrong gateway).
   */
  readonly chainId?: bigint;
  /** The token, as a cross-check on `gateway.deployment()` (any case; normalised). */
  readonly tokenAddress?: string;
  /** This worker's name, for outbox leases. */
  readonly workerId: string;
  /** Confirmations before anything counts (>= 1). */
  readonly confirmationDepth: number;
  /** The highest `maxFeePerGas` any attempt may pay. Required: no fee limit is a choice. */
  readonly feeCap: bigint;
  /** Resubmissions after a drop. Default `DEFAULT_MAX_RESUBMITS`. */
  readonly maxResubmits?: number;
  /** Fee bumps per nonce. Default `DEFAULT_MAX_BUMPS`. */
  readonly maxBumps?: number;
  /** Seconds before an unmined attempt is bumped. Default 120. */
  readonly stuckAfterSeconds?: number;
  /** Fee raise per bump, basis points. Default 1250 (the replacement minimum). */
  readonly bumpFeeBps?: number;
  /** Headroom on a first attempt's max fee, basis points. Default 2000. */
  readonly initialFeeMarginBps?: number;
  /** Wait when the fee estimate is above the cap, ms. Default 60 000. */
  readonly feeWaitMs?: number;
  /** Passes with an unchanged head (or a failed chain read) before an alarm. Default 10. */
  readonly headStallTicks?: number;
  /** Seconds between rebroadcasts of a dropped attempt. Default `DEFAULT_DROP_RETRY_SECONDS`. */
  readonly dropRetrySeconds?: number;
  /** Seconds before a give-up is acted on. Default `DEFAULT_GIVE_UP_AFTER_SECONDS`. */
  readonly giveUpAfterSeconds?: number;
  /** Seconds before `failed_not_reversible`. Default `DEFAULT_FAILED_ALARM_AFTER_SECONDS`. */
  readonly failedAlarmAfterSeconds?: number;
  /** Age before an unsent reserved operation is released. Default `DEFAULT_ORPHAN_AFTER_SECONDS`. */
  readonly orphanAfterSeconds?: number;
  /** Most blocks the indexer scans per pass. Default 500. */
  readonly indexerMaxBatch?: number;
  /** Stored blocks compared with the node per pass. Default 128. */
  readonly reorgWindow?: number;
  /** Delay between ticks in `start()`, ms. Default 2 000. */
  readonly pollIntervalMs?: number;
  /** Dispatcher batch size. Default 10. */
  readonly batchSize?: number;
  /** Dispatcher lease timeout, ms. Default 5 min. */
  readonly lockTimeoutMs?: number;
  /** Dispatcher handler time limit, ms. Default min(60 s, lock/2). */
  readonly handlerTimeoutMs?: number;
  /** Dispatcher backoff. */
  readonly backoff?: BackoffPolicy;
  /** Transaction settings for every component. */
  readonly transactions?: TransactionOptions;
  /**
   * Literal secrets (the RPC URL, its API key, its host) removed from every error text the engine
   * writes (outbox `last_error`, audit notes, alarms). The gateway scrubs its own errors too; this
   * is the second layer.
   */
  readonly secrets?: readonly string[];
}

/** What the engine is built from. */
export interface BridgeEngineDeps {
  /** The database. */
  readonly prisma: PrismaClient;
  /** The chain (one deployment). */
  readonly gateway: ChainGateway;
  /**
   * Decodes signed bytes so they are checked before they are stored: `ViemTransactionInspector`
   * for `ViemChainGateway`.
   */
  readonly inspector: RawTransactionInspector;
  /** The time source. */
  readonly clock: Clock;
  /** The id source. */
  readonly ids: IdSource;
  /** Where alarms go. Default an in-memory `AlarmLog`. */
  readonly alarms?: AlarmSink;
}

/** What one tick did. */
export interface TickSummary {
  /** The dispatcher pass. */
  readonly dispatch: DispatchSummary;
  /** The indexer pass. */
  readonly index: IndexerResult;
  /** The monitor pass. */
  readonly monitor: MonitorSummary;
  /** Components that threw this tick (each raised `component_failed`); the others still ran. */
  readonly failed: readonly ('dispatch' | 'index' | 'monitor')[];
}

const EMPTY_DISPATCH: DispatchSummary = Object.freeze({
  claimed: 0,
  done: 0,
  retried: 0,
  dead: 0,
  lostLease: 0,
  reaped: 0,
  timedOut: 0,
});

const EMPTY_MONITOR: MonitorSummary = Object.freeze({
  ran: false,
  head: null,
  examined: 0,
  skipped: 0,
  confirmed: 0,
  lateConfirmed: 0,
  failed: 0,
  reversed: 0,
  bumped: 0,
  resubmitted: 0,
  released: 0,
});

/** The engine, wired. See the file comment. */
export class BridgeEngine {
  /** Requests (reserve + enqueue). */
  readonly operations: OperationService;
  /** The settlement outbox handler. */
  readonly submitter: SettlementSubmitter;
  /** Claims outbox rows and runs the submitter. */
  readonly dispatcher: OutboxDispatcher;
  /** Decides on submitted and failed operations. */
  readonly monitor: TxMonitor;
  /** Copies events. */
  readonly indexer: Indexer;
  /** Where alarms go. */
  readonly alarms: AlarmSink;

  private readonly pollIntervalMs: number;
  private readonly clock: Clock;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;
  private readonly redaction: SanitizeOptions;
  private readonly binding: DeploymentBinding;
  private readonly prisma: PrismaClient;

  /**
   * @param deps Database, gateway, signer, clock, ids and alarm sink.
   * @param config Deployment, limits and timings.
   */
  constructor(deps: BridgeEngineDeps, config: BridgeEngineConfig) {
    const depth = config.confirmationDepth;
    if (!Number.isSafeInteger(depth) || depth < 1) {
      throw new InvalidRequestError('confirmationDepth must be an integer >= 1');
    }
    if (typeof config.feeCap !== 'bigint' || config.feeCap <= 0n) {
      throw new InvalidRequestError('feeCap must be a positive bigint');
    }
    const binding = bindingOf(deps.gateway);
    for (const [label, value] of [
      ['gateway token', binding.tokenAddress],
      ['gateway registry', binding.registryAddress],
      ...(config.tokenAddress !== undefined ? [['configured token', config.tokenAddress]] : []),
    ] as const) {
      if (!ADDRESS.test(value.toLowerCase())) {
        throw new InvalidRequestError(`${label} is not a 0x + 40 hex address`);
      }
    }
    if (
      (config.chainId !== undefined && config.chainId !== binding.chainId) ||
      (config.tokenAddress !== undefined &&
        config.tokenAddress.toLowerCase() !== binding.tokenAddress)
    ) {
      throw new DeploymentMismatchError(
        `configured ${String(config.tokenAddress)} on chain ${String(config.chainId)}, but the ` +
          `gateway is bound to ${binding.tokenAddress} on chain ${binding.chainId}`,
      );
    }
    this.binding = binding;
    this.prisma = deps.prisma;
    const transactions = config.transactions ?? {};
    const secrets = [...(config.secrets ?? [])];
    this.redaction = { secrets };
    this.alarms = deps.alarms ?? new AlarmLog();
    this.clock = deps.clock;
    this.pollIntervalMs = config.pollIntervalMs ?? 2_000;
    this.operations = new OperationService({
      prisma: deps.prisma,
      clock: deps.clock,
      ids: deps.ids,
      chainId: binding.chainId,
      tokenAddress: binding.tokenAddress,
      transactions,
    });
    this.submitter = new SettlementSubmitter({
      prisma: deps.prisma,
      gateway: deps.gateway,
      inspector: deps.inspector,
      clock: deps.clock,
      fees: {
        marginBps: config.initialFeeMarginBps ?? 2_000,
        feeCap: config.feeCap,
        feeWaitMs: config.feeWaitMs ?? 60_000,
      },
      transactions,
      secrets,
      alarms: this.alarms,
    });
    this.dispatcher = new OutboxDispatcher({
      prisma: deps.prisma,
      clock: deps.clock,
      ids: deps.ids,
      workerId: config.workerId,
      handler: this.submitter,
      ...(config.batchSize !== undefined ? { batchSize: config.batchSize } : {}),
      ...(config.lockTimeoutMs !== undefined ? { lockTimeoutMs: config.lockTimeoutMs } : {}),
      ...(config.handlerTimeoutMs !== undefined
        ? { handlerTimeoutMs: config.handlerTimeoutMs }
        : {}),
      ...(config.backoff !== undefined ? { backoff: config.backoff } : {}),
      secrets,
    });
    this.monitor = new TxMonitor({
      prisma: deps.prisma,
      gateway: deps.gateway,
      inspector: deps.inspector,
      clock: deps.clock,
      policy: {
        confirmationDepth: depth,
        stuckAfterSeconds: config.stuckAfterSeconds ?? 120,
        maxBumps: config.maxBumps ?? DEFAULT_MAX_BUMPS,
        maxResubmits: config.maxResubmits ?? DEFAULT_MAX_RESUBMITS,
        bumpFeeBps: config.bumpFeeBps ?? 1_250,
        feeCap: config.feeCap,
        initialFeeMarginBps: config.initialFeeMarginBps ?? 2_000,
        headStallTicks: config.headStallTicks ?? 10,
        dropRetrySeconds: config.dropRetrySeconds ?? DEFAULT_DROP_RETRY_SECONDS,
        giveUpAfterSeconds: config.giveUpAfterSeconds ?? DEFAULT_GIVE_UP_AFTER_SECONDS,
        failedAlarmAfterSeconds:
          config.failedAlarmAfterSeconds ?? DEFAULT_FAILED_ALARM_AFTER_SECONDS,
        orphanAfterSeconds: config.orphanAfterSeconds ?? DEFAULT_ORPHAN_AFTER_SECONDS,
      },
      alarms: this.alarms,
      transactions,
      secrets,
    });
    this.indexer = new Indexer({
      prisma: deps.prisma,
      gateway: deps.gateway,
      clock: deps.clock,
      policy: {
        confirmationDepth: depth,
        maxBatch: config.indexerMaxBatch ?? 500,
        reorgWindow: config.reorgWindow ?? 128,
      },
      alarms: this.alarms,
      transactions,
    });
  }

  /** One dispatcher pass, one indexer pass, one monitor pass, in that order. */
  /**
   * Review M-2: the gateway's deployment must be the database's ACTIVE deployment of its chain
   * (chain id, token AND registry). Otherwise the engine would sign for, read evidence from, or
   * index another contract than the one operations are bound to. Raises `deployment_mismatch`
   * and throws `DeploymentMismatchError`; nothing runs.
   */
  async assertDeployment(): Promise<void> {
    const active = await this.prisma.deployment.findFirst({
      where: { chainId: this.binding.chainId, active: true },
    });
    if (active === null || !isBound(active, this.binding)) {
      const detail =
        active === null
          ? `no active deployment on chain ${this.binding.chainId}`
          : `active deployment is ${active.tokenAddress} / ${active.registryAddress}, the gateway ` +
            `is bound to ${this.binding.tokenAddress} / ${this.binding.registryAddress}`;
      this.alarms.raise({ kind: 'deployment_mismatch', detail, at: this.clock.now() });
      throw new DeploymentMismatchError(detail);
    }
  }

  async tick(): Promise<TickSummary> {
    await this.assertDeployment();
    // Each component is isolated (review L-2): an indexer that throws must not stop the monitor
    // from reversing or confirming, nor the dispatcher from sending.
    const failed: ('dispatch' | 'index' | 'monitor')[] = [];
    const guard = async <T>(
      name: 'dispatch' | 'index' | 'monitor',
      fn: () => Promise<T>,
      empty: T,
    ) => {
      try {
        return await fn();
      } catch (err) {
        failed.push(name);
        this.alarms.raise({
          kind: 'component_failed',
          detail: `${name}: ${describeError(err, this.redaction)}`,
          at: this.clock.now(),
        });
        return empty;
      }
    };
    const dispatch = await guard('dispatch', () => this.dispatcher.runOnce(), EMPTY_DISPATCH);
    const index = await guard('index', () => this.indexer.runOnce(), {
      status: 'unknown',
    } as IndexerResult);
    const monitor = await guard('monitor', () => this.monitor.runOnce(), EMPTY_MONITOR);
    return { dispatch, index, monitor, failed };
  }

  /** Starts ticking every `pollIntervalMs` (never two ticks at once). Idempotent. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  /** Stops the loop and waits for a tick in progress to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.tick()
        .then(() => undefined)
        .catch((err: unknown) => {
          // A failed tick is an alarm, never the end of the loop.
          this.alarms.raise({
            kind: 'examine_error',
            detail: describeError(err, this.redaction),
            at: this.clock.now(),
          });
        })
        .finally(() => {
          this.running = undefined;
          if (!this.stopped) this.schedule(this.pollIntervalMs);
        });
    }, delayMs);
  }
}
