/**
 * @file A user's balances, DERIVED from the ledger on every read (never stored, ADR 0001).
 *
 * `readBalances` sums the postings of the user's three accounts (the `account_balance` view):
 *
 * - `available`: spendable now (withdrawals and transfers reserve against it);
 * - `held`: reserved by a pending withdrawal or outgoing transfer, still on chain;
 * - `incoming`: reserved by a pending deposit, NOT yet minted (a transfer credits its recipient
 *   only at settlement, straight into `available`);
 * - `expectedOnChain` = `available + held`: what the user's wallet must hold once every pending
 *   operation is settled or reversed. Incoming money is excluded because it has not been minted
 *   or moved yet; held money is included because it has not been burned or moved yet. This is
 *   the figure the reconciler compares with the token's balance at the final block.
 *
 * A read outside any lock is fine here: it is a report, never the input of a money decision (the
 * engine re-reads under the row lock for that).
 */

import { Controller, Get, Inject, Injectable, Module, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { type PrismaClient, readBalances } from '@bridge/db';

import { Access } from '../auth/auth';
import { formatAmount, TOKEN_DECIMALS } from '../core/amount';
import { ApiProblems, PLATFORM_AUTH } from '../core/openapi';
import { uuidParam } from '../core/params';
import { ApiProblem } from '../core/problem';
import { PRISMA } from '../core/tokens';

/** Balances as the API returns them (decimal strings, smallest unit). */
export interface BalancesView {
  /** The user. */
  readonly userId: string;
  /** Spendable. */
  readonly available: string;
  /** Reserved, still on chain. */
  readonly held: string;
  /** Reserved, not yet on chain. */
  readonly incoming: string;
  /** available + held. */
  readonly expectedOnChain: string;
  /** The token's decimals, so a client never has to guess the unit. */
  readonly decimals: number;
}

/** Schema of `BalancesView`. */
export class BalancesDto {
  /** User. */
  @ApiProperty({ format: 'uuid' }) readonly userId?: string;
  /** Available. */
  @ApiProperty({ example: '2500000', description: 'Spendable, smallest unit.' })
  readonly available?: string;
  /** Held. */
  @ApiProperty({ example: '500000', description: 'Reserved by pending withdrawals / transfers.' })
  readonly held?: string;
  /** Incoming. */
  @ApiProperty({ example: '1000000', description: 'Pending deposits (not yet minted).' })
  readonly incoming?: string;
  /** Expected on chain. */
  @ApiProperty({
    example: '3000000',
    description: 'available + held: the wallet balance once settled.',
  })
  readonly expectedOnChain?: string;
  /** Decimals. */
  @ApiProperty({ example: 6 }) readonly decimals?: number;
}

/**
 * The view from the three derived balances (pure, so the formula is tested on its own).
 *
 * @param userId The user.
 * @param b The balances.
 */
export function balancesView(
  userId: string,
  b: { available: bigint; held: bigint; incoming: bigint },
): BalancesView {
  return {
    userId,
    available: formatAmount(b.available),
    held: formatAmount(b.held),
    incoming: formatAmount(b.incoming),
    expectedOnChain: formatAmount(b.available + b.held),
    decimals: TOKEN_DECIMALS,
  };
}

/** Reads balances. */
@Injectable()
export class BalancesService {
  /** @param prisma The database. */
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /**
   * The user's balances, or `USER_NOT_FOUND`.
   *
   * @param userId The user.
   */
  async forUser(userId: string): Promise<BalancesView> {
    const rows = await readBalances(this.prisma, { userIds: [userId] });
    if (rows.length === 0) {
      // Every user has three accounts (created together), so no rows means no such user.
      throw new ApiProblem('USER_NOT_FOUND');
    }
    const of = (kind: 'user_available' | 'user_held' | 'user_incoming'): bigint =>
      rows.find((r) => r.kind === kind)?.balance ?? 0n;
    return balancesView(userId, {
      available: of('user_available'),
      held: of('user_held'),
      incoming: of('user_incoming'),
    });
  }
}

/** `/v1/users/:userId/balances`. Platform token only. */
@ApiTags('balances')
@ApiBearerAuth(PLATFORM_AUTH)
@Access('platform')
@Controller('v1/users/:userId/balances')
export class BalancesController {
  /** @param balances The service. */
  constructor(private readonly balances: BalancesService) {}

  /** Reads the balances. */
  @Get()
  @ApiOperation({ summary: "Read a user's balances (derived from the ledger on every read)" })
  @ApiOkResponse({ type: BalancesDto })
  @ApiProblems('VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'USER_NOT_FOUND')
  get(@Param('userId', uuidParam('userId')) userId: string): Promise<BalancesView> {
    return this.balances.forUser(userId);
  }
}

/** The balances feature. */
@Module({ controllers: [BalancesController], providers: [BalancesService] })
export class BalancesModule {}
