/**
 * Unit tests for the shared environment configuration (src/env.ts): every refusal, every default,
 * and that no value (above all no secret) ever appears in an error.
 */

import { inspect } from 'node:util';

import { mnemonicToAccount } from 'viem/accounts';

import {
  ANVIL_DEV_KEYS,
  assertNodeChainId,
  ChainIdMismatchConfigError,
  classifyChain,
  ConfigError,
  DEFAULT_API_HOST,
  DEFAULT_BODY_LIMIT_BYTES,
  DEFAULT_CONFIRMATION_DEPTH,
  DEFAULT_MAX_AMOUNT,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_RECONCILE_EVERY_TICKS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  isPlaceholderToken,
  type Env,
  loadApiConfig,
  loadWorkerConfig,
  MAX_STORABLE_AMOUNT,
  REDACTED,
  Secret,
  secretValues,
} from '../src/env';

const DB = 'postgresql://user:db-password-xyz@localhost:5434/bridge';
const RPC = 'http://127.0.0.1:8545/rpc-key-abc123';
const TOKEN_A = 'platform-token-0123456789-abcdefghijklmnop';
const TOKEN_B = 'admin-token-0123456789-abcdefghijklmnopqrs';
const KEY_1 = `0x${'1'.repeat(64)}`;
const KEY_2 = `0x${'2'.repeat(64)}`;

const common: Env = {
  DATABASE_URL: DB,
  RPC_URL: RPC,
  CHAIN_ID: '31337',
  TOKEN_ADDRESS: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  REGISTRY_ADDRESS: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
};
const api: Env = { ...common, API_PLATFORM_TOKEN: TOKEN_A, API_ADMIN_TOKEN: TOKEN_B };
const worker: Env = {
  ...common,
  SETTLEMENT_SIGNER_KEY: KEY_1,
  COMPLIANCE_SIGNER_KEY: KEY_2,
  FEE_CAP_WEI: '200000000000',
};

function problemsOf(fn: () => unknown): { variable: string; reason: string }[] {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return [...(err as ConfigError).problems];
  }
  throw new Error('expected a ConfigError');
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected an error');
}

describe('Secret', () => {
  it('prints <redacted> everywhere and reveals only on request', () => {
    const s = new Secret('hunter2-secret');
    expect(String(s)).toBe(REDACTED);
    expect(`${s}`).toBe(REDACTED);
    expect(JSON.stringify({ s })).toBe(`{"s":"${REDACTED}"}`);
    expect(inspect({ s })).not.toContain('hunter2');
    expect(s.reveal()).toBe('hunter2-secret');
  });

  it('a logged configuration shows no credential', () => {
    const config = loadWorkerConfig(worker);
    const printed = `${inspect(config, { depth: 5 })} ${JSON.stringify(config, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    )}`;
    for (const secret of [DB, RPC, KEY_1, KEY_2]) expect(printed).not.toContain(secret);
    expect(printed).not.toContain('db-password-xyz');
  });
});

describe('classifyChain', () => {
  it.each([
    [31337, 'local'],
    [1337, 'local'],
    [11155111, 'testnet'],
    [1, 'mainnet'],
    [137, 'mainnet'],
    [8453, 'mainnet'],
    [42161, 'mainnet'],
    [123456789, 'unknown'],
  ])('%d is %s', (id, cls) => {
    expect(classifyChain(id)).toBe(cls);
  });
});

describe('ANVIL_DEV_KEYS', () => {
  it("are exactly the keys of the 'test ... junk' mnemonic, paths 0..9", () => {
    const mnemonic = 'test test test test test test test test test test test junk';
    const derived = Array.from({ length: 10 }, (_, i) => {
      const account = mnemonicToAccount(mnemonic, { addressIndex: i });
      const key = account.getHdKey().privateKey;
      if (key === null) throw new Error('no key');
      return `0x${Buffer.from(key).toString('hex')}`;
    });
    expect(ANVIL_DEV_KEYS).toEqual(derived);
  });
});

describe('loadApiConfig', () => {
  it('parses a valid local environment with documented defaults', () => {
    const c = loadApiConfig(api);
    expect(c.chain.chainId).toBe(31337);
    expect(c.chain.chainClass).toBe('local');
    expect(c.chain.tokenAddress).toBe('0x5fbdb2315678afecb367f032d93f642f64180aa3');
    expect(c.chain.registryAddress).toBe('0xe7f1725e7734ce288f8367e1bb143e90bb3f0512');
    expect(c.chain.confirmationDepth).toBe(DEFAULT_CONFIRMATION_DEPTH);
    expect(c.chain.rpcTimeoutMs).toBe(10_000);
    expect(c.host).toBe(DEFAULT_API_HOST);
    expect(c.port).toBe(3000);
    expect(c.maxAmount).toBe(DEFAULT_MAX_AMOUNT);
    expect(c.bodyLimitBytes).toBe(DEFAULT_BODY_LIMIT_BYTES);
    expect(c.docsEnabled).toBe(true);
    expect(c.logLevel).toBe('log');
    expect(c.platformToken.reveal()).toBe(TOKEN_A);
    expect(c.adminToken.reveal()).toBe(TOKEN_B);
    expect(c.databaseUrl.reveal()).toBe(DB);
    expect(c.chain.rpcUrl.reveal()).toBe(RPC);
  });

  it('reads every optional variable', () => {
    const c = loadApiConfig({
      ...api,
      API_HOST: '0.0.0.0',
      API_PORT: '8080',
      API_MAX_AMOUNT: '5000',
      API_BODY_LIMIT_BYTES: '2048',
      API_DOCS_ENABLED: 'false',
      CONFIRMATION_DEPTH: '3',
      RPC_TIMEOUT_MS: '500',
      LOG_LEVEL: 'debug',
    });
    expect([c.host, c.port, c.maxAmount, c.bodyLimitBytes, c.docsEnabled]).toEqual([
      '0.0.0.0',
      8080,
      5000n,
      2048,
      false,
    ]);
    expect([c.chain.confirmationDepth, c.chain.rpcTimeoutMs, c.logLevel]).toEqual([
      3,
      500,
      'debug',
    ]);
  });

  it('lists EVERY missing variable in one error', () => {
    const problems = problemsOf(() => loadApiConfig({}));
    expect(problems.map((p) => p.variable).sort()).toEqual(
      [
        'API_ADMIN_TOKEN',
        'API_PLATFORM_TOKEN',
        'CHAIN_ID',
        'DATABASE_URL',
        'REGISTRY_ADDRESS',
        'RPC_URL',
        'TOKEN_ADDRESS',
      ].sort(),
    );
    expect(problems.every((p) => p.reason === 'is required')).toBe(true);
    expect(messageOf(() => loadApiConfig({}))).toMatch(/^invalid configuration \(7 problems\):/);
  });

  it('treats an empty or blank value as unset', () => {
    expect(problemsOf(() => loadApiConfig({ ...api, RPC_URL: '   ' }))).toEqual([
      { variable: 'RPC_URL', reason: 'is required' },
    ]);
  });

  it('says "1 problem" for one problem', () => {
    expect(messageOf(() => loadApiConfig({ ...api, API_PORT: '0' }))).toMatch(
      /^invalid configuration \(1 problem\):/,
    );
  });

  it.each([
    ['DATABASE_URL', 'mysql://u:p@h/db', /postgres/],
    ['DATABASE_URL', 'not a url', /must be a URL/],
    ['RPC_URL', 'ws://127.0.0.1:8545', /http or https/],
    ['CHAIN_ID', '0', /integer from 1/],
    ['CHAIN_ID', '31337.5', /integer/],
    ['CHAIN_ID', '-1', /integer/],
    ['CHAIN_ID', '0x7a69', /integer/],
    ['TOKEN_ADDRESS', '0x123', /40 hex/],
    ['TOKEN_ADDRESS', `0x${'0'.repeat(40)}`, /zero address/],
    ['CONFIRMATION_DEPTH', '0', /integer from 1 to 10000/],
    ['CONFIRMATION_DEPTH', '012', /integer/],
    ['RPC_TIMEOUT_MS', '50', /integer from 100/],
    ['API_PORT', '70000', /integer from 1 to 65535/],
    ['API_HOST', 'bad host!', /host name/],
    ['API_MAX_AMOUNT', '0', /from 1 to/],
    ['API_MAX_AMOUNT', (MAX_STORABLE_AMOUNT + 1n).toString(), /from 1 to/],
    ['API_MAX_AMOUNT', '1.5', /decimal integer/],
    ['API_MAX_AMOUNT', '9'.repeat(79), /decimal integer/],
    ['API_BODY_LIMIT_BYTES', '10', /integer from 1024/],
    ['API_DOCS_ENABLED', 'yes', /'true' or 'false'/],
    ['LOG_LEVEL', 'verbose', /one of error, warn, log, debug/],
    ['API_PLATFORM_TOKEN', 'short-token', /32 to 512 characters/],
    ['API_PLATFORM_TOKEN', 'x'.repeat(513), /32 to 512 characters/],
    ['API_ADMIN_TOKEN', `${'a'.repeat(20)} ${'b'.repeat(20)}`, /visible ASCII/],
  ])('%s = %j is refused', (variable, value, reason) => {
    const problems = problemsOf(() => loadApiConfig({ ...api, [variable]: value }));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.variable).toBe(variable);
    expect(problems[0]?.reason).toMatch(reason);
  });

  it('accepts a token of exactly the minimum length and refuses one character less', () => {
    expect(() => loadApiConfig({ ...api, API_PLATFORM_TOKEN: 'p'.repeat(32) })).not.toThrow();
    expect(problemsOf(() => loadApiConfig({ ...api, API_PLATFORM_TOKEN: 'p'.repeat(31) }))).toEqual(
      [{ variable: 'API_PLATFORM_TOKEN', reason: 'must be 32 to 512 characters long' }],
    );
  });

  it('refuses one value for both tokens (every platform caller would be an admin)', () => {
    expect(problemsOf(() => loadApiConfig({ ...api, API_ADMIN_TOKEN: TOKEN_A }))).toEqual([
      { variable: 'API_ADMIN_TOKEN', reason: 'must differ from API_PLATFORM_TOKEN' },
    ]);
  });

  it('refuses placeholder tokens (change-me / dev-only, any case) on every non-local chain', () => {
    const placeholder = {
      API_PLATFORM_TOKEN: 'dev-only-platform-token-change-me-0123456789',
      API_ADMIN_TOKEN: 'my-admin-token-CHANGE-ME-0123456789abcdefgh',
    };
    expect(loadApiConfig({ ...api, ...placeholder }).chain.chainClass).toBe('local');
    for (const chain of [
      { CHAIN_ID: '1', ALLOW_MAINNET: 'true' },
      { CHAIN_ID: '11155111', ALLOW_TESTNET: 'true' },
      { CHAIN_ID: '999999999', ALLOW_UNKNOWN_CHAIN: 'true' },
    ]) {
      expect(problemsOf(() => loadApiConfig({ ...api, ...placeholder, ...chain }))).toEqual([
        {
          variable: 'API_PLATFORM_TOKEN',
          reason: 'is a placeholder development token: refused on a non-local chain',
        },
        {
          variable: 'API_ADMIN_TOKEN',
          reason: 'is a placeholder development token: refused on a non-local chain',
        },
      ]);
    }
    // Real-looking tokens pass on a real chain.
    expect(loadApiConfig({ ...api, CHAIN_ID: '1', ALLOW_MAINNET: 'true' }).chain.chainClass).toBe(
      'mainnet',
    );
    expect(isPlaceholderToken('xDev-Onlyx')).toBe(true);
    expect(isPlaceholderToken('changeme-but-no-dash')).toBe(false);
  });

  it('serves the docs by default on a local chain only; an explicit value always wins', () => {
    expect(loadApiConfig(api).docsEnabled).toBe(true);
    expect(loadApiConfig({ ...api, API_DOCS_ENABLED: 'false' }).docsEnabled).toBe(false);
    const mainnet = { ...api, CHAIN_ID: '1', ALLOW_MAINNET: 'true' };
    expect(loadApiConfig(mainnet).docsEnabled).toBe(false);
    expect(loadApiConfig({ ...mainnet, API_DOCS_ENABLED: 'true' }).docsEnabled).toBe(true);
    expect(loadApiConfig({ ...api, CHAIN_ID: '11155111', ALLOW_TESTNET: 'true' }).docsEnabled).toBe(
      false,
    );
  });

  it('refuses one address for token and registry', () => {
    expect(
      problemsOf(() => loadApiConfig({ ...api, REGISTRY_ADDRESS: common.TOKEN_ADDRESS })),
    ).toEqual([{ variable: 'REGISTRY_ADDRESS', reason: 'must differ from TOKEN_ADDRESS' }]);
  });

  describe('the chain guard', () => {
    it('refuses Ethereum mainnet without ALLOW_MAINNET, and with ALLOW_MAINNET=false', () => {
      for (const extra of [{}, { ALLOW_MAINNET: 'false' }]) {
        const problems = problemsOf(() => loadApiConfig({ ...api, CHAIN_ID: '1', ...extra }));
        expect(problems).toEqual([
          {
            variable: 'CHAIN_ID',
            reason:
              'is a mainnet (real money): set ALLOW_MAINNET=true to run against it deliberately',
          },
        ]);
      }
    });

    it.each(['10', '56', '137', '8453', '42161', '43114'])(
      'refuses mainnet %s without the flag',
      (id) => {
        expect(problemsOf(() => loadApiConfig({ ...api, CHAIN_ID: id }))[0]?.reason).toMatch(
          /ALLOW_MAINNET/,
        );
      },
    );

    it('only the literal "true" opens it', () => {
      for (const v of ['1', 'yes', 'TRUE', 'True']) {
        const problems = problemsOf(() =>
          loadApiConfig({ ...api, CHAIN_ID: '1', ALLOW_MAINNET: v }),
        );
        expect(problems.map((p) => p.variable).sort()).toEqual(['ALLOW_MAINNET', 'CHAIN_ID']);
      }
      expect(loadApiConfig({ ...api, CHAIN_ID: '1', ALLOW_MAINNET: 'true' }).chain.chainClass).toBe(
        'mainnet',
      );
    });

    it('ALLOW_MAINNET does not open a testnet or an unknown chain (one flag per class)', () => {
      expect(
        problemsOf(() => loadApiConfig({ ...api, CHAIN_ID: '11155111', ALLOW_MAINNET: 'true' }))[0]
          ?.reason,
      ).toMatch(/ALLOW_TESTNET/);
      expect(
        problemsOf(() => loadApiConfig({ ...api, CHAIN_ID: '999999999', ALLOW_MAINNET: 'true' }))[0]
          ?.reason,
      ).toMatch(/ALLOW_UNKNOWN_CHAIN/);
      expect(
        problemsOf(() => loadApiConfig({ ...api, CHAIN_ID: '1', ALLOW_UNKNOWN_CHAIN: 'true' }))[0]
          ?.reason,
      ).toMatch(/ALLOW_MAINNET/);
    });

    it('a testnet needs ALLOW_TESTNET, an unknown chain ALLOW_UNKNOWN_CHAIN', () => {
      expect(
        loadApiConfig({ ...api, CHAIN_ID: '11155111', ALLOW_TESTNET: 'true' }).chain.chainClass,
      ).toBe('testnet');
      expect(
        loadApiConfig({ ...api, CHAIN_ID: '999999999', ALLOW_UNKNOWN_CHAIN: 'true' }).chain
          .chainClass,
      ).toBe('unknown');
    });
  });

  it('never prints a value in the error, secrets included', () => {
    const env: Env = {
      DATABASE_URL: 'mysql://root:top-secret-db-pw@db.internal:3306/x',
      RPC_URL: 'ftp://rpc.example.com/v2/rpc-api-key-777',
      CHAIN_ID: '1',
      TOKEN_ADDRESS: 'token-not-an-address-555',
      REGISTRY_ADDRESS: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
      API_PLATFORM_TOKEN: 'short-secret-token-888',
      API_ADMIN_TOKEN: 'another short secret 999 with spaces and enough length',
      API_MAX_AMOUNT: 'max-amount-666',
      ALLOW_MAINNET: 'maybe-444',
    };
    const message = messageOf(() => loadApiConfig(env));
    for (const fragment of [
      'top-secret-db-pw',
      'db.internal',
      'rpc-api-key-777',
      'rpc.example.com',
      'token-not-an-address-555',
      'short-secret-token-888',
      'another short secret',
      'max-amount-666',
      'maybe-444',
    ]) {
      expect(message).not.toContain(fragment);
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('API_ADMIN_TOKEN');
  });
});

describe('loadWorkerConfig', () => {
  it('parses a valid local environment with documented defaults', () => {
    const c = loadWorkerConfig(worker);
    expect(c.settlementKey.reveal()).toBe(KEY_1);
    expect(c.complianceKey.reveal()).toBe(KEY_2);
    expect(c.feeCapWei).toBe(200_000_000_000n);
    expect(c.workerId).toBeUndefined();
    expect(c.pollIntervalMs).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(c.reconcileEveryTicks).toBe(DEFAULT_RECONCILE_EVERY_TICKS);
    expect(c.shutdownTimeoutMs).toBe(DEFAULT_SHUTDOWN_TIMEOUT_MS);
  });

  it('reads the optional variables and lowercases keys', () => {
    const c = loadWorkerConfig({
      ...worker,
      SETTLEMENT_SIGNER_KEY: `0x${'A'.repeat(64)}`,
      WORKER_ID: 'worker-a.1',
      POLL_INTERVAL_MS: '500',
      RECONCILE_EVERY_TICKS: '3',
      SHUTDOWN_TIMEOUT_MS: '5000',
    });
    expect(c.settlementKey.reveal()).toBe(`0x${'a'.repeat(64)}`);
    expect([c.workerId, c.pollIntervalMs, c.reconcileEveryTicks, c.shutdownTimeoutMs]).toEqual([
      'worker-a.1',
      500,
      3,
      5000,
    ]);
  });

  it('lists every missing worker variable (FEE_CAP_WEI has no default: no limit is a choice)', () => {
    expect(
      problemsOf(() => loadWorkerConfig(common))
        .map((p) => p.variable)
        .sort(),
    ).toEqual(['COMPLIANCE_SIGNER_KEY', 'FEE_CAP_WEI', 'SETTLEMENT_SIGNER_KEY']);
  });

  it.each([
    ['SETTLEMENT_SIGNER_KEY', '0x1234', /64 hex/],
    ['FEE_CAP_WEI', '0', /from 1/],
    ['WORKER_ID', 'has spaces', /1 to 64 characters/],
    ['POLL_INTERVAL_MS', '10', /integer from 100/],
    ['RECONCILE_EVERY_TICKS', '0', /integer from 1/],
    ['SHUTDOWN_TIMEOUT_MS', '10', /integer from 1000/],
  ])('%s = %j is refused', (variable, value, reason) => {
    const problems = problemsOf(() => loadWorkerConfig({ ...worker, [variable]: value }));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.variable).toBe(variable);
    expect(problems[0]?.reason).toMatch(reason);
  });

  it('refuses one key for both signers', () => {
    expect(problemsOf(() => loadWorkerConfig({ ...worker, COMPLIANCE_SIGNER_KEY: KEY_1 }))).toEqual(
      [{ variable: 'COMPLIANCE_SIGNER_KEY', reason: 'must differ from SETTLEMENT_SIGNER_KEY' }],
    );
  });

  it('accepts the Anvil development keys on a local chain only', () => {
    const dev = {
      ...worker,
      SETTLEMENT_SIGNER_KEY: ANVIL_DEV_KEYS[0],
      COMPLIANCE_SIGNER_KEY: ANVIL_DEV_KEYS[1],
    };
    expect(loadWorkerConfig(dev).chain.chainClass).toBe('local');
    const problems = problemsOf(() =>
      loadWorkerConfig({ ...dev, CHAIN_ID: '11155111', ALLOW_TESTNET: 'true' }),
    );
    expect(problems).toEqual([
      {
        variable: 'SETTLEMENT_SIGNER_KEY',
        reason: 'is a publicly known development key: refused on a non-local chain',
      },
      {
        variable: 'COMPLIANCE_SIGNER_KEY',
        reason: 'is a publicly known development key: refused on a non-local chain',
      },
    ]);
    // Upper-case spelling of a dev key is the same key.
    const upper = `0x${String(ANVIL_DEV_KEYS[2]).slice(2).toUpperCase()}`;
    expect(
      problemsOf(() =>
        loadWorkerConfig({
          ...worker,
          SETTLEMENT_SIGNER_KEY: upper,
          CHAIN_ID: '1',
          ALLOW_MAINNET: 'true',
        }),
      ).map((p) => p.variable),
    ).toEqual(['SETTLEMENT_SIGNER_KEY']);
  });

  it('refuses mainnet for the worker too, and never prints the keys', () => {
    const env = { ...worker, CHAIN_ID: '1', SETTLEMENT_SIGNER_KEY: `0x${'9'.repeat(63)}` };
    const message = messageOf(() => loadWorkerConfig(env));
    expect(message).toMatch(/ALLOW_MAINNET/);
    expect(message).not.toContain('9'.repeat(63));
    expect(message).not.toContain(KEY_2.slice(2));
  });
});

describe('secretValues', () => {
  it('lists the URLs and the tokens of an API configuration', () => {
    expect(secretValues(loadApiConfig(api))).toEqual([DB, RPC, TOKEN_A, TOKEN_B]);
  });

  it('lists the URLs and the keys of a worker configuration', () => {
    expect(secretValues(loadWorkerConfig(worker))).toEqual([DB, RPC, KEY_1, KEY_2]);
  });
});

describe('assertNodeChainId', () => {
  it('passes on equal ids and refuses different ones', () => {
    expect(() => assertNodeChainId(31337, 31337)).not.toThrow();
    expect(() => assertNodeChainId(31337, 1)).toThrow(ChainIdMismatchConfigError);
    expect(messageOf(() => assertNodeChainId(31337, 1))).toBe(
      'the node reports chain id 1, but CHAIN_ID is 31337: refusing to start',
    );
  });
});
