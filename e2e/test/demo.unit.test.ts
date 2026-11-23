/**
 * Unit tests of the pure parts of `pnpm demo` (`scripts/lib/demo.ts`): the exit code (never 0
 * for a run that is not clean, `unknown` included), the run description and the amount format.
 * The demo itself runs end to end in local-dev.e2e.test.ts.
 */

import {
  DEMO_WALLETS,
  demoExitCode,
  type DemoFacts,
  describeRun,
  formatTokens,
} from '../../scripts/lib/demo';
import { DEV_ROLE_ADDRESSES } from '../../scripts/lib/local-env';

const clean: DemoFacts = {
  operationsConfirmed: true,
  ledgerMatchesChain: true,
  cleanRun: { status: 'ok', mismatchCount: 0 },
  rogueRequested: false,
  rogueRun: null,
};

describe('demoExitCode', () => {
  it('is 0 only for a clean run', () => {
    expect(demoExitCode(clean)).toBe(0);
  });

  it.each<[string, Partial<DemoFacts>]>([
    ['an operation did not confirm', { operationsConfirmed: false }],
    ['the ledger differs from the chain', { ledgerMatchesChain: false }],
    ['no reconciliation ran', { cleanRun: null }],
    ['a mismatch', { cleanRun: { status: 'mismatch', mismatchCount: 2 } }],
    ['an unknown run', { cleanRun: { status: 'unknown', mismatchCount: 0 } }],
    [
      'an ok status with mismatches (inconsistent: fail closed)',
      { cleanRun: { status: 'ok', mismatchCount: 1 } },
    ],
    ['a status this code does not know', { cleanRun: { status: 'okay', mismatchCount: 0 } }],
  ])('is 1 when %s', (_name, change) => {
    expect(demoExitCode({ ...clean, ...change })).toBe(1);
  });

  it('with --rogue: 0 only when the rogue mint is reported as a balance mismatch', () => {
    const rogue = { ...clean, rogueRequested: true };
    expect(
      demoExitCode({
        ...rogue,
        rogueRun: { status: 'mismatch', kinds: ['unexpected_onchain_event', 'balance_mismatch'] },
      }),
    ).toBe(0);
    expect(demoExitCode({ ...rogue, rogueRun: null })).toBe(1);
    expect(demoExitCode({ ...rogue, rogueRun: { status: 'ok', kinds: [] } })).toBe(1);
    expect(demoExitCode({ ...rogue, rogueRun: { status: 'unknown', kinds: [] } })).toBe(1);
    expect(
      demoExitCode({ ...rogue, rogueRun: { status: 'mismatch', kinds: ['supply_mismatch'] } }),
    ).toBe(1);
    // A dirty clean run fails even if the rogue run is a mismatch.
    expect(
      demoExitCode({
        ...rogue,
        cleanRun: { status: 'mismatch', mismatchCount: 1 },
        rogueRun: { status: 'mismatch', kinds: ['balance_mismatch'] },
      }),
    ).toBe(1);
  });
});

describe('describeRun', () => {
  const base = { clean: false, finalBlock: '42', error: null, mismatches: [] };

  it('CLEAN for ok with zero mismatches', () => {
    expect(describeRun({ ...base, status: 'ok', clean: true, mismatchCount: 0 })).toEqual([
      'CLEAN: 0 mismatches (final block 42)',
    ]);
  });

  it('MISMATCH with one line per mismatch, naming the kind and the facts', () => {
    expect(
      describeRun({
        ...base,
        status: 'mismatch',
        mismatchCount: 2,
        mismatches: [
          {
            kind: 'balance_mismatch',
            detail: { kind: 'balance_mismatch', address: '0xabc', expected: '1', observed: '2' },
          },
          { kind: 'supply_mismatch', detail: { expected: '1', observed: '2' } },
        ],
      }),
    ).toEqual([
      'MISMATCH: 2 mismatches (final block 42)',
      '  - balance_mismatch (address=0xabc, expected=1, observed=2)',
      '  - supply_mismatch (expected=1, observed=2)',
    ]);
    expect(
      describeRun({
        ...base,
        status: 'mismatch',
        mismatchCount: 1,
        mismatches: [{ kind: 'x', detail: {} }],
      })[0],
    ).toBe('MISMATCH: 1 mismatch (final block 42)');
  });

  it('UNKNOWN is never described as clean, even with zero mismatches', () => {
    const lines = describeRun({
      ...base,
      status: 'unknown',
      mismatchCount: 0,
      error: 'read_failed: ChainUnavailableError',
    });
    expect(lines).toEqual(['UNKNOWN: read_failed: ChainUnavailableError (never treated as clean)']);
    expect(describeRun({ ...base, status: 'unknown', mismatchCount: 0 })[0]).toContain(
      'no reason given',
    );
  });
});

describe('formatTokens and the demo wallets', () => {
  it('formats the smallest unit with 6 decimals', () => {
    expect(formatTokens(100_000_000n)).toBe('100.000000');
    expect(formatTokens(1n)).toBe('0.000001');
    expect(formatTokens(0n)).toBe('0.000000');
    expect(formatTokens(-1_500_000n)).toBe('-1.500000');
  });

  it('the demo users are dev accounts #4 and #5, never a signer', () => {
    const signers = Object.values(DEV_ROLE_ADDRESSES) as string[];
    expect(signers).not.toContain(DEMO_WALLETS.alice);
    expect(signers).not.toContain(DEMO_WALLETS.bob);
  });
});
