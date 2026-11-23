/**
 * @file Liveness and readiness, public (an orchestrator probes them without a credential).
 *
 * - `GET /health`: the process answers. No dependency is touched, so a slow database never gets
 *   a healthy process restarted.
 * - `GET /ready`: the process can serve requests: the database answers, the node answers with the
 *   configured chain id, and the database's ACTIVE deployment of that chain is the configured
 *   token + registry (the engine's binding). 503 problem+json otherwise, with one `ok` / `fail`
 *   per check and nothing else: no error text, no addresses, no URLs (it is unauthenticated).
 */

import { Controller, Get, Inject, Injectable, Module } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { ChainGateway } from '@bridge/chain';
import type { PrismaClient } from '@bridge/db';
import { bindingOf, describeError, isBound } from '@bridge/engine';

import { Access } from '../auth/auth';
import type { JsonLogger } from '../core/logger';
import { ApiProblems } from '../core/openapi';
import { ApiProblem } from '../core/problem';
import { CHAIN_GATEWAY, LOGGER, PRISMA } from '../core/tokens';

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
  ) {}

  /** Every check, run independently. */
  async check(): Promise<ReadinessChecks> {
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
