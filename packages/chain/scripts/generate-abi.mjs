#!/usr/bin/env node
/**
 * @file Writes the contract ABIs into `src/abi/` as typed `as const` TypeScript modules, straight
 * from the Foundry build (`forge inspect <Contract> abi --json`, run in `contracts/`).
 *
 *   node scripts/generate-abi.mjs           regenerate the files
 *   node scripts/generate-abi.mjs --check   regenerate in memory and exit 1 if a committed file
 *                                           differs (CI runs this, so the ABIs can never drift
 *                                           from the contracts)
 *
 * The output is formatted with the repository's Prettier config so that `format:check` and
 * `abi:check` agree on every byte.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, '..');
const repoRoot = resolve(packageDir, '..', '..');
const contractsDir = join(repoRoot, 'contracts');
const abiDir = join(packageDir, 'src', 'abi');

/** The contracts whose ABIs the gateway needs, and the module each one is written to. */
const CONTRACTS = [
  { name: 'SettlementToken', file: 'settlement-token.ts', exportName: 'settlementTokenAbi' },
  {
    name: 'ComplianceRegistry',
    file: 'compliance-registry.ts',
    exportName: 'complianceRegistryAbi',
  },
];

/** Finds `forge` on PATH, or in Foundry's default install folder. */
function forgeBinary() {
  const fallback = join(homedir(), '.foundry', 'bin', 'forge');
  try {
    execFileSync('forge', ['--version'], { stdio: 'ignore' });
    return 'forge';
  } catch {
    if (existsSync(fallback)) return fallback;
    throw new Error('forge was not found on PATH or in ~/.foundry/bin; install Foundry first');
  }
}

/** The ABI of one contract, as forge reports it. */
function inspectAbi(forge, contractName) {
  const out = execFileSync(forge, ['inspect', contractName, 'abi', '--json'], {
    cwd: contractsDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const abi = JSON.parse(out);
  if (!Array.isArray(abi) || abi.length === 0) {
    throw new Error(`forge inspect returned no ABI for ${contractName}`);
  }
  return abi;
}

/** The TypeScript module for one ABI, before formatting. */
function moduleSource({ name, exportName }, abi) {
  return [
    '/**',
    ` * @file ABI of the ${name} contract, generated from the Foundry build by`,
    ' * `pnpm --filter @bridge/chain abi:generate`. Do not edit by hand: `abi:check` fails when this',
    ' * file differs from what the generator writes.',
    ' */',
    '',
    `/** The ${name} ABI, exactly as \`forge inspect ${name} abi\` reports it. */`,
    `export const ${exportName} = ${JSON.stringify(abi, null, 2)} as const;`,
    '',
  ].join('\n');
}

/** The barrel module that re-exports every ABI. */
function indexSource() {
  const lines = [
    '/**',
    ' * @file The contract ABIs, generated from the Foundry build. Do not edit by hand.',
    ' */',
    '',
    ...CONTRACTS.map((c) => `export { ${c.exportName} } from './${c.file.replace(/\.ts$/, '')}';`),
    '',
  ];
  return lines.join('\n');
}

/** Formats TypeScript source with the repository's Prettier config. */
async function format(source, filePath) {
  const prettier = await import('prettier');
  const options = (await prettier.resolveConfig(filePath)) ?? {};
  return prettier.format(source, { ...options, filepath: filePath });
}

async function main() {
  const check = process.argv.includes('--check');
  const forge = forgeBinary();

  const outputs = [];
  for (const contract of CONTRACTS) {
    const abi = inspectAbi(forge, contract.name);
    const filePath = join(abiDir, contract.file);
    outputs.push({ filePath, content: await format(moduleSource(contract, abi), filePath) });
  }
  const indexPath = join(abiDir, 'index.ts');
  outputs.push({ filePath: indexPath, content: await format(indexSource(), indexPath) });

  if (check) {
    const stale = outputs.filter(
      ({ filePath, content }) =>
        !existsSync(filePath) || readFileSync(filePath, 'utf8') !== content,
    );
    if (stale.length > 0) {
      for (const { filePath } of stale) console.error(`abi:check: out of date: ${filePath}`);
      console.error(
        'abi:check: run `pnpm --filter @bridge/chain abi:generate` and commit the result',
      );
      process.exit(1);
    }
    console.log(`abi:check: ${outputs.length} files match the Foundry build`);
    return;
  }

  mkdirSync(abiDir, { recursive: true });
  for (const { filePath, content } of outputs) writeFileSync(filePath, content);
  console.log(`abi:generate: wrote ${outputs.length} files to ${abiDir}`);
}

main().catch((error) => {
  console.error(`abi: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
