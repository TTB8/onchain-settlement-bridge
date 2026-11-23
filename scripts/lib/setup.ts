/**
 * @file `pnpm setup:local`, the steps: from a running docker-compose stack (Postgres + Anvil) to a
 * deployed, promoted, registered bridge and a `.env` that `pnpm dev` accepts. Idempotent: a re-run
 * on the same chain and database changes nothing (it reuses the registered deployment).
 *
 * 1. Read `.env` if it exists, else `.env.example` (DATABASE_URL, RPC_URL, CHAIN_ID,
 *    CONFIRMATION_DEPTH).
 * 2. Postgres and the node must answer (else: "docker compose up -d"); the node must be chain
 *    31337 and both URLs must be on this machine; the dev accounts must be unlocked on the node.
 * 3. The dev database: dropped first with `--reset-db`, created when missing, migrated
 *    (`prisma migrate deploy` of packages/db), seeded (`ensureFiatClearingAccount`).
 * 4. `forge build`.
 * 5. An ACTIVE deployment already registered for the chain is reused if it is still on this
 *    chain (contracts have code, the newest indexed block's hash matches the node); if it is not
 *    (Anvil was restarted), setup refuses and asks for `--reset-db`.
 * 6. Otherwise: `forge script script/Deploy.s.sol --broadcast` (deployer = dev account #0,
 *    unlocked on Anvil), mine `CONFIRMATION_DEPTH + 1` blocks (`anvil_mine`) so the record is deep
 *    enough, then `contracts/script/promote-deployment.sh` checks the record against the chain and
 *    writes `deployments/31337.json` (`PROMOTE_REPLACE=1` when an older local record exists).
 * 7. One transaction: the ACTIVE `deployment` row (chain id from the node, addresses and
 *    deployment block from the VERIFIED record) and its two `signer_state` rows.
 * 8. `.env` from `.env.example` with TOKEN_ADDRESS / REGISTRY_ADDRESS filled, only if git ignores
 *    it; an existing `.env` for another deployment is replaced only with `--force` (backed up to
 *    `.env.bak`). No value from `.env` is ever printed (only host:port and database names).
 *
 * Every refusal is a `SetupRefusal` with one message saying what to do; nothing after the failed
 * step runs.
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { delimiter, join, relative, resolve } from 'node:path';

import { createPrismaClient, ensureFiatClearingAccount, type PrismaClient } from '@bridge/db';

import {
  assertEnvIgnored,
  databaseNameOf,
  DEV_ROLE_ADDRESSES,
  deployEnv,
  endpointOf,
  LOCAL_CHAIN_ID,
  maintenanceUrlOf,
  parseEnvFile,
  planEnvWrite,
  readDeploymentRecord,
  renderEnv,
  SetupRefusal,
  type SetupFlags,
  targetProblems,
} from './local-env';
import { Rpc, RpcError } from './rpc';

/** Where setup reads and writes; the CLI uses the repository defaults, tests use temp paths. */
export interface SetupOptions {
  /** The repository root (contracts/, packages/db/). */
  readonly repoRoot: string;
  /** The `.env` to write (default `<root>/.env`). */
  readonly envPath?: string;
  /** The template (default `<root>/.env.example`). */
  readonly templatePath?: string;
  /** Where the promoted record lives (default `<root>/contracts/deployments`). */
  readonly deploymentsDir?: string;
  /** The command-line flags. */
  readonly flags: SetupFlags;
  /** Check with git that `.env` is ignored (the CLI always does; a temp path is not in a repo). */
  readonly checkGitIgnore?: boolean;
  /** Where progress lines go. */
  readonly log: (line: string) => void;
}

/** What a successful run did. */
export interface SetupResult {
  /** The registered deployment. */
  readonly deploymentId: string;
  /** Token address, lowercase. */
  readonly token: string;
  /** Registry address, lowercase. */
  readonly registry: string;
  /** Whether contracts were deployed by this run (false = reused). */
  readonly deployed: boolean;
  /** What happened to `.env`. */
  readonly env: 'create' | 'unchanged' | 'overwrite';
}

/** PATH with Foundry's default install folder appended (forge / cast may live only there). */
function toolPath(): string {
  return [process.env.PATH ?? '', join(homedir(), '.foundry', 'bin')].join(delimiter);
}

/** Runs a tool, returns its output; a non-zero exit is a refusal with the output's tail. */
function run(
  label: string,
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string | undefined>; timeoutMs?: number },
): string {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, PATH: toolPath(), ...opts.env },
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 300_000,
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.error !== undefined || res.status !== 0) {
    const why = res.error ? res.error.message : `exit ${String(res.status)}`;
    const tail = out.trim().split('\n').slice(-15).join('\n    ');
    throw new SetupRefusal(`${label} failed (${why})${tail ? `:\n    ${tail}` : ''}`);
  }
  return out;
}

function tcpReachable(host: string, port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (ok: boolean) => {
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** Runs `fn` with a Prisma client, always disconnecting. */
async function withPrisma<T>(url: string, fn: (p: PrismaClient) => Promise<T>): Promise<T> {
  const prisma = createPrismaClient(url);
  try {
    return await fn(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

/** Creates the dev database when missing; with `reset`, drops it first. */
async function prepareDatabase(
  databaseUrl: string,
  reset: boolean,
  log: (l: string) => void,
): Promise<void> {
  const name = databaseNameOf(databaseUrl);
  await withPrisma(maintenanceUrlOf(databaseUrl), async (admin) => {
    if (reset) {
      // The name was validated as a plain identifier; it is quoted, never interpolated raw.
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      log(`  dropped database ${name} (--reset-db)`);
    }
    const rows = await admin.$queryRaw<{ n: number }[]>`
      SELECT 1 AS n FROM pg_database WHERE datname = ${name}`;
    if (rows.length === 0) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
      log(`  created database ${name}`);
    } else {
      log(`  database ${name} exists`);
    }
  });
}

/** What to do about the chain's ACTIVE deployment row. */
type Existing =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'reuse';
      readonly id: string;
      readonly token: string;
      readonly registry: string;
    }
  | { readonly kind: 'stale'; readonly why: string };

/**
 * Whether the registered deployment is still the one on this chain. A restarted Anvil is a fresh
 * chain: the contracts are gone, or (same deployer nonces) back at the same addresses with no
 * history, so the newest indexed block's hash no longer matches the node.
 */
async function assessExisting(prisma: PrismaClient, rpc: Rpc, chainId: number): Promise<Existing> {
  const row = await prisma.deployment.findFirst({
    where: { chainId: BigInt(chainId), active: true },
    include: { signerStates: true },
  });
  if (row === null) return { kind: 'none' };
  const token = row.tokenAddress.toLowerCase();
  const registry = row.registryAddress.toLowerCase();
  if (!(await rpc.hasCode(token)) || !(await rpc.hasCode(registry))) {
    return { kind: 'stale', why: 'its contracts have no code on this chain' };
  }
  const head = await rpc.blockNumber();
  if (row.deploymentBlock > head) {
    return { kind: 'stale', why: 'its deployment block is above the chain head' };
  }
  const newest = await prisma.indexedBlock.findFirst({
    where: { deploymentId: row.id },
    orderBy: { number: 'desc' },
  });
  if (newest !== null) {
    const hash = newest.number > head ? null : await rpc.blockHash(newest.number);
    if (hash !== newest.hash.toLowerCase()) {
      return { kind: 'stale', why: `block ${newest.number} it indexed is not on this chain` };
    }
  }
  for (const [signer, address] of [
    ['settlement', DEV_ROLE_ADDRESSES.settlement],
    ['compliance', DEV_ROLE_ADDRESSES.compliance],
  ] as const) {
    const recorded = row.signerStates.find((s) => s.signer === signer)?.address;
    if (recorded?.toLowerCase() !== address) {
      return { kind: 'stale', why: `its ${signer} signer is not the dev ${signer} account` };
    }
  }
  return { kind: 'reuse', id: row.id, token, registry };
}

/**
 * Runs the whole setup. Resolves with what it did, or rejects with a `SetupRefusal` (or an
 * unexpected error) after the step that failed.
 *
 * @param o Paths, flags and the log.
 */
export async function runSetupLocal(o: SetupOptions): Promise<SetupResult> {
  const log = o.log;
  const root = o.repoRoot;
  const envPath = o.envPath ?? join(root, '.env');
  const templatePath = o.templatePath ?? join(root, '.env.example');
  const contractsDir = join(root, 'contracts');
  const deploymentsDir = o.deploymentsDir ?? join(contractsDir, 'deployments');
  const dbPackageDir = join(root, 'packages', 'db');
  const shown = (p: string) => relative(root, p) || p;

  // 1. The environment setup works against.
  const template = readFileSync(templatePath, 'utf8');
  const envExists = existsSync(envPath);
  const source = parseEnvFile(envExists ? readFileSync(envPath, 'utf8') : template);
  log(`[1/8] settings from ${shown(envExists ? envPath : templatePath)}`);
  const databaseUrl = source.DATABASE_URL;
  const rpcUrl = source.RPC_URL;
  const depth = Number(source.CONFIRMATION_DEPTH ?? '1');
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 64) {
    throw new SetupRefusal(
      'CONFIRMATION_DEPTH must be a whole number from 1 to 64 for setup:local',
    );
  }

  // 2. The stack answers, and it is local.
  log('[2/8] checking the local stack');
  const problems: string[] = [];
  const db = endpointOf(databaseUrl, 5432);
  const node = endpointOf(rpcUrl, 8545);
  if (db === null) problems.push('DATABASE_URL is missing or not a URL (see .env.example)');
  else if (!(await tcpReachable(db.host, db.port))) {
    problems.push(`Postgres is not reachable at ${db.host}:${db.port}`);
  }
  let nodeChainId: number | null = null;
  const rpc = new Rpc(rpcUrl ?? '');
  if (node === null) problems.push('RPC_URL is missing or not a URL (see .env.example)');
  else {
    try {
      nodeChainId = await rpc.chainId();
    } catch {
      problems.push(`no JSON-RPC node answers at ${node.host}:${node.port}`);
    }
  }
  if (problems.length > 0) {
    throw new SetupRefusal(
      `the local stack is not up:\n${problems.map((p) => `  - ${p}`).join('\n')}\n` +
        'Start it from the repository root:  docker compose up -d   (then re-run pnpm setup:local)',
    );
  }
  const refusals = targetProblems({
    nodeChainId: nodeChainId as number,
    envChainId: source.CHAIN_ID,
    rpcUrl,
    databaseUrl,
  });
  if (refusals.length > 0) {
    throw new SetupRefusal(`refusing:\n${refusals.map((p) => `  - ${p}`).join('\n')}`);
  }
  const unlocked = new Set(await rpc.accounts());
  if (!Object.values(DEV_ROLE_ADDRESSES).every((a) => unlocked.has(a))) {
    throw new SetupRefusal(
      "the node does not hold Anvil's dev accounts #0-#3 unlocked (start it with the default mnemonic)",
    );
  }
  const dbName = databaseNameOf(databaseUrl as string);
  log(
    `  Postgres ${db?.host}:${db?.port} ok; node ${node?.host}:${node?.port} is chain ${nodeChainId}`,
  );

  // 3. Database: create, migrate, seed.
  log(`[3/8] database ${dbName}`);
  await prepareDatabase(databaseUrl as string, o.flags.resetDb, log);
  run(
    'prisma migrate deploy',
    join(dbPackageDir, 'node_modules', '.bin', 'prisma'),
    ['migrate', 'deploy'],
    {
      cwd: dbPackageDir,
      env: { DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    },
  );
  log('  migrations applied');

  return withPrisma(databaseUrl as string, async (prisma) => {
    await ensureFiatClearingAccount(prisma);

    // 4. Contracts.
    log('[4/8] building the contracts (forge build)');
    run('forge build', 'forge', ['build'], { cwd: contractsDir });

    // 5. Reuse what is registered, if it is still on this chain.
    log('[5/8] looking for a registered deployment');
    const existing = await assessExisting(prisma, rpc, LOCAL_CHAIN_ID);
    if (existing.kind === 'stale') {
      throw new SetupRefusal(
        `the database ${dbName} holds an ACTIVE deployment for chain ${LOCAL_CHAIN_ID}, but ${existing.why} ` +
          '(was Anvil restarted?). Its operations belong to that old chain. Start over with:\n' +
          '  pnpm setup:local --reset-db',
      );
    }
    let deploymentId: string;
    let token: string;
    let registry: string;
    let deployed = false;
    if (existing.kind === 'reuse') {
      ({ id: deploymentId, token, registry } = existing);
      log(`  reusing deployment ${deploymentId} (token ${token}, registry ${registry})`);
      log('[6/8] deploy skipped (already deployed and promoted)');
      log('[7/8] deployment row and signer rows already registered');
    } else {
      log('  none: deploying');
      // 6. Deploy, confirm, promote.
      log('[6/8] deploying with contracts/script/Deploy.s.sol, then promoting');
      mkdirSync(deploymentsDir, { recursive: true });
      const forgePending = join(contractsDir, 'deployments', `${LOCAL_CHAIN_ID}.pending.json`);
      const pending = join(deploymentsDir, `${LOCAL_CHAIN_ID}.pending.json`);
      if (resolve(forgePending) !== resolve(pending) && existsSync(forgePending)) {
        throw new SetupRefusal(
          `${shown(forgePending)} exists (another deploy in progress?); move it away and re-run`,
        );
      }
      const env: Record<string, string | undefined> = { ...deployEnv(), ADMIN_ADDRESS: undefined };
      run(
        'forge script Deploy.s.sol',
        'forge',
        [
          'script',
          'script/Deploy.s.sol',
          '--rpc-url',
          rpcUrl as string,
          '--sender',
          DEV_ROLE_ADDRESSES.deployer,
          '--unlocked',
          '--broadcast',
          '--slow',
        ],
        { cwd: contractsDir, env },
      );
      if (!existsSync(forgePending)) {
        throw new SetupRefusal('the deploy script wrote no pending deployment record');
      }
      if (resolve(forgePending) !== resolve(pending)) renameSync(forgePending, pending);
      // The record must be CONFIRMATION_DEPTH blocks deep, with no role change after the
      // confirmed block: an empty block more than the depth satisfies both on Anvil.
      await rpc.mine(depth + 1);
      const final = join(deploymentsDir, `${LOCAL_CHAIN_ID}.json`);
      const promoteOut = run(
        'promote-deployment.sh',
        'bash',
        [
          join(contractsDir, 'script', 'promote-deployment.sh'),
          String(LOCAL_CHAIN_ID),
          rpcUrl as string,
          String(depth),
        ],
        {
          cwd: contractsDir,
          env: {
            PROMOTE_DEPLOYMENTS_DIR: deploymentsDir,
            PROMOTE_REPLACE: existsSync(final) ? '1' : '0',
          },
        },
      );
      for (const line of promoteOut.trim().split('\n')) log(`  ${line}`);
      const record = readDeploymentRecord(readFileSync(final, 'utf8'), nodeChainId as number);
      token = record.token;
      registry = record.registry;
      deployed = true;

      // 7. Register it.
      log('[7/8] registering the deployment and its signers in the database');
      try {
        deploymentId = await prisma.$transaction(async (tx) => {
          const d = await tx.deployment.create({
            data: {
              chainId: BigInt(nodeChainId as number),
              tokenAddress: record.token,
              registryAddress: record.registry,
              deploymentBlock: record.deploymentBlock,
              active: true,
            },
          });
          await tx.signerState.createMany({
            data: [
              { deploymentId: d.id, signer: 'settlement', address: record.minter },
              { deploymentId: d.id, signer: 'compliance', address: record.compliance },
            ],
          });
          return d.id;
        });
      } catch {
        throw new SetupRefusal(
          `could not register the deployment in ${dbName} (an older row for these addresses?). ` +
            'Start over with:  pnpm setup:local --reset-db',
        );
      }
      log(`  deployment ${deploymentId}: token ${token}, registry ${registry}`);
    }

    // 8. .env
    log(`[8/8] ${shown(envPath)}`);
    if (o.checkGitIgnore !== false) {
      const ignored = spawnSync('git', ['check-ignore', '-q', envPath], { cwd: root });
      assertEnvIgnored(ignored.status);
    }
    const action = planEnvWrite(envExists ? source : null, { token, registry }, o.flags.force);
    if (action === 'unchanged') {
      log(`  ${shown(envPath)} already points at this deployment: left as it is`);
    } else {
      const content = renderEnv(template, { TOKEN_ADDRESS: token, REGISTRY_ADDRESS: registry });
      if (action === 'overwrite') {
        copyFileSync(envPath, `${envPath}.bak`);
        log(`  backed up the old file to ${shown(`${envPath}.bak`)}`);
      }
      const tmp = `${envPath}.tmp-${process.pid}`;
      writeFileSync(tmp, content, { mode: 0o600 });
      renameSync(tmp, envPath);
      log(
        `  wrote ${shown(envPath)} from ${shown(templatePath)} (TOKEN_ADDRESS, REGISTRY_ADDRESS filled)`,
      );
    }
    return { deploymentId, token, registry, deployed, env: action };
  });
}

/** Re-exported for the CLI's error handling. */
export { RpcError, SetupRefusal };
