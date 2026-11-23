/**
 * @file The composition root: one `BridgeEngine` wires the operation and compliance services,
 * the outbox dispatcher (routing each row to the settlement or the compliance submitter), the
 * transaction and compliance monitors, the indexer and the reconciler to one database, one
 * gateway (one deployment), one clock and one id source.
 *
 * `tick()` runs one pass of each, in the order that lets a pass finish its work: dispatch (sign,
 * record, broadcast), index (copy the new events), monitor operations, monitor compliance changes
 * (decide on final evidence), and every `reconcileEveryTicks` ticks a reconciliation run (after
 * the monitors, so the ledger has caught up with what is final). Each component is isolated: one
 * that throws raises `component_failed` and the others still run. It holds no timer, so tests
 * drive the engine deterministically. `start()` / `stop()` are a thin loop around `tick()` for
 * the worker process; the loop never overlaps two ticks.
 */

import type { ChainGateway } from '@bridge/chain';
import type { PrismaClient } from '@bridge/db';

import { AlarmLog, type AlarmSink } from './alarms';
import {
  ComplianceMonitor,
  type ComplianceMonitorSummary,
  EMPTY_COMPLIANCE_SUMMARY,
} from './compliance-monitor';
import { ComplianceService } from './compliance-service';
import { ComplianceSubmitter } from './compliance-submitter';
import { DeploymentMismatchError, InvalidRequestError, UnsafeIsolationError } from './errors';
import { Indexer, type IndexerResult } from './indexer';
import { OperationService } from './operation-service';
import { type BackoffPolicy, type DispatchSummary, OutboxDispatcher } from './outbox-dispatcher';
import type { Clock, IdSource } from './ports';
import { Reconciler, type ReconciliationRunRecord } from './reconciler';
import { describeError, type SanitizeOptions } from './redact';
import { SettlementSubmitter } from './settlement-submitter';
import { SignerRouter } from './signer-router';
import type { RawTransactionInspector } from './signing';
import { bindingOf, type DeploymentBinding, isBound } from './signer-binding';
import type { TransactionOptions } from './transaction';
import { type MonitorSummary, TxMonitor } from './tx-monitor';

const ADDRESS = /^0x[0-9a-f]{40}$/;

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

/**
 * Default ticks between reconciliation runs: 10. WHY: a run reads every relevant balance and flag
 * at the final block, so it costs far more node calls than a monitor pass; at the default 2 s poll
 * that is a run every ~20 s, often enough that a rogue mint or registry change is seen within a
 * minute, rare enough not to multiply the node load. An admin can always `reconcileNow()`.
 */
export const DEFAULT_RECONCILE_EVERY_TICKS = 10;

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
  /** Consecutive failed evidence reads of one operation before `operation_skipped`. Default 10. */
  readonly skipAlarmPasses?: number;
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
  /**
   * Transaction settings for every component. The isolation level, when given, must be
   * `ReadCommitted` (`UnsafeIsolationError` otherwise): nonce allocation is only correct there
   * (review round 2, L-B), and the database refuses attempts at any other level anyway.
   */
  readonly transactions?: TransactionOptions;
  /** Ticks between reconciliation runs (>= 1). Default `DEFAULT_RECONCILE_EVERY_TICKS`. */
  readonly reconcileEveryTicks?: number;
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

/** The components of one tick. */
export type TickComponent = 'dispatch' | 'index' | 'monitor' | 'compliance' | 'reconcile';

/** What one tick did. */
export interface TickSummary {
  /** The dispatcher pass. */
  readonly dispatch: DispatchSummary;
  /** The indexer pass. */
  readonly index: IndexerResult;
  /** The monitor pass. */
  readonly monitor: MonitorSummary;
  /** The compliance monitor pass. */
  readonly compliance: ComplianceMonitorSummary;
  /** The reconciliation run of this tick, or null when none was due (or it failed). */
  readonly reconciliation: ReconciliationRunRecord | null;
  /** Components that threw this tick (each raised `component_failed`); the others still ran. */
  readonly failed: readonly TickComponent[];
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
  /** Compliance requests (record + enqueue). */
  readonly compliance: ComplianceService;
  /** The settlement outbox handler. */
  readonly submitter: SettlementSubmitter;
  /** The compliance outbox handler. */
  readonly complianceSubmitter: ComplianceSubmitter;
  /** Decides on submitted and failed compliance changes. */
  readonly complianceMonitor: ComplianceMonitor;
  /** Compares the ledger with the chain at the final block. */
  readonly reconciler: Reconciler;
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
  private readonly reconcileEveryTicks: number;
  private ticks = 0;

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
    const level = config.transactions?.isolationLevel;
    if (level !== undefined && level !== 'ReadCommitted') {
      // Refused at construction rather than at the first nonce: a misconfigured worker must not
      // start at all (review round 2 quick item).
      throw new UnsafeIsolationError(`the engine runs at READ COMMITTED only, not ${level}`);
    }
    const reconcileEveryTicks = config.reconcileEveryTicks ?? DEFAULT_RECONCILE_EVERY_TICKS;
    if (!Number.isSafeInteger(reconcileEveryTicks) || reconcileEveryTicks < 1) {
      throw new InvalidRequestError('reconcileEveryTicks must be an integer >= 1');
    }
    this.reconcileEveryTicks = reconcileEveryTicks;
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
    this.compliance = new ComplianceService({
      prisma: deps.prisma,
      clock: deps.clock,
      ids: deps.ids,
      binding,
      transactions,
    });
    const fees = {
      marginBps: config.initialFeeMarginBps ?? 2_000,
      feeCap: config.feeCap,
      feeWaitMs: config.feeWaitMs ?? 60_000,
    };
    this.submitter = new SettlementSubmitter({
      prisma: deps.prisma,
      gateway: deps.gateway,
      inspector: deps.inspector,
      clock: deps.clock,
      fees,
      transactions,
      secrets,
      alarms: this.alarms,
    });
    this.complianceSubmitter = new ComplianceSubmitter({
      prisma: deps.prisma,
      gateway: deps.gateway,
      inspector: deps.inspector,
      clock: deps.clock,
      fees,
      transactions,
      secrets,
      alarms: this.alarms,
    });
    this.dispatcher = new OutboxDispatcher({
      prisma: deps.prisma,
      clock: deps.clock,
      ids: deps.ids,
      workerId: config.workerId,
      handler: new SignerRouter({
        settlement: this.submitter,
        compliance: this.complianceSubmitter,
      }),
      ...(config.batchSize !== undefined ? { batchSize: config.batchSize } : {}),
      ...(config.lockTimeoutMs !== undefined ? { lockTimeoutMs: config.lockTimeoutMs } : {}),
      ...(config.handlerTimeoutMs !== undefined
        ? { handlerTimeoutMs: config.handlerTimeoutMs }
        : {}),
      ...(config.backoff !== undefined ? { backoff: config.backoff } : {}),
      secrets,
    });
    const policy = {
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
      failedAlarmAfterSeconds: config.failedAlarmAfterSeconds ?? DEFAULT_FAILED_ALARM_AFTER_SECONDS,
      orphanAfterSeconds: config.orphanAfterSeconds ?? DEFAULT_ORPHAN_AFTER_SECONDS,
      skipAlarmPasses: config.skipAlarmPasses ?? 10,
    };
    this.monitor = new TxMonitor({
      prisma: deps.prisma,
      gateway: deps.gateway,
      inspector: deps.inspector,
      clock: deps.clock,
      policy,
      alarms: this.alarms,
      transactions,
      secrets,
    });
    this.complianceMonitor = new ComplianceMonitor({
      prisma: deps.prisma,
      gateway: deps.gateway,
      inspector: deps.inspector,
      clock: deps.clock,
      policy,
      alarms: this.alarms,
      transactions,
      secrets,
    });
    this.reconciler = new Reconciler({
      prisma: deps.prisma,
      gateway: deps.gateway,
      clock: deps.clock,
      policy: { confirmationDepth: depth },
      alarms: this.alarms,
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

  /**
   * Review M-2: the gateway's deployment must be the database's ACTIVE deployment of its chain
   * (chain id, token AND registry). Otherwise the engine would sign for, read evidence from, or
   * index another contract than the one operations are bound to. Raises `deployment_mismatch`
   * and throws `DeploymentMismatchError`; nothing runs.
   *
   * An engine bound to an INACTIVE deployment therefore refuses to run at all. There is nothing
   * left for it to drain: the database refuses to deactivate a deployment while any of its
   * operations or compliance changes is not final (guard 6b), so an inactive deployment has no
   * work in flight.
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

  /**
   * One pass: the deployment check, then one dispatcher pass, one indexer pass, one monitor pass,
   * one compliance monitor pass and, every `reconcileEveryTicks` ticks, one reconciliation run,
   * in that order, each isolated from the others' failures.
   */
  async tick(): Promise<TickSummary> {
    await this.assertDeployment();
    this.ticks += 1;
    // Each component is isolated (review L-2): an indexer that throws must not stop the monitor
    // from reversing or confirming, nor the dispatcher from sending.
    const failed: TickComponent[] = [];
    const guard = async <T>(name: TickComponent, fn: () => Promise<T>, empty: T) => {
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
    const compliance = await guard(
      'compliance',
      () => this.complianceMonitor.runOnce(),
      EMPTY_COMPLIANCE_SUMMARY,
    );
    const due = this.ticks % this.reconcileEveryTicks === 0;
    const reconciliation = due
      ? await guard('reconcile', () => this.reconciler.runOnce(), null)
      : null;
    return { dispatch, index, monitor, compliance, reconciliation, failed };
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
