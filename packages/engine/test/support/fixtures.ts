/**
 * Fixtures for the engine tests: deployments, users with their three accounts, a controllable clock
 * and id source, and helpers to read back exactly what the engine wrote.
 *
 * Expected postings in the tests are written out by hand (the posting table of @bridge/domain
 * ledger.ts), never derived from the code under test.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { type PrismaClient, readBalances } from '@bridge/db';

import {
  type Clock,
  type IdSource,
  OperationService,
  type OperationServiceOptions,
} from '../../src';

/** Random lowercase 0x hex of `bytes` bytes. */
export const hex = (bytes: number): `0x${string}` => `0x${randomBytes(bytes).toString('hex')}`;

/** A deployment row. */
export interface TestDeployment {
  id: string;
  chainId: bigint;
  token: string;
  registry: string;
}

/** Inserts a deployment (active by default) on a random chain unless one is given. */
export async function insertDeployment(
  prisma: PrismaClient,
  opts: { active?: boolean; chainId?: bigint } = {},
): Promise<TestDeployment> {
  const chainId = opts.chainId ?? BigInt(100_000 + Math.floor(Math.random() * 1e9));
  const d = await prisma.deployment.create({
    data: {
      chainId,
      tokenAddress: hex(20),
      registryAddress: hex(20),
      deploymentBlock: 1n,
      active: opts.active ?? true,
    },
  });
  return { id: d.id, chainId, token: d.tokenAddress, registry: d.registryAddress };
}

/** A user with its three ledger accounts. */
export interface TestUser {
  id: string;
  wallet: string;
  available: string;
  held: string;
  incoming: string;
}

/** Inserts a verified user with available, held and incoming accounts. */
export async function insertUser(prisma: PrismaClient): Promise<TestUser> {
  const u = await prisma.user.create({ data: { walletAddress: hex(20), verified: true } });
  const make = async (kind: 'user_available' | 'user_held' | 'user_incoming') =>
    (await prisma.account.create({ data: { kind, userId: u.id } })).id;
  return {
    id: u.id,
    wallet: u.walletAddress,
    available: await make('user_available'),
    held: await make('user_held'),
    incoming: await make('user_incoming'),
  };
}

/** A clock that only moves when told to. */
export class FakeClock implements Clock {
  private t: number;
  /** @param start The initial instant. */
  constructor(start = Date.UTC(2026, 10, 23, 12, 0, 0)) {
    this.t = start;
  }
  /** The current fake time. */
  now(): Date {
    return new Date(this.t);
  }
  /** Moves time forward. */
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Random UUIDs, recording each one handed out. */
export class RecordingIds implements IdSource {
  readonly issued: string[] = [];
  /** A new UUID. */
  uuid(): string {
    const id = randomUUID();
    this.issued.push(id);
    return id;
  }
}

/** An operation service on `prisma` bound to deployment `d`. */
export function serviceFor(
  prisma: PrismaClient,
  d: TestDeployment,
  extra: Partial<OperationServiceOptions> = {},
): OperationService {
  return new OperationService({
    prisma,
    clock: new FakeClock(),
    ids: new RecordingIds(),
    chainId: d.chainId,
    tokenAddress: d.token,
    ...extra,
  });
}

/** The derived balance of one account. */
export async function balanceOf(prisma: PrismaClient, accountId: string): Promise<bigint> {
  const [row] = await readBalances(prisma, { accountIds: [accountId] });
  return row?.balance ?? 0n;
}

/** Row counts per table. */
export interface Counts {
  operation: number;
  journalEntry: number;
  posting: number;
  outbox: number;
  audit: number;
}

/** Row counts of every table a request writes. */
export async function counts(prisma: PrismaClient): Promise<Counts> {
  const [operation, journalEntry, posting, outbox, audit] = await Promise.all([
    prisma.operation.count(),
    prisma.journalEntry.count(),
    prisma.posting.count(),
    prisma.outboxMessage.count(),
    prisma.auditLog.count(),
  ]);
  return { operation, journalEntry, posting, outbox, audit };
}

/** The postings of one operation's entry of `kind`, as sorted `account:side:amount` strings. */
export async function postingsOf(
  prisma: PrismaClient,
  operationId: string,
  kind: 'reserve' | 'settle' | 'reverse',
): Promise<string[]> {
  const entry = await prisma.journalEntry.findUniqueOrThrow({
    where: { operationId_kind: { operationId, kind } },
    include: { postings: true },
  });
  return entry.postings.map((p) => `${p.accountId}:${p.side}:${p.amount}`).sort();
}

/** `account:side:amount`, for building expected postings. */
export const line = (account: string, side: 'debit' | 'credit', amount: bigint): string =>
  `${account}:${side}:${amount}`;

/**
 * Gives `user` `amount` of available balance the way production does: a deposit, then SUBMIT and
 * CONFIRM through the service (the settle entry moves incoming to available).
 */
export async function fund(
  service: OperationService,
  user: TestUser,
  amount: bigint,
): Promise<void> {
  const { operation } = await service.requestDeposit(user.id, amount, `fund-${randomUUID()}`);
  const submitted = await service.move({
    operationId: operation.id,
    from: 'ledger_reserved',
    version: operation.version,
    move: { event: 'SUBMIT', kind: 'first' },
    at: new Date(),
    note: 'test funding',
  });
  await service.move({
    operationId: operation.id,
    from: 'submitted',
    version: submitted.version,
    move: {
      event: 'CONFIRM',
      judgement: { verdict: 'confirm', event: 'CONFIRM' },
      confirmedBlock: 10n,
    },
    at: new Date(),
    note: 'test funding',
  });
}
