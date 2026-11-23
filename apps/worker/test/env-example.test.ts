/**
 * The committed `.env.example` must be a valid configuration for BOTH processes (so `pnpm dev`
 * works after `cp .env.example .env`), on a local chain, with only DEV values in it.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

import {
  ANVIL_DEV_KEYS,
  type ConfigError,
  loadApiConfig,
  loadWorkerConfig,
} from '@bridge/engine/env';

const text = readFileSync(resolve(__dirname, '..', '..', '..', '.env.example'), 'utf8');
const env = parseEnv(text) as Record<string, string>;

describe('.env.example', () => {
  it('is accepted by the api and the worker, on a local chain', () => {
    expect(loadApiConfig(env).chain.chainClass).toBe('local');
    expect(loadWorkerConfig(env).chain.chainClass).toBe('local');
  });

  it('carries only Anvil development keys, labelled DEV ONLY, and refuses every real-chain flag', () => {
    expect(ANVIL_DEV_KEYS).toContain(env.SETTLEMENT_SIGNER_KEY);
    expect(ANVIL_DEV_KEYS).toContain(env.COMPLIANCE_SIGNER_KEY);
    expect(text).toMatch(/DEV ONLY: these are Anvil's well-known default accounts/);
    expect([env.ALLOW_TESTNET, env.ALLOW_MAINNET, env.ALLOW_UNKNOWN_CHAIN]).toEqual([
      'false',
      'false',
      'false',
    ]);
    // The same file pointed at a real chain is refused: the dev keys are public.
    expect(() => loadWorkerConfig({ ...env, CHAIN_ID: '11155111', ALLOW_TESTNET: 'true' })).toThrow(
      /publicly known development key/,
    );
  });

  it.each([
    ['mainnet', { CHAIN_ID: '1', ALLOW_MAINNET: 'true' }],
    ['testnet', { CHAIN_ID: '11155111', ALLOW_TESTNET: 'true' }],
  ])('copied unchanged to a %s, its example tokens are refused by the api', (_name, chain) => {
    let problems: { variable: string; reason: string }[] = [];
    try {
      loadApiConfig({ ...env, ...chain });
    } catch (err) {
      problems = [...(err as ConfigError).problems];
    }
    expect(problems).toEqual([
      {
        variable: 'API_PLATFORM_TOKEN',
        reason: 'is a placeholder development token: refused on a non-local chain',
      },
      {
        variable: 'API_ADMIN_TOKEN',
        reason: 'is a placeholder development token: refused on a non-local chain',
      },
    ]);
  });

  it('documents every variable either process reads', () => {
    for (const name of [
      'DATABASE_URL',
      'RPC_URL',
      'CHAIN_ID',
      'ALLOW_TESTNET',
      'ALLOW_MAINNET',
      'ALLOW_UNKNOWN_CHAIN',
      'TOKEN_ADDRESS',
      'REGISTRY_ADDRESS',
      'CONFIRMATION_DEPTH',
      'RPC_TIMEOUT_MS',
      'LOG_LEVEL',
      'API_HOST',
      'API_PORT',
      'API_PLATFORM_TOKEN',
      'API_ADMIN_TOKEN',
      'API_MAX_AMOUNT',
      'API_BODY_LIMIT_BYTES',
      'API_DOCS_ENABLED',
      'SETTLEMENT_SIGNER_KEY',
      'COMPLIANCE_SIGNER_KEY',
      'FEE_CAP_WEI',
      'WORKER_ID',
      'POLL_INTERVAL_MS',
      'RECONCILE_EVERY_TICKS',
      'SHUTDOWN_TIMEOUT_MS',
    ]) {
      expect({ name, documented: new RegExp(`^#? ?${name}=`, 'm').test(text) }).toEqual({
        name,
        documented: true,
      });
    }
  });
});
