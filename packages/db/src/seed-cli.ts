/**
 * @file `pnpm db:seed`: runs `ensureFiatClearingAccount` against `DATABASE_URL`. Idempotent and
 * non-destructive: it only ever inserts the one system account if it is missing.
 */

import { createPrismaClient } from './client';
import { ensureFiatClearingAccount } from './seed';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set (see packages/db/.env.example)');
  }
  const prisma = createPrismaClient(url);
  try {
    const id = await ensureFiatClearingAccount(prisma);
    console.log(`fiat_clearing account: ${id}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
