/**
 * @file A structured (one JSON object per line) logger for NestJS that redacts every message.
 *
 * Why its own logger: the default Nest logger prints whatever it is handed, coloured, over several
 * lines. Log lines end up in a log store that more people can read than the database, so every
 * message passes through the engine's `sanitizeText` with the configured secrets (database URL,
 * RPC URL, tokens) before it is written, and URL-looking text is removed even when it is not a
 * known secret. Request bodies and headers are never handed to it (see the request logger).
 */

import type { LoggerService } from '@nestjs/common';
import type { LogLevel } from '@bridge/engine/env';
import { type AlarmSink, type EngineAlarm, sanitizeText } from '@bridge/engine';

const RANK: Readonly<Record<LogLevel, number>> = { error: 0, warn: 1, log: 2, debug: 3 };

/** One structured field value. */
export type LogValue = string | number | boolean | null;

/** Where a line goes (stdout in production; an array in tests). */
export type LogWriter = (line: string) => void;

/** A NestJS `LoggerService` writing redacted JSON lines. */
export class JsonLogger implements LoggerService {
  /**
   * @param options `level`: the most verbose level written; `secrets`: values to redact;
   *   `service`: the process name on every line; `write`: the sink (default stdout).
   */
  constructor(
    private readonly options: {
      readonly level: LogLevel;
      readonly secrets: readonly string[];
      readonly service: string;
      readonly write?: LogWriter;
      readonly clock?: () => Date;
    },
  ) {}

  /** Writes one structured line at `level` if enabled. */
  emit(level: LogLevel, msg: string, fields: Readonly<Record<string, LogValue>> = {}): void {
    if (RANK[level] > RANK[this.options.level]) return;
    const safe: Record<string, LogValue> = {};
    for (const [k, v] of Object.entries(fields)) {
      safe[k] = typeof v === 'string' ? this.redact(v) : v;
    }
    const line = JSON.stringify({
      time: (this.options.clock ?? (() => new Date()))().toISOString(),
      level,
      service: this.options.service,
      msg: this.redact(msg),
      ...safe,
    });
    (this.options.write ?? ((l: string) => process.stdout.write(`${l}\n`)))(line);
  }

  /** Text with the configured secrets and anything URL-like removed. */
  redact(text: string): string {
    return sanitizeText(text, { secrets: this.options.secrets, max: 2000 });
  }

  /** @inheritdoc */
  log(message: unknown, context?: unknown): void {
    this.emit('log', String(message), contextField(context));
  }

  /** @inheritdoc */
  error(message: unknown, ...rest: unknown[]): void {
    // Nest passes (message, stack?, context?). The stack stays out: it can quote request data.
    this.emit('error', String(message), contextField(rest[rest.length - 1]));
  }

  /** @inheritdoc */
  warn(message: unknown, context?: unknown): void {
    this.emit('warn', String(message), contextField(context));
  }

  /** @inheritdoc */
  debug(message: unknown, context?: unknown): void {
    this.emit('debug', String(message), contextField(context));
  }

  /** @inheritdoc */
  verbose(message: unknown, context?: unknown): void {
    this.emit('debug', String(message), contextField(context));
  }
}

function contextField(context: unknown): Record<string, LogValue> {
  return typeof context === 'string' ? { context } : {};
}

/**
 * An `AlarmSink` that writes each alarm as one `warn` line (`msg: "alarm"`, the kind, the redacted
 * detail and the ids it names). Never throws: a broken log pipe must not stop the engine.
 */
export class LoggingAlarmSink implements AlarmSink {
  /** @param logger The structured logger. */
  constructor(private readonly logger: JsonLogger) {}

  /** @inheritdoc */
  raise(alarm: EngineAlarm): void {
    try {
      this.logger.emit('warn', 'alarm', {
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
  }
}
