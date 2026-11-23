/**
 * @file Wiring of the API: the root module, the HTTP application (security headers, body limit,
 * validation, problem+json errors, OpenAPI) and the startup sequence.
 *
 * Startup (`startApi`), fail fast and in this order: validate the environment (every problem at
 * once, no value printed), connect the database, build the read-only gateway, check that the node
 * reports the configured chain id, build the app, listen. Any failure exits non-zero before a
 * single request is served.
 *
 * The engine services the API needs are built here WITHOUT `BridgeEngine`: the API never runs a
 * tick and never signs, so it gets the `OperationService`, `ComplianceService` and `Reconciler`
 * bound to the gateway's deployment, and nothing that holds a key.
 */

import 'reflect-metadata';

import {
  type DynamicModule,
  Global,
  Module,
  type OnApplicationShutdown,
  Inject,
  Injectable,
  ValidationPipe,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import type { ChainGateway } from '@bridge/chain';
import { createPrismaClient, type PrismaClient } from '@bridge/db';
import {
  bindingOf,
  ComplianceService,
  OperationService,
  randomIds,
  Reconciler,
  systemClock,
} from '@bridge/engine';
import {
  type ApiConfig,
  assertNodeChainId,
  type Env,
  loadApiConfig,
  secretValues,
} from '@bridge/engine/env';
import type { ValidationError } from 'class-validator';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

import { AdminModule } from './admin/reconciliations';
import { AuthGuard } from './auth/auth';
import { BalancesModule } from './balances/balances';
import { buildReadOnlyGateway } from './chain/read-only-gateway';
import { ComplianceModule } from './compliance/compliance';
import { JsonLogger, LoggingAlarmSink } from './core/logger';
import { ADMIN_AUTH, FieldErrorDto, PLATFORM_AUTH, ProblemDto } from './core/openapi';
import { ApiProblem, type FieldError } from './core/problem';
import { ProblemFilter, sendProblem } from './core/problem.filter';
import { requestContext } from './core/request-context';
import {
  ALARM_SINK,
  API_CONFIG,
  type ApiRuntime,
  CHAIN_GATEWAY,
  CLOCK,
  COMPLIANCE_SERVICE,
  IDS,
  LOGGER,
  OPERATION_SERVICE,
  PRISMA,
  RECONCILER,
} from './core/tokens';
import { HealthModule } from './health/health';
import { OperationsModule } from './operations/operations';
import { UsersModule } from './users/users';

/** The providers every feature module may inject. */
@Global()
@Module({})
export class CoreModule {
  /**
   * The core providers from a runtime.
   *
   * @param runtime Configuration, database, gateway, clock, ids, logger.
   */
  static forRoot(runtime: ApiRuntime): DynamicModule {
    const binding = bindingOf(runtime.gateway);
    const alarms = runtime.alarms ?? new LoggingAlarmSink(runtime.logger);
    const providers = [
      { provide: API_CONFIG, useValue: runtime.config },
      { provide: PRISMA, useValue: runtime.prisma },
      { provide: CHAIN_GATEWAY, useValue: runtime.gateway },
      { provide: CLOCK, useValue: runtime.clock },
      { provide: IDS, useValue: runtime.ids },
      { provide: LOGGER, useValue: runtime.logger },
      { provide: ALARM_SINK, useValue: alarms },
      {
        provide: OPERATION_SERVICE,
        useValue: new OperationService({
          prisma: runtime.prisma,
          clock: runtime.clock,
          ids: runtime.ids,
          chainId: binding.chainId,
          tokenAddress: binding.tokenAddress,
        }),
      },
      {
        provide: COMPLIANCE_SERVICE,
        useValue: new ComplianceService({
          prisma: runtime.prisma,
          clock: runtime.clock,
          ids: runtime.ids,
          binding,
        }),
      },
      {
        provide: RECONCILER,
        useValue: new Reconciler({
          prisma: runtime.prisma,
          gateway: runtime.gateway,
          clock: runtime.clock,
          policy: { confirmationDepth: runtime.config.chain.confirmationDepth },
          alarms,
          secrets: secretValues(runtime.config),
        }),
      },
    ];
    return {
      module: CoreModule,
      providers,
      exports: providers.map((p) => p.provide),
    };
  }
}

/** The root module. */
@Module({})
export class AppModule {
  /**
   * The application from a runtime.
   *
   * @param runtime What the API is built from.
   */
  static forRoot(runtime: ApiRuntime): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(runtime),
        UsersModule,
        OperationsModule,
        BalancesModule,
        ComplianceModule,
        AdminModule,
        HealthModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    };
  }
}

/** Disconnects the database when the app closes (only when the app created the client). */
@Injectable()
class PrismaCloser implements OnApplicationShutdown {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/** Flattens class-validator errors into field errors (constraint messages only, never values). */
export function fieldErrors(errors: readonly ValidationError[], prefix = ''): FieldError[] {
  return errors.flatMap((e) => {
    const field = `${prefix}${e.property}`;
    const own = Object.values(e.constraints ?? {}).map((message) => ({
      field,
      message: message.slice(0, 300),
    }));
    return [...own, ...fieldErrors(e.children ?? [], `${field}.`)];
  });
}

/** The global validation pipe: unknown properties are refused, nothing is coerced. */
export function validationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    transform: true,
    // No implicit conversion: "amount": 10 must stay a number and be refused, never become "10".
    transformOptions: { enableImplicitConversion: false },
    validationError: { target: false, value: false },
    exceptionFactory: (errors) =>
      new ApiProblem('VALIDATION_FAILED', { errors: fieldErrors(errors) }),
  });
}

/**
 * The OpenAPI document: every route, the DTO schemas, both bearer schemes and the problem schema.
 *
 * @param app The application (initialised or not).
 */
export function buildOpenApiDocument(app: NestExpressApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('On-chain settlement bridge API')
    .setDescription(
      [
        'Off-chain ledger to on-chain settlement. Amounts are DECIMAL STRINGS in the smallest unit',
        '(6 decimals: "1500000" = 1.5 tokens); JSON numbers are refused. Every POST that moves',
        'money or changes compliance requires an Idempotency-Key header. Errors are RFC 9457',
        'application/problem+json with a stable `type` and `code`.',
        '',
        'Auth: two static bearer tokens. `platform-token` for user, operation and balance routes;',
        "`admin-token` for compliance and reconciliation. Neither is accepted on the other's",
        'routes (403). Real deployments put an identity provider in front.',
      ].join('\n'),
    )
    .setVersion('1')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', description: 'API_PLATFORM_TOKEN' },
      PLATFORM_AUTH,
    )
    .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'API_ADMIN_TOKEN' }, ADMIN_AUTH)
    .build();
  return SwaggerModule.createDocument(app, config, { extraModels: [ProblemDto, FieldErrorDto] });
}

/**
 * The configured HTTP application, not yet listening.
 *
 * @param runtime What the API is built from.
 * @param options `ownsPrisma`: disconnect the database on close (production; tests own theirs).
 */
export async function createApiApp(
  runtime: ApiRuntime,
  options: { ownsPrisma?: boolean } = {},
): Promise<NestExpressApplication> {
  const root = AppModule.forRoot(runtime);
  if (options.ownsPrisma === true) root.providers = [...(root.providers ?? []), PrismaCloser];
  const app = await NestFactory.create<NestExpressApplication>(root, {
    logger: runtime.logger,
    bodyParser: false,
  });
  const logger = runtime.logger;
  app.disable('x-powered-by');
  app.use(requestContext(logger));
  app.use(helmet());
  app.useBodyParser('json', { limit: runtime.config.bodyLimitBytes });
  // Body-parser failures (malformed JSON, too large) happen before Nest's pipeline: answer them
  // as problems here instead of Express's default HTML page.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    sendProblem(err, req, res, logger);
  });
  app.useGlobalPipes(validationPipe());
  if (runtime.config.docsEnabled) {
    SwaggerModule.setup('docs', app, () => buildOpenApiDocument(app), {
      jsonDocumentUrl: 'docs/openapi.json',
    });
  }
  return app;
}

/**
 * The database did not answer `SELECT 1` at startup. The message names no host, user or
 * password (the URL is a secret); the Prisma error is kept as `cause` for debugging only.
 */
export class DatabaseUnreachableError extends Error {
  /** @param cause The Prisma error. */
  constructor(cause: unknown) {
    super('the database is not reachable: check DATABASE_URL and that Postgres is up', { cause });
    this.name = 'DatabaseUnreachableError';
  }
}

/** Factories `startApi` uses; tests replace them. */
export interface StartDeps {
  /** Builds the database client. */
  readonly createPrisma: (url: string) => PrismaClient;
  /** Builds the read-only chain gateway. */
  readonly createGateway: (config: ApiConfig) => ChainGateway;
  /** Where log lines go. */
  readonly write?: (line: string) => void;
}

const DEFAULT_DEPS: StartDeps = {
  createPrisma: createPrismaClient,
  createGateway: (config) => buildReadOnlyGateway(config.chain),
};

/**
 * Validates the environment, checks the database (`SELECT 1`) and the node, builds and starts
 * the API. Rejects (and leaves
 * nothing running) on any failure.
 *
 * @param env The environment.
 * @param deps Factories (default: the real ones).
 */
export async function startApi(
  env: Env,
  deps: StartDeps = DEFAULT_DEPS,
): Promise<{ app: NestExpressApplication; url: string }> {
  const config = loadApiConfig(env);
  const logger = new JsonLogger({
    level: config.logLevel,
    secrets: secretValues(config),
    service: 'api',
    ...(deps.write !== undefined ? { write: deps.write } : {}),
  });
  const prisma = deps.createPrisma(config.databaseUrl.reveal());
  try {
    // Fail fast: an API that cannot reach its database must not report itself as listening.
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      throw new DatabaseUnreachableError(err);
    }
    const gateway = deps.createGateway(config);
    assertNodeChainId(config.chain.chainId, await gateway.getChainId());
    const app = await createApiApp(
      { config, prisma, gateway, clock: systemClock, ids: randomIds, logger },
      { ownsPrisma: true },
    );
    app.enableShutdownHooks();
    await app.listen(config.port, config.host);
    const url = `http://${config.host}:${config.port}`;
    // Host and port as separate fields: the host may also be part of a redacted secret.
    logger.emit('log', 'api listening', {
      host: config.host,
      port: config.port,
      chainId: config.chain.chainId,
      chainClass: config.chain.chainClass,
    });
    return { app, url };
  } catch (err) {
    await prisma.$disconnect();
    throw err;
  }
}
