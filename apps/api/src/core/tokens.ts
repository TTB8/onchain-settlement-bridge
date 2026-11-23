/**
 * @file Dependency-injection tokens for everything the API is built from (configuration, database,
 * chain, clock, ids, engine services). Symbols rather than classes so that tests swap any of them
 * (a per-file test database, the fake chain) without touching the modules that use them.
 */

import type { ApiConfig } from '@bridge/engine/env';
import type { ChainGateway } from '@bridge/chain';
import type { PrismaClient } from '@bridge/db';
import type { AlarmSink, Clock, IdSource } from '@bridge/engine';

import type { JsonLogger } from './logger';

/** The validated `ApiConfig`. */
export const API_CONFIG = Symbol('API_CONFIG');
/** The Prisma client (connected as a NON-owner role in production, see the README). */
export const PRISMA = Symbol('PRISMA');
/** The read-only chain gateway (the API never signs). */
export const CHAIN_GATEWAY = Symbol('CHAIN_GATEWAY');
/** The time source. */
export const CLOCK = Symbol('CLOCK');
/** The id source. */
export const IDS = Symbol('IDS');
/** Where engine alarms raised by this process go. */
export const ALARM_SINK = Symbol('ALARM_SINK');
/** The structured logger. */
export const LOGGER = Symbol('LOGGER');
/** The engine's `OperationService`. */
export const OPERATION_SERVICE = Symbol('OPERATION_SERVICE');
/** The engine's `ComplianceService`. */
export const COMPLIANCE_SERVICE = Symbol('COMPLIANCE_SERVICE');
/** The engine's `Reconciler`. */
export const RECONCILER = Symbol('RECONCILER');

/** Everything the API process is built from. `main.ts` makes the real ones; tests their own. */
export interface ApiRuntime {
  /** The validated configuration. */
  readonly config: ApiConfig;
  /** The database. */
  readonly prisma: PrismaClient;
  /** The chain, read-only. */
  readonly gateway: ChainGateway;
  /** The time source. */
  readonly clock: Clock;
  /** The id source. */
  readonly ids: IdSource;
  /** The structured logger (redacting the configured secrets). */
  readonly logger: JsonLogger;
  /** Where alarms go. Default: the logger, one structured line per alarm. */
  readonly alarms?: AlarmSink;
}
