/**
 * @file Liveness and readiness, public (an orchestrator probes them without a credential).
 *
 * - `GET /health`: the process answers. No dependency is touched, so a slow database never gets
 *   a healthy process restarted.
 * - `GET /ready` (cached for `READY_CACHE_MS`, so it cannot be used to burn RPC quota): the
 *   process can serve requests: the database answers, the node answers with the
 *   configured chain id, and the database's ACTIVE deployment of that chain is the configured
 *   token + registry (the engine's binding). 503 problem+json otherwise, with one `ok` / `fail`
 *   per check and nothing else: no error text, no addresses, no URLs (it is unauthenticated).
 */

import { Controller, Get, Inject, Injectable, Module } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { ChainGateway } from '@bridge/chain';
import type { PrismaClient } from '@bridge/db';
import { bindingOf, type Clock, describeError, isBound } from '@bridge/engine';

import { Access } from '../auth/auth';
import type { JsonLogger } from '../core/logger';
import { ApiProblems } from '../core/openapi';
import { ApiProblem } from '../core/problem';
import { CHAIN_GATEWAY, CLOCK, LOGGER, PRISMA } from '../core/tokens';

/** How long a readiness answer is reused: 2 s. */
export const READY_CACHE_MS = 2_000;

/** One check's outcome. */
export type CheckResult = 'ok' | 'fail';

/** The readiness checks. */
export interface ReadinessChecks {
  /** `SELECT 1` answered. */
  readonly database: CheckResult;
  /** The node answered with the configured chain id. */
  readonly node: CheckResult;
  /** The active deployment is the configured one. */
  readonly deployment: CheckResult;
}

/** Schema of a liveness answer. */
export class HealthDto {
  /** Always ok. */
  @ApiProperty({ example: 'ok' }) readonly status?: string;
}

/** Schema of a readiness answer. */
export class ReadyDto {
  /** ready. */
  @ApiProperty({ example: 'ready' }) readonly status?: string;
  /** Per check. */
  @ApiProperty({ example: { database: 'ok', node: 'ok', deployment: 'ok' } })
  readonly checks?: object;
}

/** Runs the readiness checks. */
@Injectable()
export class ReadinessService {
  /**
   * @param prisma The database.
   * @param gateway The chain.
   * @param logger Failures are logged (redacted), never returned.
   */
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CHAIN_GATEWAY) private readonly gateway: ChainGateway,
    @Inject(LOGGER) private readonly logger: JsonLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private cached: { readonly at: number; readonly checks: ReadinessChecks } | undefined;
  private inFlight: Promise<ReadinessChecks> | undefined;

  /**
   * The checks, at most one real run per `READY_CACHE_MS` (and one at a time). WHY: `/ready` is
   * public, and each run costs an RPC call and two queries; without a cache anyone could burn the
   * node provider's quota (or load the database) by hammering it. A cached answer is at most two
   * seconds stale, far below any orchestrator's probe period.
   */
  async check(): Promise<ReadinessChecks> {
    const now = this.clock.now().getTime();
    if (this.cached !== undefined && now - this.cached.at < READY_CACHE_MS)
      return this.cached.checks;
    this.inFlight ??= this.run().then(
      (checks) => {
        this.cached = { at: this.clock.now().getTime(), checks };
        this.inFlight = undefined;
        return checks;
      },
      /* istanbul ignore next -- run() never rejects: every check catches its own error. */
      (err: unknown) => {
        this.inFlight = undefined;
        throw err;
      },
    );
    return this.inFlight;
  }

  /** Every check, run independently. */
  private async run(): Promise<ReadinessChecks> {
    const binding = bindingOf(this.gateway);
    const guard = async (name: string, fn: () => Promise<boolean>): Promise<CheckResult> => {
      try {
        if (await fn()) return 'ok';
        this.logger.emit('warn', 'readiness check failed', { check: name });
      } catch (err) {
        this.logger.emit('warn', 'readiness check failed', {
          check: name,
          error: describeError(err),
        });
      }
      return 'fail';
    };
    const [database, node, deployment] = await Promise.all([
      guard('database', async () => {
        await this.prisma.$queryRaw`SELECT 1`;
        return true;
      }),
      guard('node', async () => BigInt(await this.gateway.getChainId()) === binding.chainId),
      guard('deployment', async () => {
        const active = await this.prisma.deployment.findFirst({
          where: { chainId: binding.chainId, active: true },
        });
        return active !== null && isBound(active, binding);
      }),
    ]);
    return { database, node, deployment };
  }
}

/** `/health` and `/ready`. Public. */
@ApiTags('health')
@Access('public')
@Controller()
export class HealthController {
  /** @param readiness The checks. */
  constructor(private readonly readiness: ReadinessService) {}

  /** Liveness. */
  @Get('health')
  @ApiOperation({ summary: 'Liveness: the process answers (no dependency checked)' })
  @ApiOkResponse({ type: HealthDto })
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness. */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness: database, node (chain id) and deployment binding' })
  @ApiOkResponse({ type: ReadyDto })
  @ApiProblems('NOT_READY')
  async ready(): Promise<{ status: 'ready'; checks: ReadinessChecks }> {
    const checks = await this.readiness.check();
    if (Object.values(checks).some((c) => c !== 'ok'))
      throw new ApiProblem('NOT_READY', { checks });
    return { status: 'ready', checks };
  }
}

/** The health feature. */
@Module({ controllers: [HealthController], providers: [ReadinessService] })
export class HealthModule {}
