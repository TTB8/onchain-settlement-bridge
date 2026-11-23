/**
 * Worker test support: a fresh Postgres database per test file (`bridge_worker_test_<hex>`,
 * migrated with the db package's `prisma migrate deploy`, only those are ever dropped), the fake
 * chain's deployment rows, an inspector for the fake's signed encoding, and a valid DEV-ONLY
 * environment for a local chain.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import {
  type Address,
  type ContractCall,
  type FakeChainGateway,
  type Hex,
  SIGNER_FOR_CALL,
} from '@bridge/chain';
import { createPrismaClient, ensureFiatClearingAccount, type PrismaClient } from '@bridge/db';
import type { DecodedTransaction, RawTransactionInspector } from '@bridge/engine';
import { hexToString } from 'viem';

const DEFAULT_ADMIN_URL = 'postgresql://bridge:bridge@localhost:5434/postgres';
const NAME = /^bridge_worker_test_[0-9a-f]{16}$/;
const DB_PACKAGE_DIR = resolve(__dirname, '..', '..', '..', '..', 'packages', 'db');

/** A migrated, seeded, throwaway database. */
export interface TestDatabase {
  readonly url: string;
  readonly prisma: PrismaClient;
  drop(): Promise<void>;
}

async function asAdmin(sql: string): Promise<void> {
  const c = createPrismaClient(process.env.DB_TEST_ADMIN_URL ?? DEFAULT_ADMIN_URL);
  try {
    await c.$executeRawUnsafe(sql);
  } finally {
    await c.$disconnect();
  }
}

/** Creates, migrates and seeds a fresh database. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `bridge_worker_test_${randomBytes(8).toString('hex')}`;
  await asAdmin(`CREATE DATABASE "${name}"`);
  const u = new URL(process.env.DB_TEST_ADMIN_URL ?? DEFAULT_ADMIN_URL);
  u.pathname = `/${name}`;
  const url = u.toString();
  const prisma = createPrismaClient(url);
  const drop = async () => {
    await prisma.$disconnect().catch(() => undefined);
    if (!NAME.test(name)) throw new Error(`refusing to drop ${name}`);
    await asAdmin(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  };
  try {
    execFileSync(resolve(DB_PACKAGE_DIR, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
      cwd: DB_PACKAGE_DIR,
      env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      stdio: 'pipe',
    });
    await ensureFiatClearingAccount(prisma);
    return { url, prisma, drop };
  } catch (err) {
    await drop();
    throw err;
  }
}

/** Inserts the active deployment row of `chain` and its signer rows (optionally other addresses). */
export async function registerDeployment(
  prisma: PrismaClient,
  chain: FakeChainGateway,
  signers: { settlement?: string; compliance?: string } = {},
): Promise<string> {
  const d = await prisma.deployment.create({
    data: {
      chainId: BigInt(chain.chainId),
      tokenAddress: chain.tokenAddress,
      registryAddress: chain.registryAddress,
      deploymentBlock: 0n,
      active: true,
    },
  });
  await prisma.signerState.createMany({
    data: [
      {
        deploymentId: d.id,
        signer: 'settlement',
        address: signers.settlement ?? chain.signerAddress('settlement'),
      },
      {
        deploymentId: d.id,
        signer: 'compliance',
        address: signers.compliance ?? chain.signerAddress('compliance'),
      },
    ],
  });
  return d.id;
}

/** Decodes the fake gateway's signed encoding (`fake-eip1559-tx:` + JSON, bigints as `"<n>n"`). */
export class FakeInspector implements RawTransactionInspector {
  constructor(private readonly chain: FakeChainGateway) {}

  async decode(raw: Hex): Promise<DecodedTransaction> {
    const text = hexToString(raw);
    const prefix = 'fake-eip1559-tx:';
    if (!text.startsWith(prefix)) throw new TypeError('not a fake signed transaction');
    const d = JSON.parse(text.slice(prefix.length), (_k, v: unknown) =>
      typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
    ) as {
      chainId: number;
      from: Address;
      nonce: number;
      call: ContractCall;
      fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    };
    const dep = this.chain.deployment();
    return {
      type: 'eip1559',
      chainId: d.chainId,
      nonce: d.nonce,
      to: SIGNER_FOR_CALL[d.call.kind] === 'settlement' ? dep.token : dep.registry,
      call: d.call,
      maxFeePerGas: d.fees.maxFeePerGas,
      maxPriorityFeePerGas: d.fees.maxPriorityFeePerGas,
      from: d.from,
      value: 0n,
      gas: null,
    };
  }
}

/** A valid worker environment for `chain` (local; DEV ONLY placeholder keys, never used to sign). */
export function workerEnv(chain: FakeChainGateway, url: string): Record<string, string> {
  return {
    DATABASE_URL: url,
    RPC_URL: 'http://127.0.0.1:8545/test-rpc-key',
    CHAIN_ID: String(chain.chainId),
    TOKEN_ADDRESS: chain.tokenAddress,
    REGISTRY_ADDRESS: chain.registryAddress,
    CONFIRMATION_DEPTH: '1',
    SETTLEMENT_SIGNER_KEY: `0x${'1'.repeat(64)}`,
    COMPLIANCE_SIGNER_KEY: `0x${'2'.repeat(64)}`,
    FEE_CAP_WEI: '1000000000000',
    WORKER_ID: 'worker-test',
    POLL_INTERVAL_MS: '100',
    SHUTDOWN_TIMEOUT_MS: '5000',
    LOG_LEVEL: 'debug',
  };
}
