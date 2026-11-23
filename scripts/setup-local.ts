/**
 * @file `pnpm setup:local [--force] [--reset-db]`: everything between `docker compose up -d` and
 * `pnpm dev`, for a LOCAL Anvil and the docker-compose Postgres only.
 *
 * Migrates the dev database, builds and deploys the contracts with `contracts/script/Deploy.s.sol`,
 * promotes the deployment with `contracts/script/promote-deployment.sh`, registers the ACTIVE
 * deployment and its two signer rows, and writes a git-ignored `.env` from `.env.example` with
 * TOKEN_ADDRESS / REGISTRY_ADDRESS filled. The steps and every refusal are documented in
 * `scripts/lib/setup.ts`; the quickstart is `docs/local-development.md`.
 *
 * Safe to re-run: on the same chain and database it reuses the deployment and leaves `.env` alone.
 *
 *   --force     replace a `.env` that points at another deployment (the old one goes to `.env.bak`)
 *   --reset-db  drop and recreate the dev database first (after restarting Anvil: a fresh chain)
 *
 * Exit codes: 0 done, 1 refused or failed, 2 a flag is needed (the message says which).
 * Refuses any chain but 31337 and any RPC or database URL not on this machine. Never prints a
 * value from `.env` (no token, no key, no password): only host:port, database names and addresses.
 *
 * Run through the root script (`pnpm setup:local`): it is TypeScript, started with ts-node from
 * the `@bridge/e2e` workspace package, which also holds its tests.
 */

import { resolve } from 'node:path';

import { parseSetupFlags } from './lib/local-env';
import { RpcError, runSetupLocal, SetupRefusal } from './lib/setup';

const USAGE = `usage: pnpm setup:local [--force] [--reset-db]

  --force     replace a .env that points at another deployment (backed up to .env.bak)
  --reset-db  drop and recreate the dev database first (use after restarting Anvil)`;

async function main(): Promise<number> {
  const flags = parseSetupFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  const repoRoot = resolve(__dirname, '..');
  const result = await runSetupLocal({
    repoRoot,
    flags,
    checkGitIgnore: true,
    log: (line) => console.log(`setup:local: ${line}`),
  });
  console.log(
    `setup:local: done. ${result.deployed ? 'Deployed' : 'Reused'} token ${result.token}, registry ${result.registry}.`,
  );
  console.log('');
  console.log('Next:');
  console.log('  pnpm dev     # API on http://127.0.0.1:3000 (Swagger at /docs) + the worker');
  console.log('  pnpm demo    # in a second terminal, once pnpm dev is up');
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof SetupRefusal) {
      console.error(`setup:local: ${err.message}`);
      process.exitCode = err.exitCode;
    } else if (err instanceof RpcError) {
      console.error(`setup:local: the node failed: ${err.message}`);
      process.exitCode = 1;
    } else {
      // Prisma and other errors: the class and the first line only (no URL, no stack).
      const e = err instanceof Error ? err : new Error(String(err));
      const first = (e.message.split('\n').find((l) => l.trim() !== '') ?? '').replace(
        /[a-z]+:\/\/\S+/gi,
        '<redacted-url>',
      );
      console.error(`setup:local: failed: ${e.name}: ${first.slice(0, 300)}`);
      process.exitCode = 1;
    }
  },
);
