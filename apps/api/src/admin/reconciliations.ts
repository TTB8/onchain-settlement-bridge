/**
 * @file Reconciliation runs, admin token only: run one now, list the latest.
 *
 * `POST /v1/admin/reconciliations` calls the engine's `reconcileNow()`: the ledger compared with
 * the chain at the final block, persisted (run + one row per mismatch) and alarmed, then returned
 * as stored. Every outcome answers HTTP 200, because the request (run a comparison) succeeded
 * even when the comparison could not decide: the body's `status` is `ok`, `mismatch` or
 * `unknown`, and an `unknown` run is NEVER reported as ok (`clean` is true only for `ok` with
 * zero mismatches). An operator script must branch on `status`, not on the HTTP status.
 *
 * No other users' data leaks here beyond what an operator needs: mismatches name addresses and
 * amounts by design (they are what a person must investigate), and `error` is the engine's
 * redacted, bounded reason.
 */

import { Controller, Get, HttpCode, Inject, Injectable, Module, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Reconciler, ReconciliationRunRecord } from '@bridge/engine';

import { Access } from '../auth/auth';
import { ADMIN_AUTH, ApiProblems } from '../core/openapi';
import { parseLimit } from '../core/params';
import { ApiProblem } from '../core/problem';
import { RECONCILER } from '../core/tokens';

/** The three outcomes of a run. */
export type RunStatus = 'ok' | 'mismatch' | 'unknown';

/**
 * The status reported for a stored status. Anything that is not exactly `ok` or `mismatch` is
 * `unknown`: a value this code does not know must never read as clean.
 *
 * @param stored The run's stored status.
 */
export function reportedStatus(stored: string): RunStatus {
  switch (stored) {
    case 'ok':
      return 'ok';
    case 'mismatch':
      return 'mismatch';
    default:
      return 'unknown';
  }
}

/** One stored mismatch. */
export interface MismatchView {
  /** Position in the run. */
  readonly ordinal: number;
  /** The domain's mismatch kind. */
  readonly kind: string;
  /** The mismatch as the domain reported it. */
  readonly detail: Readonly<Record<string, unknown>>;
}

/** A run as the API returns it. */
export interface RunView {
  /** The run id. */
  readonly id: string;
  /** The deployment. */
  readonly deploymentId: string;
  /** ok, mismatch or unknown. */
  readonly status: RunStatus;
  /** True only for `ok` with zero mismatches. */
  readonly clean: boolean;
  /** The block compared at. */
  readonly atBlock: string | null;
  /** The final block. */
  readonly finalBlock: string | null;
  /** The head when the run started. */
  readonly headBlock: string | null;
  /** Why it is unknown (redacted). */
  readonly error: string | null;
  /** How many mismatches. */
  readonly mismatchCount: number;
  /** The run's summary. */
  readonly summary: Readonly<Record<string, unknown>>;
  /** Start (ISO 8601, UTC). */
  readonly startedAt: string;
  /** End (ISO 8601, UTC). */
  readonly finishedAt: string | null;
  /** The mismatches, in order. */
  readonly mismatches: readonly MismatchView[];
}

/** Schema of `MismatchView`. */
export class MismatchDto {
  /** Ordinal. */
  @ApiProperty() readonly ordinal?: number;
  /** Kind. */
  @ApiProperty({ example: 'balance_mismatch' }) readonly kind?: string;
  /** Detail. */
  @ApiProperty({ type: 'object', additionalProperties: true }) readonly detail?: object;
}

/** Schema of `RunView`. */
export class RunDto {
  /** Id. */
  @ApiProperty({ format: 'uuid' }) readonly id?: string;
  /** Deployment. */
  @ApiProperty({ format: 'uuid' }) readonly deploymentId?: string;
  /** Status. */
  @ApiProperty({
    enum: ['ok', 'mismatch', 'unknown'],
    description: 'unknown: the run could not compare (see error). Never treat it as ok.',
  })
  readonly status?: string;
  /** Clean. */
  @ApiProperty({ description: 'true only for status ok with zero mismatches' })
  readonly clean?: boolean;
  /** At block. */
  @ApiProperty({ nullable: true, type: String }) readonly atBlock?: string | null;
  /** Final block. */
  @ApiProperty({ nullable: true, type: String }) readonly finalBlock?: string | null;
  /** Head. */
  @ApiProperty({ nullable: true, type: String }) readonly headBlock?: string | null;
  /** Error. */
  @ApiProperty({ nullable: true, type: String, example: 'read_failed: ChainUnavailableError: ...' })
  readonly error?: string | null;
  /** Count. */
  @ApiProperty() readonly mismatchCount?: number;
  /** Summary. */
  @ApiProperty({ type: 'object', additionalProperties: true }) readonly summary?: object;
  /** Start. */
  @ApiProperty({ format: 'date-time' }) readonly startedAt?: string;
  /** End. */
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) readonly finishedAt?:
    string | null;
  /** Mismatches. */
  @ApiProperty({ type: [MismatchDto] }) readonly mismatches?: MismatchDto[];
}

const block = (b: bigint | null): string | null => (b === null ? null : b.toString());

/**
 * The API view of a run.
 *
 * @param r The engine's record.
 */
export function toRunView(r: ReconciliationRunRecord): RunView {
  const status = reportedStatus(r.status);
  return {
    id: r.id,
    deploymentId: r.deploymentId,
    status,
    clean: status === 'ok' && r.mismatchCount === 0,
    atBlock: block(r.atBlock),
    finalBlock: block(r.finalBlock),
    headBlock: block(r.headBlock),
    error: r.error,
    mismatchCount: r.mismatchCount,
    summary: r.summary,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt === null ? null : r.finishedAt.toISOString(),
    mismatches: r.mismatches.map((m) => ({ ordinal: m.ordinal, kind: m.kind, detail: m.detail })),
  };
}

/** Runs and lists reconciliations. */
@Injectable()
export class ReconciliationsService {
  /** @param reconciler The engine's reconciler. */
  constructor(@Inject(RECONCILER) private readonly reconciler: Reconciler) {}

  /** One run now. `DEPLOYMENT_NOT_REGISTERED` when the configured deployment has no row. */
  async runNow(): Promise<RunView> {
    const run = await this.reconciler.reconcileNow();
    if (run === null) throw new ApiProblem('DEPLOYMENT_NOT_REGISTERED');
    return toRunView(run);
  }

  /**
   * The latest runs, newest first.
   *
   * @param limit How many.
   */
  async latest(limit: number): Promise<RunView[]> {
    return (await this.reconciler.latestRuns(limit)).map(toRunView);
  }
}

/** `/v1/admin/reconciliations`. Admin token only. */
@ApiTags('admin')
@ApiBearerAuth(ADMIN_AUTH)
@Access('admin')
@Controller('v1/admin/reconciliations')
export class ReconciliationsController {
  /** @param runs The service. */
  constructor(private readonly runs: ReconciliationsService) {}

  /** Runs a reconciliation now. */
  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Run a reconciliation now (ledger vs chain at the final block); 200 for ok, mismatch AND unknown',
  })
  @ApiOkResponse({ type: RunDto })
  @ApiProblems('UNAUTHENTICATED', 'FORBIDDEN', 'DEPLOYMENT_NOT_REGISTERED')
  run(): Promise<RunView> {
    return this.runs.runNow();
  }

  /** Lists the latest runs. */
  @Get()
  @ApiOperation({ summary: 'The latest reconciliation runs, newest first' })
  @ApiQuery({ name: 'limit', required: false, description: '1-100, default 20' })
  @ApiOkResponse({ type: [RunDto] })
  @ApiProblems('VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN')
  list(@Query('limit') limit?: unknown): Promise<RunView[]> {
    return this.runs.latest(parseLimit(limit, 20, 100));
  }
}

/** The admin / reconciliation feature. */
@Module({ controllers: [ReconciliationsController], providers: [ReconciliationsService] })
export class AdminModule {}
