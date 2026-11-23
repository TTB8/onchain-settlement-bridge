/**
 * @file Deposits, withdrawals and transfers: the API side of the engine's `OperationService`.
 *
 * Each POST takes the amount as a decimal string of the smallest unit (`parseAmount`), the
 * REQUIRED `Idempotency-Key` header, and hands ONE request to the engine, which reserves the
 * funds, binds the operation to the active deployment and enqueues the chain call in one
 * transaction. This layer adds no money logic of its own: no balance check (the engine reads the
 * balance under the row lock; a check here would be a check-then-act race) and no retry loop
 * (the engine retries serialization failures; a client retries a 503 with the same key).
 *
 * Responses: 201 for a new operation, 200 with `Idempotent-Replayed: true` for a replay of the
 * same request (nothing written), 409 for the same key with another body, 422 for insufficient
 * funds, 503 + Retry-After while no deployment is active.
 *
 * Reads go to the database directly (read-only Prisma queries); the full row is returned so a
 * caller sees `failureReason` and `confirmedBlock` as the engine moves the operation along.
 */

import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Operation, PrismaClient } from '@bridge/db';
import type { ApiConfig } from '@bridge/engine/env';
import type { OperationRequest, OperationService } from '@bridge/engine';
import { IsDefined, IsString, IsUUID } from 'class-validator';
import type { Response } from 'express';

import { Access } from '../auth/auth';
import { AMOUNT_RULE, formatAmount, parseAmount } from '../core/amount';
import { IDEMPOTENCY_HEADER, IdempotencyKey } from '../core/idempotency-key';
import { ApiProblems, PLATFORM_AUTH } from '../core/openapi';
import { parseLimit, uuidParam } from '../core/params';
import { ApiProblem } from '../core/problem';
import { API_CONFIG, OPERATION_SERVICE, PRISMA } from '../core/tokens';

const AMOUNT_EXAMPLE = '1500000';

/** Body of a deposit or withdrawal. */
export class AmountDto {
  /** The amount, decimal string of the smallest unit. */
  @ApiProperty({
    description: `Amount in the token's smallest unit (6 decimals), as a decimal STRING: ${AMOUNT_RULE}. "1500000" is 1.5 tokens. A JSON number is refused.`,
    example: AMOUNT_EXAMPLE,
    pattern: '^[1-9][0-9]{0,18}$',
  })
  @IsDefined()
  @IsString({ message: AMOUNT_RULE })
  readonly amount?: string;
}

/** Body of a transfer. */
export class TransferDto extends AmountDto {
  /** The recipient. */
  @ApiProperty({ format: 'uuid', description: 'The recipient user id (not the sender).' })
  @IsDefined()
  @IsUUID('all', { message: 'toUserId must be a UUID' })
  readonly toUserId?: string;
}

/** An operation as the API returns it. Amounts and block numbers are decimal strings. */
export interface OperationView {
  /** The operation id. */
  readonly id: string;
  /** deposit, withdrawal or transfer. */
  readonly type: Operation['type'];
  /** The current status. */
  readonly status: Operation['status'];
  /** Deposit recipient, withdrawal owner or transfer sender. */
  readonly userId: string;
  /** Transfer recipient; null otherwise. */
  readonly counterpartyUserId: string | null;
  /** Amount, smallest unit. */
  readonly amount: string;
  /** The single-use on-chain reference (bytes32). */
  readonly ref: string;
  /** Why it failed, once failed or reversed. */
  readonly failureReason: Operation['failureReason'];
  /** The block of the settling event, once confirmed. */
  readonly confirmedBlock: string | null;
  /** The deployment the operation is bound to. */
  readonly deploymentId: string;
  /** Created (ISO 8601, UTC). */
  readonly createdAt: string;
  /** Last changed (ISO 8601, UTC). */
  readonly updatedAt: string;
}

/** Schema of `OperationView`. */
export class OperationDto {
  /** Id. */
  @ApiProperty({ format: 'uuid' }) readonly id?: string;
  /** Type. */
  @ApiProperty({ enum: ['deposit', 'withdrawal', 'transfer'] }) readonly type?: string;
  /** Status. */
  @ApiProperty({
    enum: ['requested', 'ledger_reserved', 'submitted', 'confirmed', 'failed', 'reversed'],
    example: 'ledger_reserved',
  })
  readonly status?: string;
  /** Owner. */
  @ApiProperty({ format: 'uuid' }) readonly userId?: string;
  /** Transfer recipient. */
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  readonly counterpartyUserId?: string | null;
  /** Amount. */
  @ApiProperty({ example: AMOUNT_EXAMPLE, description: 'Smallest unit, decimal string.' })
  readonly amount?: string;
  /** Reference. */
  @ApiProperty({ example: `0x${'ab'.repeat(32)}` }) readonly ref?: string;
  /** Failure reason. */
  @ApiProperty({
    nullable: true,
    type: String,
    enum: [
      'reverted',
      'dropped',
      'compliance_rejected',
      'duplicate_reference',
      'reference_conflict',
      'retries_exhausted',
      'rejected',
    ],
  })
  readonly failureReason?: string | null;
  /** Settling block. */
  @ApiProperty({ nullable: true, type: String, example: '1234' })
  readonly confirmedBlock?: string | null;
  /** Deployment. */
  @ApiProperty({ format: 'uuid' }) readonly deploymentId?: string;
  /** Created. */
  @ApiProperty({ format: 'date-time' }) readonly createdAt?: string;
  /** Updated. */
  @ApiProperty({ format: 'date-time' }) readonly updatedAt?: string;
}

/** A page of a user's operations. */
export interface OperationPage {
  /** Newest first. */
  readonly items: readonly OperationView[];
  /** Pass as `cursor` for the next page; null on the last page. */
  readonly nextCursor: string | null;
}

/** Schema of `OperationPage`. */
export class OperationPageDto {
  /** Items. */
  @ApiProperty({ type: [OperationDto] }) readonly items?: OperationDto[];
  /** Next cursor. */
  @ApiPropertyOptional({ nullable: true, type: String }) readonly nextCursor?: string | null;
}

/**
 * The API view of an operation row.
 *
 * @param op The row.
 */
export function toOperationView(op: Operation): OperationView {
  return {
    id: op.id,
    type: op.type,
    status: op.status,
    userId: op.userId,
    counterpartyUserId: op.counterpartyUserId,
    amount: formatAmount(op.amount),
    ref: op.ref,
    failureReason: op.failureReason,
    confirmedBlock: op.confirmedBlock === null ? null : op.confirmedBlock.toString(),
    deploymentId: op.deploymentId,
    createdAt: op.createdAt.toISOString(),
    updatedAt: op.updatedAt.toISOString(),
  };
}

/** A keyset cursor: the last item's creation time and id. */
interface Cursor {
  readonly t: Date;
  readonly id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Encodes a cursor (opaque to clients). */
export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.t.toISOString()}|${c.id}`, 'utf8').toString('base64url');
}

/** Decodes a cursor (any query value: a repeated parameter arrives as an array), or `VALIDATION_FAILED`. */
export function decodeCursor(value: unknown): Cursor {
  const bad = () =>
    new ApiProblem('VALIDATION_FAILED', {
      errors: [{ field: 'cursor', message: 'must be a cursor returned by this API' }],
    });
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw bad();
  const [time, id, extra] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  const t = new Date(time ?? '');
  if (extra !== undefined || id === undefined || !UUID.test(id) || Number.isNaN(t.getTime())) {
    throw bad();
  }
  return { t, id };
}

/** Requests and reads operations. */
@Injectable()
export class OperationsService {
  /**
   * @param prisma The database (reads).
   * @param engine The engine's operation service (every write).
   * @param config The amount cap.
   */
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(OPERATION_SERVICE) private readonly engine: OperationService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /** The configured cap on one request's amount. */
  get maxAmount(): bigint {
    return this.config.maxAmount;
  }

  /**
   * Hands one request to the engine and returns the stored operation.
   *
   * @param req The request.
   */
  async request(req: OperationRequest): Promise<{ view: OperationView; replayed: boolean }> {
    const result = await this.engine.request(req);
    const row = await this.prisma.operation.findUniqueOrThrow({
      where: { id: result.operation.id },
    });
    return { view: toOperationView(row), replayed: result.replayed };
  }

  /**
   * One operation, or `OPERATION_NOT_FOUND`.
   *
   * @param id The operation id.
   */
  async get(id: string): Promise<OperationView> {
    const op = await this.prisma.operation.findUnique({ where: { id } });
    if (op === null) throw new ApiProblem('OPERATION_NOT_FOUND');
    return toOperationView(op);
  }

  /**
   * A user's operations (as owner or as transfer recipient), newest first.
   *
   * @param userId The user.
   * @param limit Page size.
   * @param cursor From the previous page.
   */
  async listForUser(userId: string, limit: number, cursor?: unknown): Promise<OperationPage> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (user === null) throw new ApiProblem('USER_NOT_FOUND');
    const after = cursor === undefined ? undefined : decodeCursor(cursor);
    const rows = await this.prisma.operation.findMany({
      where: {
        AND: [
          { OR: [{ userId }, { counterpartyUserId: userId }] },
          ...(after === undefined
            ? []
            : [
                {
                  OR: [
                    { createdAt: { lt: after.t } },
                    { createdAt: after.t, id: { lt: after.id } },
                  ],
                },
              ]),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toOperationView),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor({ t: last.createdAt, id: last.id })
          : null,
    };
  }
}

const KEY_HEADER = {
  name: IDEMPOTENCY_HEADER,
  required: true,
  description:
    'REQUIRED. 1-255 visible ASCII characters. Same key + same body: the stored operation (200, Idempotent-Replayed: true). Same key + other body: 409.',
  example: 'deposit-2026-11-23-0001',
};

const WRITE_PROBLEMS = [
  'VALIDATION_FAILED',
  'MALFORMED_JSON',
  'PAYLOAD_TOO_LARGE',
  'IDEMPOTENCY_KEY_MISSING',
  'IDEMPOTENCY_KEY_INVALID',
  'AMOUNT_ABOVE_LIMIT',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'USER_NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
  'NO_ACTIVE_DEPLOYMENT',
  'DEPLOYMENT_MISMATCH',
  'BUSY',
] as const;

/** `/v1/users/:userId/{deposits,withdrawals,transfers,operations}` and `/v1/operations/:id`. */
@ApiTags('operations')
@ApiBearerAuth(PLATFORM_AUTH)
@Access('platform')
@Controller('v1')
export class OperationsController {
  /** @param operations The service. */
  constructor(private readonly operations: OperationsService) {}

  /** Requests a deposit (fiat received; tokens minted to the user's wallet). */
  @Post('users/:userId/deposits')
  @ApiOperation({ summary: 'Request a deposit (fiat received off-chain; mint on chain)' })
  @ApiHeader(KEY_HEADER)
  @ApiCreatedResponse({ type: OperationDto, description: 'New operation (ledger_reserved).' })
  @ApiOkResponse({ type: OperationDto, description: 'Replay: the stored operation.' })
  @ApiProblems(...WRITE_PROBLEMS)
  deposit(
    @Param('userId', uuidParam('userId')) userId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body() body: AmountDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OperationView> {
    const amount = parseAmount(body.amount, this.operations.maxAmount);
    return this.send(res, { type: 'deposit', userId, amount, idempotencyKey });
  }

  /** Requests a withdrawal (tokens burned; fiat paid out). */
  @Post('users/:userId/withdrawals')
  @ApiOperation({ summary: 'Request a withdrawal (burn on chain; pay out off-chain)' })
  @ApiHeader(KEY_HEADER)
  @ApiCreatedResponse({ type: OperationDto })
  @ApiOkResponse({ type: OperationDto, description: 'Replay: the stored operation.' })
  @ApiProblems(...WRITE_PROBLEMS, 'INSUFFICIENT_FUNDS')
  withdraw(
    @Param('userId', uuidParam('userId')) userId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body() body: AmountDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OperationView> {
    const amount = parseAmount(body.amount, this.operations.maxAmount);
    return this.send(res, { type: 'withdrawal', userId, amount, idempotencyKey });
  }

  /** Requests a transfer between two users. */
  @Post('users/:userId/transfers')
  @ApiOperation({ summary: 'Request a transfer from this user to another' })
  @ApiHeader(KEY_HEADER)
  @ApiCreatedResponse({ type: OperationDto })
  @ApiOkResponse({ type: OperationDto, description: 'Replay: the stored operation.' })
  @ApiProblems(...WRITE_PROBLEMS, 'INSUFFICIENT_FUNDS', 'SELF_TRANSFER')
  transfer(
    @Param('userId', uuidParam('userId')) userId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body() body: TransferDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OperationView> {
    const amount = parseAmount(body.amount, this.operations.maxAmount);
    return this.send(res, {
      type: 'transfer',
      fromUserId: userId,
      toUserId: String(body.toUserId).toLowerCase(),
      amount,
      idempotencyKey,
    });
  }

  /** Lists a user's operations. */
  @Get('users/:userId/operations')
  @ApiOperation({
    summary: "List a user's operations (as owner or transfer recipient), newest first",
  })
  @ApiQuery({ name: 'limit', required: false, description: '1-100, default 20', example: '20' })
  @ApiQuery({ name: 'cursor', required: false, description: 'nextCursor of the previous page' })
  @ApiOkResponse({ type: OperationPageDto })
  @ApiProblems('VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'USER_NOT_FOUND')
  list(
    @Param('userId', uuidParam('userId')) userId: string,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<OperationPage> {
    return this.operations.listForUser(userId, parseLimit(limit, 20, 100), cursor);
  }

  /** Reads one operation. */
  @Get('operations/:operationId')
  @ApiOperation({ summary: 'Read an operation' })
  @ApiOkResponse({ type: OperationDto })
  @ApiProblems('VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'OPERATION_NOT_FOUND')
  get(@Param('operationId', uuidParam('operationId')) operationId: string): Promise<OperationView> {
    return this.operations.get(operationId);
  }

  private async send(res: Response, req: OperationRequest): Promise<OperationView> {
    const { view, replayed } = await this.operations.request(req);
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return view;
  }
}

/** The operations feature. */
@Module({ controllers: [OperationsController], providers: [OperationsService] })
export class OperationsModule {}
