/**
 * @file The worker's lifecycle: refuse to start on a bad binding, run the engine loop, and shut
 * down cleanly on SIGTERM / SIGINT or on a fatal alarm.
 *
 * Shutdown order: stop scheduling ticks, WAIT for the tick in progress (`engine.stop()` resolves
 * once it has finished), then the caller closes the application (which disconnects Prisma). The
 * wait is bounded by `shutdownTimeoutMs`: past it the worker exits non-zero anyway. Cutting a tick
 * short is safe by design (commit before broadcast, outbox leases expire and are recovered), but
 * it is still reported as an unclean exit.
 *
 * Exit codes: 0 after a signal-initiated clean stop; 1 when startup checks fail, on a fatal
 * alarm (deployment or chain mismatch while running), or when the in-flight tick outlived the
 * shutdown timeout.
 */

import { describeError, type EngineAlarm } from '@bridge/engine';

import { FATAL_ALARMS, type WorkerLogger } from './logger';

/** What the runner needs from `BridgeEngine`. */
export interface EngineLoop {
  /** The database's active deployment must be the gateway's (throws otherwise). */
  assertDeployment(): Promise<void>;
  /** Starts the tick loop. */
  start(): void;
  /** Stops the loop and resolves when the tick in progress has finished. */
  stop(): Promise<void>;
}

/** The part of `process` the runner listens to (an `EventEmitter` in tests). */
export interface SignalSource {
  /** Subscribes. */
  on(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  /** Unsubscribes. */
  off(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
}

/** How the runner is built. */
export interface RunnerOptions {
  /** The engine. */
  readonly engine: EngineLoop;
  /** The logger. */
  readonly logger: WorkerLogger;
  /** How long to wait for the tick in progress. */
  readonly shutdownTimeoutMs: number;
  /** Signals (default `process`). */
  readonly signals?: SignalSource;
  /** Extra startup checks run after the deployment check (the signer binding). */
  readonly checks?: () => Promise<void>;
}

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/** Runs the engine until told to stop. */
export class WorkerRunner {
  private stopRequested: ((code: number) => void) | undefined;
  private pendingCode: number | undefined;
  private requested = false;
  private detach: () => void = () => undefined;

  /** @param options Engine, logger, timeout, signals, checks. */
  constructor(private readonly options: RunnerOptions) {}

  /**
   * Asks the loop to stop with `code` (the first request wins). Safe before `run()` and repeated.
   *
   * @param code The exit code.
   * @param reason Logged.
   */
  requestStop(code: number, reason: string): void {
    if (this.requested) {
      this.options.logger.emit('warn', 'stop already requested', { reason });
      return;
    }
    this.requested = true;
    this.options.logger.emit(code === 0 ? 'log' : 'error', 'stopping', { reason, exitCode: code });
    if (this.stopRequested !== undefined) this.stopRequested(code);
    else this.pendingCode = code;
  }

  /** Called by the alarm sink for a fatal alarm. */
  onFatalAlarm(alarm: EngineAlarm): void {
    const action = FATAL_ALARMS.get(alarm.kind);
    this.requestStop(
      1,
      `fatal alarm ${alarm.kind}: ${alarm.detail}${action === undefined ? '' : ` (${action})`}`,
    );
  }

  /** Startup checks, the loop, and the shutdown. Resolves with the exit code; never rejects. */
  async run(): Promise<number> {
    const { engine, logger } = this.options;
    try {
      await engine.assertDeployment();
      await this.options.checks?.();
    } catch (err) {
      logger.emit('error', 'refusing to run: the deployment binding does not match', {
        error: describeError(err),
      });
      return 1;
    }
    const signals = this.options.signals ?? process;
    const code = await new Promise<number>((resolve) => {
      if (this.pendingCode !== undefined) {
        resolve(this.pendingCode);
        return;
      }
      this.stopRequested = resolve;
      const handlers = SIGNALS.map((s) => {
        const h = () => this.requestStop(0, `received ${s}`);
        signals.on(s, h);
        return [s, h] as const;
      });
      this.detach = () => {
        for (const [s, h] of handlers) signals.off(s, h);
      };
      engine.start();
      logger.emit('log', 'engine loop started');
    });
    return this.shutdown(code);
  }

  private async shutdown(code: number): Promise<number> {
    const { engine, logger, shutdownTimeoutMs } = this.options;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), shutdownTimeoutMs);
    });
    try {
      const outcome = await Promise.race([engine.stop().then(() => 'stopped' as const), timedOut]);
      if (outcome === 'timeout') {
        logger.emit('error', 'the tick in progress did not finish within the shutdown timeout', {
          shutdownTimeoutMs,
        });
        return 1;
      }
      logger.emit('log', 'engine loop stopped', { exitCode: code });
      return code;
    } catch (err) {
      logger.emit('error', 'stopping the engine failed', { error: describeError(err) });
      return 1;
    } finally {
      clearTimeout(timer);
      this.detach();
    }
  }
}
