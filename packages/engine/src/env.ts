/**
 * @file Environment configuration for the bridge processes (the HTTP API and the worker), parsed
 * and validated in one place, framework-free.
 *
 * Why here and not in each app: both processes must agree on the chain, the deployment and above
 * all on the safety refusals (a mainnet or unknown chain, a publicly known development key on a
 * real chain). Two copies of those rules would drift, and a mutation in one copy would go
 * unnoticed by the other's tests. The module is pure (it reads the object it is given, never
 * `process.env` itself), so every rule is unit-tested without touching the process.
 *
 * Rules every parser here keeps:
 *
 * - **Fail fast, all at once.** Every variable is checked and every problem is reported in ONE
 *   `ConfigError`, so an operator fixes the file in one go instead of one restart per variable.
 * - **Never print a value.** A problem names the variable and what is wrong with it, never what
 *   it holds: `DATABASE_URL` carries a password, `RPC_URL` an API key, the tokens and signer keys
 *   are credentials, and even a "harmless" variable may hold a secret pasted in the wrong place.
 * - **Secrets stay wrapped.** Credentials are `Secret` objects whose `toString`, `toJSON` and
 *   `util.inspect` print `<redacted>`; a config logged by accident shows no credential.
 * - **Real chains are opt-in.** A local chain (Anvil, chain id 31337 or 1337) runs as configured;
 *   a known testnet needs `ALLOW_TESTNET=true`, a known mainnet `ALLOW_MAINNET=true`, and any other
 *   chain id `ALLOW_UNKNOWN_CHAIN=true`. The flags accept only the literal `true` / `false`.
 * - **Development keys stay local.** Anvil's ten well-known keys (public since the day Foundry
 *   shipped) are refused as signer keys on anything but a local chain, and so are bearer tokens
 *   that look like the `.env.example` placeholders (`change-me`, `dev-only`).
 */

import { inspect } from 'node:util';

/** The text every redacted value prints as. */
export const REDACTED = '<redacted>';

/**
 * A credential. The value is reachable only through `reveal()`; printing, string conversion and
 * JSON serialisation all give `<redacted>`.
 */
export class Secret {
  readonly #value: string;

  /** @param value The credential. */
  constructor(value: string) {
    this.#value = value;
  }

  /** The credential itself. Call it only where it is used (a client constructor, a compare). */
  reveal(): string {
    return this.#value;
  }

  /** @returns `<redacted>`. */
  toString(): string {
    return REDACTED;
  }

  /** @returns `<redacted>`. */
  toJSON(): string {
    return REDACTED;
  }

  /** @returns `<redacted>` for `console.log` and `util.inspect`. */
  [inspect.custom](): string {
    return REDACTED;
  }
}

/** How dangerous a chain is to run against. */
export type ChainClass = 'local' | 'testnet' | 'mainnet' | 'unknown';

/** Local development chains: run without any flag. */
export const LOCAL_CHAIN_IDS: ReadonlyMap<number, string> = new Map([
  [31337, 'Anvil / Hardhat'],
  [1337, 'local development node'],
]);

/** Well-known public testnets: refused unless `ALLOW_TESTNET=true`. */
export const TESTNET_CHAIN_IDS: ReadonlyMap<number, string> = new Map([
  [11155111, 'Sepolia'],
  [17000, 'Holesky'],
  [560048, 'Hoodi'],
  [84532, 'Base Sepolia'],
  [421614, 'Arbitrum Sepolia'],
  [11155420, 'OP Sepolia'],
  [80002, 'Polygon Amoy'],
  [43113, 'Avalanche Fuji'],
  [97, 'BNB Smart Chain testnet'],
]);

/**
 * Well-known mainnets, where tokens are real money: refused unless `ALLOW_MAINNET=true`. Not a
 * complete list of every chain in existence; anything not listed anywhere is `unknown`, which is
 * refused as well (`ALLOW_UNKNOWN_CHAIN`), so a missing entry can never make a chain easier to use.
 */
export const MAINNET_CHAIN_IDS: ReadonlyMap<number, string> = new Map([
  [1, 'Ethereum'],
  [10, 'OP Mainnet'],
  [56, 'BNB Smart Chain'],
  [100, 'Gnosis'],
  [137, 'Polygon PoS'],
  [250, 'Fantom'],
  [324, 'zkSync Era'],
  [1101, 'Polygon zkEVM'],
  [5000, 'Mantle'],
  [8453, 'Base'],
  [42161, 'Arbitrum One'],
  [42220, 'Celo'],
  [43114, 'Avalanche C-Chain'],
  [59144, 'Linea'],
  [81457, 'Blast'],
  [534352, 'Scroll'],
]);

/**
 * The private keys of Anvil's ten default accounts (mnemonic "test test test test test test test
 * test test test test junk", paths m/44'/60'/0'/0/0..9). Public knowledge: anything they sign for
 * on a real chain is taken by bots within seconds. DEV ONLY; refused on non-local chains.
 */
export const ANVIL_DEV_KEYS: readonly string[] = Object.freeze([
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6',
]);

/**
 * Which class a chain id belongs to.
 *
 * @param chainId The chain id.
 */
export function classifyChain(chainId: number): ChainClass {
  if (LOCAL_CHAIN_IDS.has(chainId)) return 'local';
  if (TESTNET_CHAIN_IDS.has(chainId)) return 'testnet';
  if (MAINNET_CHAIN_IDS.has(chainId)) return 'mainnet';
  return 'unknown';
}

/** One invalid variable: its name and what is wrong, never its value. */
export interface ConfigProblem {
  /** The environment variable. */
  readonly variable: string;
  /** What is wrong with it. */
  readonly reason: string;
}

/** The configuration is invalid. Lists every problem; never contains a value. */
export class ConfigError extends Error {
  /** Every problem found. */
  readonly problems: readonly ConfigProblem[];

  /** @param problems Every problem found (at least one). */
  constructor(problems: readonly ConfigProblem[]) {
    super(
      `invalid configuration (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` +
        problems.map((p) => `  - ${p.variable}: ${p.reason}`).join('\n'),
    );
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** The node is on another chain than the configured one. */
export class ChainIdMismatchConfigError extends Error {
  /**
   * @param configured The configured `CHAIN_ID`.
   * @param reported What the node reports.
   */
  constructor(
    readonly configured: number,
    readonly reported: number,
  ) {
    super(
      `the node reports chain id ${reported}, but CHAIN_ID is ${configured}: refusing to start`,
    );
    this.name = 'ChainIdMismatchConfigError';
  }
}

/** An environment: variable name to value (`process.env` fits). */
export type Env = Readonly<Record<string, string | undefined>>;

/** Log verbosity, most quiet first. */
export type LogLevel = 'error' | 'warn' | 'log' | 'debug';

const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'log', 'debug'];

/** The chain and deployment both processes talk to. */
export interface ChainSettings {
  /** `CHAIN_ID`. */
  readonly chainId: number;
  /** Its class (local, testnet, mainnet, unknown), already allowed by the flags. */
  readonly chainClass: ChainClass;
  /** `RPC_URL` (may carry an API key). */
  readonly rpcUrl: Secret;
  /** `TOKEN_ADDRESS`, lowercase. */
  readonly tokenAddress: `0x${string}`;
  /** `REGISTRY_ADDRESS`, lowercase. */
  readonly registryAddress: `0x${string}`;
  /** `CONFIRMATION_DEPTH`. */
  readonly confirmationDepth: number;
  /** `RPC_TIMEOUT_MS`. */
  readonly rpcTimeoutMs: number;
}

/** What both processes share. */
export interface CommonConfig {
  /** `DATABASE_URL` (carries a password). */
  readonly databaseUrl: Secret;
  /** The chain. */
  readonly chain: ChainSettings;
  /** `LOG_LEVEL`. */
  readonly logLevel: LogLevel;
}

/** The HTTP API's configuration. */
export interface ApiConfig extends CommonConfig {
  /** `API_HOST`. */
  readonly host: string;
  /** `API_PORT`. */
  readonly port: number;
  /** `API_PLATFORM_TOKEN`: the bearer token for platform routes. */
  readonly platformToken: Secret;
  /** `API_ADMIN_TOKEN`: the bearer token for admin and compliance routes. */
  readonly adminToken: Secret;
  /** `API_MAX_AMOUNT`: the largest amount one request may move, smallest unit. */
  readonly maxAmount: bigint;
  /** `API_BODY_LIMIT_BYTES`. */
  readonly bodyLimitBytes: number;
  /** `API_DOCS_ENABLED`: serve the OpenAPI document and UI at /docs (default: local chains only). */
  readonly docsEnabled: boolean;
}

/** The worker's configuration. */
export interface WorkerConfig extends CommonConfig {
  /** `SETTLEMENT_SIGNER_KEY`: signs mint / burn / settleTransfer. */
  readonly settlementKey: Secret;
  /** `COMPLIANCE_SIGNER_KEY`: signs registry changes. */
  readonly complianceKey: Secret;
  /** `FEE_CAP_WEI`: the highest maxFeePerGas any transaction may pay. */
  readonly feeCapWei: bigint;
  /** `WORKER_ID`, or undefined (the worker derives one from host and pid). */
  readonly workerId: string | undefined;
  /** `POLL_INTERVAL_MS`. */
  readonly pollIntervalMs: number;
  /** `RECONCILE_EVERY_TICKS`. */
  readonly reconcileEveryTicks: number;
  /** `SHUTDOWN_TIMEOUT_MS`: how long a shutdown waits for the tick in progress. */
  readonly shutdownTimeoutMs: number;
}

/**
 * Default confirmations before anything counts: 12. WHY: about two and a half minutes on
 * Ethereum, deeper than every reorg seen on the beacon chain since the merge; a local Anvil run
 * sets 1 in `.env.example` because nothing there reorgs by itself.
 */
export const DEFAULT_CONFIRMATION_DEPTH = 12;

/** Default RPC request timeout: 10 s, the gateway's own default. */
export const DEFAULT_RPC_TIMEOUT_MS = 10_000;

/** Default API port. */
export const DEFAULT_API_PORT = 3000;

/**
 * Default API bind address: loopback. WHY: a forgotten variable must not expose the API on every
 * interface; a container sets `API_HOST=0.0.0.0` deliberately.
 */
export const DEFAULT_API_HOST = '127.0.0.1';

/**
 * Default largest amount per request: 1 000 000 000 000 smallest units (one million tokens of a
 * 6-decimal token). WHY: a cap bounds the damage of a compromised platform credential or a
 * client bug (an amount sent in whole tokens times 10^6 twice); raise it deliberately.
 */
export const DEFAULT_MAX_AMOUNT = 1_000_000_000_000n;

/** The amount column is a signed 64-bit integer: no cap may exceed it. */
export const MAX_STORABLE_AMOUNT = 9_223_372_036_854_775_807n;

/** Default request body limit: 16 KiB, far above any request this API accepts. */
export const DEFAULT_BODY_LIMIT_BYTES = 16_384;

/** Bearer tokens shorter than this are refused (32 characters of a random token ≈ 190 bits). */
export const MIN_TOKEN_LENGTH = 32;

/** Bearer tokens longer than this are refused (a header, not a document). */
export const MAX_TOKEN_LENGTH = 512;

/** Default delay between engine ticks: 2 s (the engine's own default). */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** Default ticks between reconciliation runs: the engine's own default, 10. */
export const DEFAULT_RECONCILE_EVERY_TICKS = 10;

/**
 * Default shutdown wait: 30 s. WHY: a tick is bounded by the dispatcher's handler limit (60 s at
 * most by default, far less in practice); an orchestrator's grace period is usually 30 s, and a
 * worker killed mid-tick is safe anyway (commit before broadcast, leases expire), so waiting
 * longer than the orchestrator would only end in SIGKILL.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
/** Visible ASCII, no spaces: a token must travel in an `Authorization` header unchanged. */
const TOKEN_CHARS = /^[\x21-\x7e]+$/;
const WORKER_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Markers of the example tokens shipped in `.env.example` (and of any token someone wrote by hand
 * following that pattern). Matched case-insensitively, anywhere in the token.
 */
export const PLACEHOLDER_TOKEN_MARKERS: readonly string[] = Object.freeze([
  'change-me',
  'dev-only',
]);

/**
 * Whether a bearer token is a placeholder (contains a `PLACEHOLDER_TOKEN_MARKERS` entry).
 *
 * @param token The token.
 */
export function isPlaceholderToken(token: string): boolean {
  const lower = token.toLowerCase();
  return PLACEHOLDER_TOKEN_MARKERS.some((m) => lower.includes(m));
}

/** Collects every problem while reading variables; throws once at the end. */
class Reader {
  readonly problems: ConfigProblem[] = [];

  constructor(private readonly env: Env) {}

  problem(variable: string, reason: string): void {
    this.problems.push({ variable, reason });
  }

  /** The raw value, or undefined when unset or empty (an empty value is treated as unset). */
  raw(name: string): string | undefined {
    const v = this.env[name];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  }

  required(name: string): string | undefined {
    const v = this.raw(name);
    if (v === undefined) this.problem(name, 'is required');
    return v;
  }

  url(name: string, schemes: readonly string[]): Secret | undefined {
    const v = this.required(name);
    if (v === undefined) return undefined;
    let protocol: string;
    try {
      protocol = new URL(v).protocol;
    } catch {
      this.problem(name, `must be a URL (${schemes.join(' or ')})`);
      return undefined;
    }
    if (!schemes.includes(protocol.slice(0, -1))) {
      this.problem(name, `must use ${schemes.join(' or ')}`);
      return undefined;
    }
    return new Secret(v);
  }

  int(name: string, opts: { min: number; max: number; default?: number }): number | undefined {
    const v = opts.default === undefined ? this.required(name) : this.raw(name);
    if (v === undefined) return opts.default;
    const n = DECIMAL.test(v) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n) || n < opts.min || n > opts.max) {
      this.problem(name, `must be an integer from ${opts.min} to ${opts.max}`);
      return undefined;
    }
    return n;
  }

  bigint(name: string, opts: { min: bigint; max: bigint; default?: bigint }): bigint | undefined {
    const v = opts.default === undefined ? this.required(name) : this.raw(name);
    if (v === undefined) return opts.default;
    const n = DECIMAL.test(v) && v.length <= 78 ? BigInt(v) : undefined;
    if (n === undefined || n < opts.min || n > opts.max) {
      this.problem(name, `must be a decimal integer from ${opts.min} to ${opts.max}`);
      return undefined;
    }
    return n;
  }

  flag(name: string, fallback: boolean): boolean {
    const v = this.raw(name);
    if (v === undefined) return fallback;
    if (v === 'true') return true;
    if (v === 'false') return false;
    // Strict on purpose: "1", "yes" or "TRUE" opening the mainnet guard by accident is worse
    // than an operator retyping one word.
    this.problem(name, "must be 'true' or 'false'");
    return false;
  }

  address(name: string): `0x${string}` | undefined {
    const v = this.required(name);
    if (v === undefined) return undefined;
    if (!ADDRESS.test(v)) {
      this.problem(name, 'must be 0x followed by 40 hex characters');
      return undefined;
    }
    const lower = v.toLowerCase() as `0x${string}`;
    if (/^0x0{40}$/.test(lower)) {
      this.problem(name, 'must not be the zero address');
      return undefined;
    }
    return lower;
  }

  token(name: string): Secret | undefined {
    const v = this.required(name);
    if (v === undefined) return undefined;
    if (v.length < MIN_TOKEN_LENGTH || v.length > MAX_TOKEN_LENGTH) {
      this.problem(name, `must be ${MIN_TOKEN_LENGTH} to ${MAX_TOKEN_LENGTH} characters long`);
      return undefined;
    }
    if (!TOKEN_CHARS.test(v)) {
      this.problem(name, 'must contain visible ASCII characters only (no spaces)');
      return undefined;
    }
    return new Secret(v);
  }

  privateKey(name: string): Secret | undefined {
    const v = this.required(name);
    if (v === undefined) return undefined;
    if (!PRIVATE_KEY.test(v)) {
      this.problem(name, 'must be 0x followed by 64 hex characters');
      return undefined;
    }
    return new Secret(v.toLowerCase());
  }

  logLevel(): LogLevel {
    const v = this.raw('LOG_LEVEL');
    if (v === undefined) return 'log';
    if ((LOG_LEVELS as readonly string[]).includes(v)) return v as LogLevel;
    this.problem('LOG_LEVEL', `must be one of ${LOG_LEVELS.join(', ')}`);
    return 'log';
  }

  finish(): void {
    if (this.problems.length > 0) throw new ConfigError(this.problems);
  }
}

/** Reads the variables both processes share; problems are collected on `r`. */
function readCommon(r: Reader): Partial<CommonConfig> & { chainPartial: Partial<ChainSettings> } {
  const databaseUrl = r.url('DATABASE_URL', ['postgres', 'postgresql']);
  const rpcUrl = r.url('RPC_URL', ['http', 'https']);
  const chainId = r.int('CHAIN_ID', { min: 1, max: Number.MAX_SAFE_INTEGER });
  const tokenAddress = r.address('TOKEN_ADDRESS');
  const registryAddress = r.address('REGISTRY_ADDRESS');
  if (tokenAddress !== undefined && tokenAddress === registryAddress) {
    r.problem('REGISTRY_ADDRESS', 'must differ from TOKEN_ADDRESS');
  }
  const confirmationDepth = r.int('CONFIRMATION_DEPTH', {
    min: 1,
    max: 10_000,
    default: DEFAULT_CONFIRMATION_DEPTH,
  });
  const rpcTimeoutMs = r.int('RPC_TIMEOUT_MS', {
    min: 100,
    max: 120_000,
    default: DEFAULT_RPC_TIMEOUT_MS,
  });
  const allowTestnet = r.flag('ALLOW_TESTNET', false);
  const allowMainnet = r.flag('ALLOW_MAINNET', false);
  const allowUnknown = r.flag('ALLOW_UNKNOWN_CHAIN', false);
  let chainClass: ChainClass | undefined;
  if (chainId !== undefined) {
    chainClass = classifyChain(chainId);
    if (chainClass === 'testnet' && !allowTestnet) {
      r.problem('CHAIN_ID', 'is a public testnet: set ALLOW_TESTNET=true to run against it');
    } else if (chainClass === 'mainnet' && !allowMainnet) {
      r.problem(
        'CHAIN_ID',
        'is a mainnet (real money): set ALLOW_MAINNET=true to run against it deliberately',
      );
    } else if (chainClass === 'unknown' && !allowUnknown) {
      r.problem(
        'CHAIN_ID',
        'is not a known local, testnet or mainnet chain: set ALLOW_UNKNOWN_CHAIN=true to run against it',
      );
    }
  }
  return {
    ...(databaseUrl !== undefined ? { databaseUrl } : {}),
    logLevel: r.logLevel(),
    chainPartial: {
      ...(chainId !== undefined ? { chainId } : {}),
      ...(chainClass !== undefined ? { chainClass } : {}),
      ...(rpcUrl !== undefined ? { rpcUrl } : {}),
      ...(tokenAddress !== undefined ? { tokenAddress } : {}),
      ...(registryAddress !== undefined ? { registryAddress } : {}),
      ...(confirmationDepth !== undefined ? { confirmationDepth } : {}),
      ...(rpcTimeoutMs !== undefined ? { rpcTimeoutMs } : {}),
    },
  };
}

/**
 * Narrows a partially read value once `finish()` has passed: every field was then read without a
 * problem. Throws (a programming error, never a user error) if one is still missing.
 */
function complete<T extends object>(value: Partial<T>, keys: readonly (keyof T)[]): T {
  for (const key of keys) {
    /* istanbul ignore next -- unreachable after finish(): every missing value raised a problem. */
    if (value[key] === undefined) {
      throw new Error(`configuration field ${String(key)} missing after validation`);
    }
  }
  return value as T;
}

const CHAIN_KEYS: readonly (keyof ChainSettings)[] = [
  'chainId',
  'chainClass',
  'rpcUrl',
  'tokenAddress',
  'registryAddress',
  'confirmationDepth',
  'rpcTimeoutMs',
];

/**
 * The API's configuration from `env`, or `ConfigError` listing every problem (names and reasons,
 * never values).
 *
 * @param env The environment (`process.env`).
 */
export function loadApiConfig(env: Env): ApiConfig {
  const r = new Reader(env);
  const common = readCommon(r);
  const host = r.raw('API_HOST') ?? DEFAULT_API_HOST;
  if (!/^[A-Za-z0-9.:[\]-]{1,255}$/.test(host)) {
    r.problem('API_HOST', 'must be a host name or IP address');
  }
  const port = r.int('API_PORT', { min: 1, max: 65_535, default: DEFAULT_API_PORT });
  const platformToken = r.token('API_PLATFORM_TOKEN');
  const adminToken = r.token('API_ADMIN_TOKEN');
  if (
    platformToken !== undefined &&
    adminToken !== undefined &&
    platformToken.reveal() === adminToken.reveal()
  ) {
    // One value for both would make every platform caller an admin.
    r.problem('API_ADMIN_TOKEN', 'must differ from API_PLATFORM_TOKEN');
  }
  const chainClass = common.chainPartial.chainClass;
  if (chainClass !== undefined && chainClass !== 'local') {
    // The example tokens of `.env.example` are public (they are in the repository): like the Anvil
    // keys, they must never guard a real chain, even when someone copies the file unchanged.
    for (const [name, token] of [
      ['API_PLATFORM_TOKEN', platformToken],
      ['API_ADMIN_TOKEN', adminToken],
    ] as const) {
      if (token !== undefined && isPlaceholderToken(token.reveal())) {
        r.problem(name, 'is a placeholder development token: refused on a non-local chain');
      }
    }
  }
  const maxAmount = r.bigint('API_MAX_AMOUNT', {
    min: 1n,
    max: MAX_STORABLE_AMOUNT,
    default: DEFAULT_MAX_AMOUNT,
  });
  const bodyLimitBytes = r.int('API_BODY_LIMIT_BYTES', {
    min: 1_024,
    max: 1_048_576,
    default: DEFAULT_BODY_LIMIT_BYTES,
  });
  // The OpenAPI document maps the whole attack surface: served by default only on a local chain;
  // anywhere else an operator opts in with API_DOCS_ENABLED=true.
  const docsEnabled = r.flag('API_DOCS_ENABLED', chainClass === 'local');
  r.finish();
  const chain = complete<ChainSettings>(common.chainPartial, CHAIN_KEYS);
  return complete<ApiConfig>(
    {
      databaseUrl: common.databaseUrl,
      chain,
      logLevel: common.logLevel,
      host,
      port,
      platformToken,
      adminToken,
      maxAmount,
      bodyLimitBytes,
      docsEnabled,
    },
    ['databaseUrl', 'port', 'platformToken', 'adminToken', 'maxAmount', 'bodyLimitBytes'],
  );
}

/**
 * The worker's configuration from `env`, or `ConfigError` listing every problem (names and
 * reasons, never values).
 *
 * @param env The environment (`process.env`).
 */
export function loadWorkerConfig(env: Env): WorkerConfig {
  const r = new Reader(env);
  const common = readCommon(r);
  const settlementKey = r.privateKey('SETTLEMENT_SIGNER_KEY');
  const complianceKey = r.privateKey('COMPLIANCE_SIGNER_KEY');
  if (
    settlementKey !== undefined &&
    complianceKey !== undefined &&
    settlementKey.reveal() === complianceKey.reveal()
  ) {
    // Two signers on one key share one nonce sequence while the engine allocates them apart:
    // the second transaction of every pair would be refused or replace the first.
    r.problem('COMPLIANCE_SIGNER_KEY', 'must differ from SETTLEMENT_SIGNER_KEY');
  }
  const chainClass = common.chainPartial.chainClass;
  if (chainClass !== undefined && chainClass !== 'local') {
    for (const [name, key] of [
      ['SETTLEMENT_SIGNER_KEY', settlementKey],
      ['COMPLIANCE_SIGNER_KEY', complianceKey],
    ] as const) {
      if (key !== undefined && ANVIL_DEV_KEYS.includes(key.reveal())) {
        r.problem(name, 'is a publicly known development key: refused on a non-local chain');
      }
    }
  }
  const feeCapWei = r.bigint('FEE_CAP_WEI', { min: 1n, max: 10n ** 30n });
  const workerId = r.raw('WORKER_ID');
  if (workerId !== undefined && !WORKER_ID.test(workerId)) {
    r.problem('WORKER_ID', 'must be 1 to 64 characters of letters, digits and . _ : -');
  }
  const pollIntervalMs = r.int('POLL_INTERVAL_MS', {
    min: 100,
    max: 600_000,
    default: DEFAULT_POLL_INTERVAL_MS,
  });
  const reconcileEveryTicks = r.int('RECONCILE_EVERY_TICKS', {
    min: 1,
    max: 100_000,
    default: DEFAULT_RECONCILE_EVERY_TICKS,
  });
  const shutdownTimeoutMs = r.int('SHUTDOWN_TIMEOUT_MS', {
    min: 1_000,
    max: 600_000,
    default: DEFAULT_SHUTDOWN_TIMEOUT_MS,
  });
  r.finish();
  const chain = complete<ChainSettings>(common.chainPartial, CHAIN_KEYS);
  return complete<WorkerConfig>(
    {
      databaseUrl: common.databaseUrl,
      chain,
      logLevel: common.logLevel,
      settlementKey,
      complianceKey,
      feeCapWei,
      workerId,
      pollIntervalMs,
      reconcileEveryTicks,
      shutdownTimeoutMs,
    },
    ['databaseUrl', 'settlementKey', 'complianceKey', 'feeCapWei'],
  );
}

/**
 * Every secret value in a configuration, for the engine's redaction (`secrets` options of
 * `describeError` / `sanitizeText` and `BridgeEngineConfig.secrets`). The redaction also removes
 * each URL's parts (host, path, credentials, query values), so passing the URLs is enough.
 *
 * @param config An API or worker configuration.
 */
export function secretValues(config: ApiConfig | WorkerConfig): string[] {
  const out = [config.databaseUrl.reveal(), config.chain.rpcUrl.reveal()];
  if ('platformToken' in config)
    out.push(config.platformToken.reveal(), config.adminToken.reveal());
  if ('settlementKey' in config) {
    out.push(config.settlementKey.reveal(), config.complianceKey.reveal());
  }
  return out;
}

/**
 * Refuses to go on when the node is on another chain than `CHAIN_ID`. Both processes call it at
 * startup, before anything is read or signed: a node on the wrong chain would make every read
 * wrong evidence.
 *
 * @param configured The configured chain id.
 * @param reported The node's `eth_chainId`.
 */
export function assertNodeChainId(configured: number, reported: number): void {
  if (configured !== reported) throw new ChainIdMismatchConfigError(configured, reported);
}
