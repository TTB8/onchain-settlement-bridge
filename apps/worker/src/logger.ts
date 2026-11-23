/**
 * @file The worker's structured logger (one JSON object per line on stdout), redacting every
 * message with the engine's `sanitizeText` and the configured secrets (database URL, RPC URL and
 * both signer keys), and the alarm sink that writes engine alarms through it.
 *
 * Why its own copy rather than sharing the API's: the two apps are separate deployables with no
 * dependency on each other; the redaction itself is the engine's, so the rule that matters is
 * shared and only ~60 lines of formatting are repeated.
 */

import type { LoggerService } from '@nestjs/common';
import { type AlarmKind, type AlarmSink, type EngineAlarm, sanitizeText } from '@bridge/engine';
import type { LogLevel } from '@bridge/engine/env';

const RANK: Readonly<Record<LogLevel, number>> = { error: 0, warn: 1, log: 2, debug: 3 };

/** One structured field value. */
export type LogValue = string | number | boolean | null;

/** A Nest `LoggerService` writing redacted JSON lines. */
export class WorkerLogger implements LoggerService {
  /**
   * @param options Level, secrets to redact, and the line sink (default stdout).
   */
  constructor(
    private readonly options: {
      readonly level: LogLevel;
      readonly secrets: readonly string[];
      readonly write?: (line: string) => void;
    },
  ) {}

  /** Writes one structured line at `level` if enabled. */
  emit(level: LogLevel, msg: string, fields: Readonly<Record<string, LogValue>> = {}): void {
    if (RANK[level] > RANK[this.options.level]) return;
    const redact = (t: string) => sanitizeText(t, { secrets: this.options.secrets, max: 2000 });
    const safe: Record<string, LogValue> = {};
    for (const [k, v] of Object.entries(fields)) safe[k] = typeof v === 'string' ? redact(v) : v;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      service: 'worker',
      msg: redact(msg),
      ...safe,
    });
    (this.options.write ?? ((l: string) => process.stdout.write(`${l}\n`)))(line);
  }

  /** @inheritdoc */
  log(message: unknown, context?: unknown): void {
    this.emit('log', String(message), ctx(context));
  }

  /** @inheritdoc */
  error(message: unknown, ...rest: unknown[]): void {
    // (message, stack?, context?): the stack is dropped, it can quote data.
    this.emit('error', String(message), ctx(rest[rest.length - 1]));
  }

  /** @inheritdoc */
  warn(message: unknown, context?: unknown): void {
    this.emit('warn', String(message), ctx(context));
  }

  /** @inheritdoc */
  debug(message: unknown, context?: unknown): void {
    this.emit('debug', String(message), ctx(context));
  }

  /** @inheritdoc */
  verbose(message: unknown, context?: unknown): void {
    this.emit('debug', String(message), ctx(context));
  }
}

function ctx(context: unknown): Record<string, LogValue> {
  return typeof context === 'string' ? { context } : {};
}

/**
 * Alarms that mean this worker must not keep running, each with the line an operator reads:
 *
 * - `deployment_mismatch`: the database's active deployment is not the one it is bound to;
 * - `chain_mismatch`: the node is on another chain;
 * - `reorg_beyond_window`: a reorg deeper than the indexer's window; the indexer halts on every
 *   pass, so nothing new is indexed and nothing can be decided on fresh evidence.
 *
 * The engine already refuses the affected work then; exiting makes the refusal visible to the
 * orchestrator instead of a silent loop of identical alarms.
 */
export const FATAL_ALARMS: ReadonlyMap<AlarmKind, string> = new Map<AlarmKind, string>([
  [
    'deployment_mismatch',
    'the active deployment is not the configured one: fix the deployment row or TOKEN_ADDRESS / REGISTRY_ADDRESS',
  ],
  ['chain_mismatch', 'the node is on another chain than CHAIN_ID: fix RPC_URL'],
  [
    'reorg_beyond_window',
    'a reorg deeper than the indexer window: a person must inspect the chain and re-index before restarting',
  ],
]);

/**
 * The worker's `AlarmSink`: one `warn` line per alarm (`msg: "alarm"`, kind, redacted detail,
 * ids), and for a FATAL alarm a call to `onFatal` (set by the runner). Never throws.
 */
export class WorkerAlarmSink implements AlarmSink {
  /** Called once per fatal alarm; the runner sets it. */
  onFatal: ((alarm: EngineAlarm) => void) | undefined;

  /** @param logger The structured logger. */
  constructor(private readonly logger: WorkerLogger) {}

  /** @inheritdoc */
  raise(alarm: EngineAlarm): void {
    try {
      this.logger.emit(FATAL_ALARMS.has(alarm.kind) ? 'error' : 'warn', 'alarm', {
        kind: alarm.kind,
        detail: alarm.detail,
        at: alarm.at.toISOString(),
        operationId: alarm.operationId ?? null,
        complianceChangeId: alarm.complianceChangeId ?? null,
        reconciliationRunId: alarm.reconciliationRunId ?? null,
      });
    } catch {
      // Must not throw (AlarmSink contract).
    }
    if (FATAL_ALARMS.has(alarm.kind)) {
      try {
        this.onFatal?.(alarm);
      } catch {
        // Must not throw.
      }
    }
  }
}
