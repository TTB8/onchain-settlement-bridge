/**
 * @file `pnpm demo [--rogue]`: the bridge end to end through its public HTTP API, on the local
 * stack. Needs `pnpm setup:local` done and `pnpm dev` running (API + worker) in another terminal.
 *
 * Creates two users with Anvil dev wallets, allows both (admin route), runs deposit -> transfer ->
 * withdrawal waiting for each to be `confirmed` (statuses and transaction hashes printed), prints
 * the ledger balances next to the on-chain balances, and runs a reconciliation
 * (`CLEAN: 0 mismatches`, or the mismatches). With `--rogue` the dev minter then mints directly on
 * the token, outside the bridge, and the reconciler reports it. Steps: `scripts/lib/demo.ts`.
 *
 * Reads `.env` (API_HOST / API_PORT, both API tokens, RPC_URL, CHAIN_ID, TOKEN_ADDRESS); prints no
 * token and no key. Refuses anything but a local chain 31337 (it sends from Anvil's dev minter).
 * Exit code 0 only for a clean run (and, with --rogue, a caught rogue mint); 1 otherwise.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runDemo } from './lib/demo';
import { parseEnvFile, targetProblems } from './lib/local-env';
import { Rpc } from './lib/rpc';

const USAGE = `usage: pnpm demo [--rogue]

  needs: pnpm setup:local done, and pnpm dev running in another terminal
  --rogue  afterwards, mint directly on the token (outside the bridge) and show the reconciler
           catching it. The local chain then stays out of line with the ledger; reset with
           docker compose restart anvil && pnpm setup:local --reset-db`;

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const unknown = args.filter((a) => a !== '--rogue');
  if (unknown.length > 0) {
    console.error(`demo: unknown argument ${JSON.stringify(unknown[0]?.slice(0, 40))}\n${USAGE}`);
    return 2;
  }
  const envPath = resolve(__dirname, '..', '.env');
  if (!existsSync(envPath)) {
    console.error('demo: no .env. Run  pnpm setup:local  first.');
    return 1;
  }
  const env = parseEnvFile(readFileSync(envPath, 'utf8'));
  const rpc = new Rpc(env.RPC_URL ?? '');
  let nodeChainId: number;
  try {
    nodeChainId = await rpc.chainId();
  } catch {
    console.error(
      'demo: the node does not answer (RPC_URL). Start the stack:  docker compose up -d',
    );
    return 1;
  }
  const problems = targetProblems({
    nodeChainId,
    envChainId: env.CHAIN_ID,
    rpcUrl: env.RPC_URL,
    databaseUrl: env.DATABASE_URL,
  }).map((p) => p.replace(/setup:local/g, 'the demo'));
  if (problems.length > 0) {
    console.error(`demo: refusing:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    return 1;
  }
  const host = !env.API_HOST || env.API_HOST === '0.0.0.0' ? '127.0.0.1' : env.API_HOST;
  return runDemo({
    apiUrl: `http://${host}:${env.API_PORT || '3000'}`,
    platformToken: env.API_PLATFORM_TOKEN ?? '',
    adminToken: env.API_ADMIN_TOKEN ?? '',
    rpc,
    tokenAddress: env.TOKEN_ADDRESS ?? '',
    rogue: args.includes('--rogue'),
    timeoutMs: 60_000,
    pollMs: 500,
    runId: `${new Date()
      .toISOString()
      .replace(/[^0-9]/g, '')
      .slice(0, 14)}-${randomBytes(3).toString('hex')}`,
    log: (line) => console.log(line),
  });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error(`demo: failed: ${e.name}: ${e.message.split('\n')[0]?.slice(0, 300)}`);
    process.exitCode = 1;
  },
);
