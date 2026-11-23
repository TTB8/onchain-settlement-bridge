/**
 * @file Users: create a user with their wallet, read it back.
 *
 * A user is one `app_user` row plus its three ledger accounts (`user_available`, `user_held`,
 * `user_incoming`), created together in ONE transaction: an operation for a user with a missing
 * account would be refused by the engine, so a half-created user must never exist.
 *
 * The wallet is stored lowercase and is immutable (a database guard). The `verified` / `frozen`
 * columns of `app_user` are a NON-AUTHORITATIVE cache the engine never writes, so the API neither
 * returns nor decides on them: compliance state lives in confirmed compliance changes and on the
 * registry (engine README, "Known limits and rules for callers").
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
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { Prisma, type PrismaClient } from '@bridge/db';
import { IsDefined, IsString, Matches } from 'class-validator';
import type { Response } from 'express';

import { Access } from '../auth/auth';
import { ApiProblem } from '../core/problem';
import { ApiProblems, PLATFORM_AUTH } from '../core/openapi';
import { uuidParam } from '../core/params';
import { PRISMA } from '../core/tokens';

/** Body of `POST /v1/users`. */
export class CreateUserDto {
  /** The user's wallet (any case; stored lowercase). */
  @ApiProperty({
    description: 'The wallet the user holds tokens in: 0x + 40 hex (any case; stored lowercase).',
    example: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  })
  @IsDefined()
  @IsString()
  @Matches(/^0x[0-9a-fA-F]{40}$/, {
    message: 'walletAddress must be 0x followed by 40 hex characters',
  })
  readonly walletAddress?: string;
}

/** A user as the API returns it. */
export interface UserView {
  /** The user id. */
  readonly id: string;
  /** The wallet, lowercase. */
  readonly walletAddress: string;
  /** When the user was created (ISO 8601, UTC). */
  readonly createdAt: string;
}

/** Schema of `UserView`. */
export class UserDto {
  /** The user id. */
  @ApiProperty({ format: 'uuid', example: '3f1c2a4e-8b7d-4c1e-9a2f-6d5e4c3b2a10' })
  readonly id?: string;

  /** The wallet. */
  @ApiProperty({ example: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' })
  readonly walletAddress?: string;

  /** Creation time. */
  @ApiProperty({ format: 'date-time', example: '2026-11-23T12:00:00.000Z' })
  readonly createdAt?: string;
}

function isWalletTaken(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  return String(target).includes('wallet_address') || String(target).includes('walletAddress');
}

/** Creates and reads users. */
@Injectable()
export class UsersService {
  /** @param prisma The database. */
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /**
   * Creates a user and their three ledger accounts in one transaction; registering a wallet
   * that already has a user returns that user (`replayed: true`, nothing written).
   *
   * WHY a replay and not a 409: the request body is the wallet and nothing else, so a second
   * registration of the same wallet IS the same request (a client retrying a timed-out POST),
   * and answering it with the stored user makes the route safe to retry without an
   * Idempotency-Key. Should the body ever gain fields, a registration whose other fields differ
   * from the stored user must become a 409 instead.
   *
   * @param walletAddress The wallet (validated by the DTO).
   */
  async create(walletAddress: string): Promise<{ view: UserView; replayed: boolean }> {
    const wallet = walletAddress.toLowerCase();
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const u = await tx.user.create({ data: { walletAddress: wallet } });
        await tx.account.createMany({
          data: (['user_available', 'user_held', 'user_incoming'] as const).map((kind) => ({
            kind,
            userId: u.id,
          })),
        });
        return u;
      });
      return { view: toView(user), replayed: false };
    } catch (err) {
      // The unique wallet index (also the race of two concurrent registrations): the stored user.
      if (!isWalletTaken(err)) throw err;
      const existing = await this.prisma.user.findUniqueOrThrow({
        where: { walletAddress: wallet },
      });
      return { view: toView(existing), replayed: true };
    }
  }

  /**
   * One user, or `USER_NOT_FOUND`.
   *
   * @param id The user id.
   */
  async get(id: string): Promise<UserView> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (user === null) throw new ApiProblem('USER_NOT_FOUND');
    return toView(user);
  }
}

function toView(u: { id: string; walletAddress: string; createdAt: Date }): UserView {
  return { id: u.id, walletAddress: u.walletAddress, createdAt: u.createdAt.toISOString() };
}

/** `/v1/users`. Platform token only. */
@ApiTags('users')
@ApiBearerAuth(PLATFORM_AUTH)
@Access('platform')
@Controller('v1/users')
export class UsersController {
  /** @param users The service. */
  constructor(private readonly users: UsersService) {}

  /** Creates a user, or returns the one that already holds the wallet. */
  @Post()
  @ApiOperation({
    summary: 'Create a user with their wallet (and their three ledger accounts)',
    description:
      'Registering a wallet that already has a user returns that user with 200 and Idempotent-Replayed: true (nothing written), so the call is safe to retry.',
  })
  @ApiCreatedResponse({ type: UserDto, description: 'New user.' })
  @ApiOkResponse({ type: UserDto, description: 'The wallet was already registered: its user.' })
  @ApiProblems('VALIDATION_FAILED', 'MALFORMED_JSON', 'UNAUTHENTICATED', 'FORBIDDEN')
  async create(
    @Body() body: CreateUserDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserView> {
    const { view, replayed } = await this.users.create(String(body.walletAddress));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return view;
  }

  /** Reads a user. */
  @Get(':userId')
  @ApiOperation({ summary: 'Read a user' })
  @ApiOkResponse({ type: UserDto })
  @ApiProblems('VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'USER_NOT_FOUND')
  get(@Param('userId', uuidParam('userId')) userId: string): Promise<UserView> {
    return this.users.get(userId);
  }
}

/** The users feature. */
@Module({ controllers: [UsersController], providers: [UsersService], exports: [UsersService] })
export class UsersModule {}
