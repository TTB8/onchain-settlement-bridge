/**
 * @file The pure parts of `pnpm setup:local`: what counts as a local target, the dev accounts and
 * their roles, reading the promoted deployment record, rendering `.env`, and deciding whether an
 * existing `.env` may be touched. No I/O here, so every refusal is unit-tested on its own
 * (`e2e/test/scripts.unit.test.ts`).
 *
 * DEV ONLY: the addresses below are Anvil's well-known development accounts (the public
 * "test test ... junk" mnemonic). They are addresses, not keys; the only keys in the repository are
 * the two labelled DEV ONLY values in `.env.example`, which the worker refuses on any real chain.
 */

import { parseEnv } from 'node:util';

/** The only chain this setup deploys to: a local Anvil (Deploy.s.sol relaxes its rules only here). */
export const LOCAL_CHAIN_ID = 31337;

/**
 * DEV ONLY: Anvil's default accounts #0-#3 and the role each plays in the local deployment. The
 * settlement and compliance addresses are those of `SETTLEMENT_SIGNER_KEY` and
 * `COMPLIANCE_SIGNER_KEY` in `.env.example` (the worker checks the match at startup).
 */
export const DEV_ROLE_ADDRESSES = {
  /** #0: sends the deployment and stays the admin of both contracts (Anvil only). */
  deployer: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  /** #1: the settlement signer, MINTER_ROLE and SETTLER_ROLE on the token. */
  settlement: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  /** #2: the compliance signer, COMPLIANCE_ROLE on the registry. */
  compliance: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
  /** #3: PAUSER_ROLE on the token (held by nobody else). */
  pauser: '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
} as const;

/** The environment variables Deploy.s.sol reads, for the local roles above. */
export function deployEnv(): Record<string, string> {
  return {
    COMPLIANCE_ADDRESS: DEV_ROLE_ADDRESSES.compliance,
    MINTER_ADDRESS: DEV_ROLE_ADDRESSES.settlement,
    SETTLER_ADDRESS: DEV_ROLE_ADDRESSES.settlement,
    PAUSER_ADDRESS: DEV_ROLE_ADDRESSES.pauser,
    TOKEN_NAME: 'Settlement Token',
    TOKEN_SYMBOL: 'STK',
    ALLOW_MAINNET: 'false',
    ALLOW_UNKNOWN_CHAIN: 'false',
    ALLOW_EOA_ADMIN: 'false',
    HOLDER_TRANSFERS_ENABLED: 'false',
  };
}

/** A refusal: setup stops with this message and changes nothing more. */
export class SetupRefusal extends Error {
  /**
   * @param message What is wrong and what to do (never a secret).
   * @param exitCode The process exit code (1 refused, 2 needs a flag from the user).
   */
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'SetupRefusal';
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Host and port of a URL, or null when it does not parse. The value itself is never returned.
 *
 * @param value The URL.
 * @param defaultPort Used when the URL has none.
 */
export function endpointOf(
  value: string | undefined,
  defaultPort: number,
): { host: string; port: number } | null {
  try {
    const u = new URL(value ?? '');
    if (u.hostname === '') return null;
    return { host: u.hostname, port: Number(u.port || defaultPort) };
  } catch {
    return null;
  }
}

/**
 * Whether a URL points at this machine.
 *
 * @param value The URL.
 */
export function isLoopbackUrl(value: string | undefined): boolean {
  const e = endpointOf(value, 0);
  return e !== null && LOOPBACK.has(e.host);
}

/** The database a `postgresql://` URL names, validated so it can be quoted as an identifier. */
export function databaseNameOf(databaseUrl: string): string {
  let name: string;
  try {
    name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  } catch {
    throw new SetupRefusal('DATABASE_URL is not a URL (see .env.example)');
  }
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new SetupRefusal(
      'DATABASE_URL must name a database of lowercase letters, digits and underscores',
    );
  }
  if (name === 'postgres' || name.startsWith('template')) {
    throw new SetupRefusal('DATABASE_URL must name the bridge database, not a system database');
  }
  return name;
}

/**
 * The same server, connected to the `postgres` maintenance database (to create or drop the dev
 * database).
 *
 * @param databaseUrl The dev database URL.
 */
export function maintenanceUrlOf(databaseUrl: string): string {
  const u = new URL(databaseUrl);
  u.pathname = '/postgres';
  return u.toString();
}

/**
 * Refusals before anything is touched: the RPC and the database must be on this machine, and the
 * node and `.env` must both say chain 31337. Returns every problem at once (empty = go).
 *
 * @param target What the node reported and what the environment says.
 */
export function targetProblems(target: {
  readonly nodeChainId: number;
  readonly envChainId: string | undefined;
  readonly rpcUrl: string | undefined;
  readonly databaseUrl: string | undefined;
}): string[] {
  const problems: string[] = [];
  if (target.nodeChainId !== LOCAL_CHAIN_ID) {
    problems.push(
      `the node reports chain id ${target.nodeChainId}; setup:local only deploys to a local Anvil (${LOCAL_CHAIN_ID})`,
    );
  }
  if (target.envChainId !== String(LOCAL_CHAIN_ID)) {
    problems.push(`CHAIN_ID must be ${LOCAL_CHAIN_ID} for setup:local`);
  }
  if (!isLoopbackUrl(target.rpcUrl)) {
    problems.push('RPC_URL must point at this machine (localhost / 127.0.0.1) for setup:local');
  }
  if (!isLoopbackUrl(target.databaseUrl)) {
    problems.push(
      'DATABASE_URL must point at this machine (localhost / 127.0.0.1) for setup:local',
    );
  }
  return problems;
}

/** The fields of a promoted deployment record (`contracts/deployments/31337.json`) setup uses. */
export interface DeploymentRecord {
  /** The chain. */
  readonly chainId: number;
  /** The head when the deploy script started (where the indexer may begin). */
  readonly deploymentBlock: bigint;
  /** The registry, lowercase. */
  readonly registry: string;
  /** The token, lowercase. */
  readonly token: string;
  /** MINTER_ROLE holder, lowercase. */
  readonly minter: string;
  /** SETTLER_ROLE holder, lowercase. */
  readonly settler: string;
  /** COMPLIANCE_ROLE holder, lowercase. */
  readonly compliance: string;
  /** The block promote-deployment.sh verified it at. */
  readonly verifiedAtBlock: bigint;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Reads the promoted record. Fails closed: a missing or malformed field is a refusal, never a
 * default; the record must be the verified one (it has `verifiedAtBlock`), and its roles must be
 * the local dev roles above (one settlement signer holding minter and settler).
 *
 * @param json The file's text.
 * @param expectedChainId The node's chain id.
 */
export function readDeploymentRecord(json: string, expectedChainId: number): DeploymentRecord {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new SetupRefusal('the deployment record is not valid JSON');
  }
  if (d === null || typeof d !== 'object' || Array.isArray(d)) {
    throw new SetupRefusal('the deployment record is not a JSON object');
  }
  const address = (key: string): string => {
    const v = d[key];
    if (typeof v !== 'string' || !ADDRESS.test(v)) {
      throw new SetupRefusal(`the deployment record field ${key} is missing or not an address`);
    }
    return v.toLowerCase();
  };
  const integer = (key: string): bigint => {
    const v = d[key];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
      throw new SetupRefusal(`the deployment record field ${key} is missing or not a block number`);
    }
    return BigInt(v);
  };
  const record: DeploymentRecord = {
    chainId: Number(integer('chainId')),
    deploymentBlock: integer('deploymentBlock'),
    verifiedAtBlock: integer('verifiedAtBlock'),
    registry: address('complianceRegistry'),
    token: address('settlementToken'),
    minter: address('minter'),
    settler: address('settler'),
    compliance: address('compliance'),
  };
  if (record.chainId !== expectedChainId) {
    throw new SetupRefusal(
      `the deployment record is for chain ${record.chainId}, the node is chain ${expectedChainId}`,
    );
  }
  if (record.registry === record.token) {
    throw new SetupRefusal('the deployment record has the same address for registry and token');
  }
  if (
    record.minter !== DEV_ROLE_ADDRESSES.settlement ||
    record.settler !== DEV_ROLE_ADDRESSES.settlement ||
    record.compliance !== DEV_ROLE_ADDRESSES.compliance
  ) {
    throw new SetupRefusal(
      'the deployment record does not give the minter, settler and compliance roles to the dev signers of .env.example',
    );
  }
  return record;
}

/**
 * Parses a dotenv file (Node's own parser).
 *
 * @param text The file's text.
 */
export function parseEnvFile(text: string): Record<string, string> {
  return parseEnv(text) as Record<string, string>;
}

/**
 * `.env` from the template: each `KEY=...` line of `values` replaced in place, every comment and
 * other line kept. A key the template does not have is an error (the template is the contract).
 *
 * @param template The text of `.env.example`.
 * @param values The variables to set.
 */
export function renderEnv(template: string, values: Readonly<Record<string, string>>): string {
  const seen = new Set<string>();
  const lines = template.split('\n').map((line) => {
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    const key = m?.[1];
    if (key === undefined || !(key in values)) return line;
    if (seen.has(key)) throw new Error(`renderEnv: ${key} appears twice in the template`);
    seen.add(key);
    const value = values[key] as string;
    if (/[\s#"'\\]/.test(value))
      throw new Error(`renderEnv: ${key} has characters .env cannot hold`);
    return `${key}=${value}`;
  });
  const missing = Object.keys(values).filter((k) => !seen.has(k));
  if (missing.length > 0) {
    throw new Error(`renderEnv: the template has no line for ${missing.join(', ')}`);
  }
  return lines.join('\n');
}

/** What to do with `.env`. */
export type EnvAction = 'create' | 'unchanged' | 'overwrite';

/**
 * Whether `.env` may be written. A missing file is created; an existing one that already points at
 * the deployment is left alone; one that points elsewhere is only replaced with `--force` (it is
 * backed up first), otherwise this refuses with exit code 2.
 *
 * @param existing The existing file's variables, or null when there is none.
 * @param deployment The deployment `.env` must point at.
 * @param force `--force` was given.
 */
export function planEnvWrite(
  existing: Readonly<Record<string, string>> | null,
  deployment: { readonly token: string; readonly registry: string },
  force: boolean,
): EnvAction {
  if (existing === null) return 'create';
  const same =
    (existing.TOKEN_ADDRESS ?? '').toLowerCase() === deployment.token.toLowerCase() &&
    (existing.REGISTRY_ADDRESS ?? '').toLowerCase() === deployment.registry.toLowerCase();
  if (same) return 'unchanged';
  if (force) return 'overwrite';
  throw new SetupRefusal(
    '.env exists and points at another deployment (TOKEN_ADDRESS / REGISTRY_ADDRESS differ). ' +
      'Re-run with --force to back it up to .env.bak and write a fresh one from .env.example.',
    2,
  );
}

/**
 * The `.env` file must be ignored by git before anything is written to it: it holds the API
 * tokens and the (dev) signer keys.
 *
 * @param checkIgnoreExitCode The exit code of `git check-ignore -q <path>` (0 = ignored).
 */
export function assertEnvIgnored(checkIgnoreExitCode: number | null): void {
  if (checkIgnoreExitCode !== 0) {
    throw new SetupRefusal(
      '.env is not ignored by git (git check-ignore): refusing to write secrets to a file git could commit. Add `.env` to .gitignore.',
    );
  }
}

/** The command-line options of `pnpm setup:local`. */
export interface SetupFlags {
  /** Replace a `.env` that points at another deployment (backed up to `.env.bak`). */
  readonly force: boolean;
  /** Drop and recreate the dev database first (local only). */
  readonly resetDb: boolean;
  /** Print the usage and exit. */
  readonly help: boolean;
}

/**
 * Parses the command line. Unknown arguments are refused (a typo must not run a setup).
 *
 * @param argv The arguments after the script name.
 */
export function parseSetupFlags(argv: readonly string[]): SetupFlags {
  const flags = { force: false, resetDb: false, help: false };
  for (const arg of argv) {
    if (arg === '--force') flags.force = true;
    else if (arg === '--reset-db') flags.resetDb = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--') continue;
    else throw new SetupRefusal(`unknown argument ${JSON.stringify(arg.slice(0, 40))}`, 2);
  }
  return flags;
}
