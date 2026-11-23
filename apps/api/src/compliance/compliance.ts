/**
 * @file Compliance requests (allow / disallow / freeze / unfreeze), admin token only.
 *
 * The API records the operator's decision through the engine's `ComplianceService` (one
 * transaction: the change, its outbox row for the compliance signer, an audit row); the worker
 * signs and sends it, and the change is `confirmed` only once a final registry event carries its
 * reference. The response is therefore `requested`, not "done": the account is not frozen until
 * the change is confirmed (poll `GET /v1/admin/compliance-changes/:id`).
 *
 * `requestedBy` is the operator identity the idempotency key is scoped to. With one static admin
 * token there is one operator identity, `admin-token`; behind an identity provider it becomes the
 * operator's subject claim (never a value the client sends in the body).
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
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import type {
  ComplianceChangeRecord,
  ComplianceRequestKind,
  ComplianceService,
} from '@bridge/engine';
import { IsDefined, IsIn, IsString, Length, Matches } from 'class-validator';
import type { Response } from 'express';

import { Access } from '../auth/auth';
import { IDEMPOTENCY_HEADER, IdempotencyKey } from '../core/idempotency-key';
import { ADMIN_AUTH, ApiProblems } from '../core/openapi';
import { uuidParam } from '../core/params';
import { COMPLIANCE_SERVICE } from '../core/tokens';

/** The requester identity of the static admin token (see the file comment). */
export const ADMIN_REQUESTER = 'admin-token';

const ACTIONS: readonly ComplianceRequestKind[] = ['allow', 'disallow', 'freeze', 'unfreeze'];

/** Body of `POST /v1/admin/compliance-changes`. */
export class ComplianceRequestDto {
  /** What to change. */
  @ApiProperty({
    enum: ACTIONS,
    description:
      'allow / disallow set the registry verified flag; freeze / unfreeze the frozen flag.',
    example: 'freeze',
  })
  @IsDefined()
  @IsIn(ACTIONS, { message: `action must be one of ${ACTIONS.join(', ')}` })
  readonly action?: ComplianceRequestKind;

  /** The account. */
  @ApiProperty({ example: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' })
  @IsDefined()
  @IsString()
  @Matches(/^0x[0-9a-fA-F]{40}$/, {
    message: 'walletAddress must be 0x followed by 40 hex characters',
  })
  readonly walletAddress?: string;

  /** Why (audit trail). */
  @ApiProperty({
    description: 'Why, for the audit trail (1-500 characters). No personal data.',
    example: 'sanctions screening hit, case 2026-118',
  })
  @IsDefined()
  @IsString()
  @Length(1, 500)
  readonly reason?: string;
}

/** A compliance change as the API returns it. */
export interface ComplianceChangeView {
  /** The change id. */
  readonly id: string;
  /** verify, unverify, freeze or unfreeze (the registry action). */
  readonly action: ComplianceChangeRecord['action'];
  /** The account, lowercase. */
  readonly walletAddress: string;
  /** The user owning it. */
  readonly userId: string;
  /** requested, submitted, confirmed or failed. */
  readonly status: ComplianceChangeRecord['status'];
  /** The single-use registry reference. */
  readonly ref: string;
  /** The block the registry applied it in, once confirmed. */
  readonly confirmedBlock: string | null;
  /** Why. */
  readonly reason: string | null;
  /** Who asked. */
  readonly requestedBy: string | null;
  /** The deployment. */
  readonly deploymentId: string;
}

/** Schema of `ComplianceChangeView`. */
export class ComplianceChangeDto {
  /** Id. */
  @ApiProperty({ format: 'uuid' }) readonly id?: string;
  /** Action. */
  @ApiProperty({ enum: ['verify', 'unverify', 'freeze', 'unfreeze'] }) readonly action?: string;
  /** Account. */
  @ApiProperty() readonly walletAddress?: string;
  /** User. */
  @ApiProperty({ format: 'uuid' }) readonly userId?: string;
  /** Status. */
  @ApiProperty({ enum: ['requested', 'submitted', 'confirmed', 'failed'] })
  readonly status?: string;
  /** Reference. */
  @ApiProperty() readonly ref?: string;
  /** Block. */
  @ApiProperty({ nullable: true, type: String }) readonly confirmedBlock?: string | null;
  /** Reason. */
  @ApiProperty({ nullable: true, type: String }) readonly reason?: string | null;
  /** Requester. */
  @ApiProperty({ nullable: true, type: String }) readonly requestedBy?: string | null;
  /** Deployment. */
  @ApiProperty({ format: 'uuid' }) readonly deploymentId?: string;
}

/**
 * The API view of an engine compliance record.
 *
 * @param c The record.
 */
export function toComplianceView(c: ComplianceChangeRecord): ComplianceChangeView {
  return {
    id: c.id,
    action: c.action,
    walletAddress: c.account,
    userId: c.userId,
    status: c.status,
    ref: c.ref,
    confirmedBlock: c.confirmedBlock === null ? null : c.confirmedBlock.toString(),
    reason: c.reason,
    requestedBy: c.requestedBy,
    deploymentId: c.deploymentId,
  };
}

/** Records and reads compliance changes. */
@Injectable()
export class ComplianceApiService {
  /** @param engine The engine's compliance service. */
  constructor(@Inject(COMPLIANCE_SERVICE) private readonly engine: ComplianceService) {}

  /**
   * Records one change.
   *
   * @param body The validated request.
   * @param idempotencyKey The key.
   */
  async request(
    body: ComplianceRequestDto,
    idempotencyKey: string,
  ): Promise<{ view: ComplianceChangeView; replayed: boolean }> {
    const result = await this.engine.request(body.action ?? ('' as ComplianceRequestKind), {
      address: String(body.walletAddress),
      reason: String(body.reason),
      idempotencyKey,
      requestedBy: ADMIN_REQUESTER,
    });
    return { view: toComplianceView(result.change), replayed: result.replayed };
  }

  /**
   * One change (`COMPLIANCE_CHANGE_NOT_FOUND` from the engine otherwise).
   *
   * @param id The change id.
   */
  async get(id: string): Promise<ComplianceChangeView> {
    return toComplianceView(await this.engine.get(id));
  }
}

/** `/v1/admin/compliance-changes`. Admin token only. */
@ApiTags('compliance')
@ApiBearerAuth(ADMIN_AUTH)
@Access('admin')
@Controller('v1/admin/compliance-changes')
export class ComplianceController {
  /** @param compliance The service. */
  constructor(private readonly compliance: ComplianceApiService) {}

  /** Requests a compliance change. */
  @Post()
  @ApiOperation({
    summary:
      'Request a compliance change (allow, disallow, freeze, unfreeze); applied once confirmed on chain',
  })
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description:
      'REQUIRED. Same key + same body: the stored change (200). Same key + other body: 409.',
  })
  @ApiCreatedResponse({ type: ComplianceChangeDto })
  @ApiOkResponse({ type: ComplianceChangeDto, description: 'Replay: the stored change.' })
  @ApiProblems(
    'VALIDATION_FAILED',
    'MALFORMED_JSON',
    'IDEMPOTENCY_KEY_MISSING',
    'IDEMPOTENCY_KEY_INVALID',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'USER_NOT_FOUND',
    'IDEMPOTENCY_CONFLICT',
    'NO_ACTIVE_DEPLOYMENT',
    'DEPLOYMENT_MISMATCH',
    'BUSY',
  )
  async create(
    @IdempotencyKey() idempotencyKey: string,
    @Body() body: ComplianceRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ComplianceChangeView> {
    const { view, replayed } = await this.compliance.request(body, idempotencyKey);
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return view;
  }

  /** Reads a compliance change. */
  @Get(':changeId')
  @ApiOperation({ summary: 'Read a compliance change' })
  @ApiOkResponse({ type: ComplianceChangeDto })
  @ApiProblems('VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'COMPLIANCE_CHANGE_NOT_FOUND')
  get(@Param('changeId', uuidParam('changeId')) changeId: string): Promise<ComplianceChangeView> {
    return this.compliance.get(changeId);
  }
}

/** The compliance feature. */
@Module({ controllers: [ComplianceController], providers: [ComplianceApiService] })
export class ComplianceModule {}
