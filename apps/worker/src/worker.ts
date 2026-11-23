/**
 * @file Wiring of the worker: a NestJS standalone application context (no HTTP server) that
 * holds the Prisma client, the viem gateway with both signer keys, the transaction inspector, the
 * `BridgeEngine` and the runner, and closes the database when it shuts down.
 *
 * `runWorker(env)` is the whole process, fail fast and in this order:
 *
 * 1. validate the environment (every problem at once, never a value; mainnet / unknown chains and
 *    Anvil's development keys on real chains refused);
 * 2. connect the database and build the gateway, then check that the node reports the configured
 *    chain id (before anything is read or signed);
 * 3. build the engine (its constructor checks the gateway's deployment against the configured
 *    token and refuses any isolation level but READ COMMITTED);
 * 4. the runner checks the database's ACTIVE deployment against the gateway's (the engine's
 *    `assertDeployment`) and the recorded signer addresses against the configured keys, then runs
 *    the loop until SIGTERM / SIGINT or a fatal alarm.
 *
 * Every refusal is logged as one line naming the reason and returns exit code 1.
 */

import 'reflect-metadata';

import { hostname } from 'node:os';

import {
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type ChainGateway, ViemChainGateway } from '@bridge/chain';
import { createPrismaClient, type PrismaClient } from '@bridge/db';
import {
  BridgeEngine,
  describeError,
  randomIds,
  type RawTransactionInspector,
  systemClock,
  ViemTransactionInspector,
} from '@bridge/engine';
import {
  assertNodeChainId,
  ConfigError,
  type Env,
  loadWorkerConfig,
  secretValues,
  type WorkerConfig,
} from '@bridge/engine/env';

import { WorkerAlarmSink, WorkerLogger } from './logger';
import { type SignalSource, WorkerRunner } from './runner';

/** DI token of the Prisma client. */
export const WORKER_PRISMA = Symbol('WORKER_PRISMA');

/** Disconnects the database when the context closes. */
@Injectable()
class PrismaCloser implements OnApplicationShutdown {
  constructor(@Inject(WORKER_PRISMA) private readonly prisma: PrismaClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/** The worker's module: the runner and the database it closes. */
@Module({})
export class WorkerModule {
  /**
   * @param runner The runner.
   * @param prisma The database (closed with the context).
   */
  static forRoot(runner: WorkerRunner, prisma: PrismaClient): DynamicModule {
    return {
      module: WorkerModule,
      providers: [
        { provide: WorkerRunner, useValue: runner },
        { provide: WORKER_PRISMA, useValue: prisma },
        PrismaCloser,
      ],
    };
  }
}

/** Factories `runWorker` uses; tests replace them. */
export interface WorkerDeps {
  /** Builds the database client. */
  readonly createPrisma: (url: string) => PrismaClient;
  /** Builds the signing gateway. */
  readonly createGateway: (config: WorkerConfig) => ChainGateway;
  /** Builds the inspector matching the gateway's signed encoding. */
  readonly createInspector: (gateway: ChainGateway) => RawTransactionInspector;
  /** Where log lines go (default stdout). */
  readonly write?: (line: string) => void;
  /** Signals (default `process`). */
  readonly signals?: SignalSource;
}

/** The production gateway: viem on `RPC_URL` with both signer keys. */
export function viemGateway(config: WorkerConfig): ChainGateway {
  return new ViemChainGateway({
    rpcUrl: config.chain.rpcUrl.reveal(),
    chainId: config.chain.chainId,
    tokenAddress: config.chain.tokenAddress,
    registryAddress: config.chain.registryAddress,
    signers: {
      settlement: config.settlementKey.reveal() as `0x${string}`,
      compliance: config.complianceKey.reveal() as `0x${string}`,
    },
    timeoutMs: config.chain.rpcTimeoutMs,
  });
}

/** The production factories. */
export const DEFAULT_WORKER_DEPS: WorkerDeps = {
  createPrisma: createPrismaClient,
  createGateway: viemGateway,
  createInspector: () => new ViemTransactionInspector(),
};

/**
 * The signer addresses recorded for the active deployment must be the configured keys' addresses:
 * nonces and evidence belong to an address. The engine checks this per row too (and waits); at
 * startup a mismatch is a misconfiguration, so the worker refuses to run.
 */
async function assertSignersBound(prisma: PrismaClient, gateway: ChainGateway): Promise<void> {
  const d = gateway.deployment();
  const active = await prisma.deployment.findFirst({
    where: { chainId: BigInt(d.chainId), active: true },
    include: { signerStates: true },
  });
  for (const signer of ['settlement', 'compliance'] as const) {
    const recorded = active?.signerStates.find((s) => s.signer === signer)?.address;
    const configured = gateway.signerAddress(signer);
    if (recorded === undefined || recorded.toLowerCase() !== configured.toLowerCase()) {
      throw new Error(
        `the ${signer} signer of the active deployment is ${String(recorded)}, the configured key is ${configured}`,
      );
    }
  }
}

/**
 * The whole worker process. Resolves with the exit code; never rejects.
 *
 * @param env The environment.
 * @param deps Factories (default: the real ones).
 */
export async function runWorker(env: Env, deps: WorkerDeps = DEFAULT_WORKER_DEPS): Promise<number> {
  let config: WorkerConfig;
  try {
    config = loadWorkerConfig(env);
  } catch (err) {
    const why = err instanceof ConfigError ? err.message : describeError(err);
    (deps.write ?? ((l: string) => process.stderr.write(`${l}\n`)))(
      JSON.stringify({ level: 'error', service: 'worker', msg: `refusing to start: ${why}` }),
    );
    return 1;
  }
  const logger = new WorkerLogger({
    level: config.logLevel,
    secrets: secretValues(config),
    ...(deps.write !== undefined ? { write: deps.write } : {}),
  });
  const prisma = deps.createPrisma(config.databaseUrl.reveal());
  let closePrisma = true;
  try {
    const gateway = deps.createGateway(config);
    assertNodeChainId(config.chain.chainId, await gateway.getChainId());
    const alarms = new WorkerAlarmSink(logger);
    const workerId = config.workerId ?? `${hostname()}:${process.pid}`;
    const engine = new BridgeEngine(
      {
        prisma,
        gateway,
        inspector: deps.createInspector(gateway),
        clock: systemClock,
        ids: randomIds,
        alarms,
      },
      {
        chainId: BigInt(config.chain.chainId),
        tokenAddress: config.chain.tokenAddress,
        workerId,
        confirmationDepth: config.chain.confirmationDepth,
        feeCap: config.feeCapWei,
        pollIntervalMs: config.pollIntervalMs,
        reconcileEveryTicks: config.reconcileEveryTicks,
        secrets: secretValues(config),
      },
    );
    const runner = new WorkerRunner({
      engine,
      logger,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
      ...(deps.signals !== undefined ? { signals: deps.signals } : {}),
      checks: () => assertSignersBound(prisma, gateway),
    });
    alarms.onFatal = (alarm) => runner.onFatalAlarm(alarm);
    const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(runner, prisma), {
      logger,
    });
    closePrisma = false; // the context owns it now
    logger.emit('log', 'worker starting', {
      workerId,
      chainId: config.chain.chainId,
      chainClass: config.chain.chainClass,
      tokenAddress: config.chain.tokenAddress,
      registryAddress: config.chain.registryAddress,
      settlementSigner: gateway.signerAddress('settlement'),
      complianceSigner: gateway.signerAddress('compliance'),
      confirmationDepth: config.chain.confirmationDepth,
    });
    const code = await app.get(WorkerRunner).run();
    await app.close();
    return code;
  } catch (err) {
    logger.emit('error', 'refusing to start', { error: describeError(err) });
    return 1;
  } finally {
    if (closePrisma) await prisma.$disconnect().catch(() => undefined);
  }
}
