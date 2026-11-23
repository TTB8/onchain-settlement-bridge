// Prints a Markdown coverage table from the json-summary files Jest writes.
// CI appends the output to the run summary:  node scripts/coverage-summary.mjs >> "$GITHUB_STEP_SUMMARY"
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packages = [
  ['domain (pure bridge rules)', 'packages/domain'],
  ['chain (gateway, fake and viem)', 'packages/chain'],
  ['db (schema and SQL guards)', 'packages/db'],
  ['engine (outbox, submitter, indexer, reconciler)', 'packages/engine'],
  ['api', 'apps/api'],
  ['worker', 'apps/worker'],
];

const pct = (metric) => `${metric.pct}%`;
const rows = [];
for (const [label, dir] of packages) {
  const file = join(root, dir, 'coverage', 'coverage-summary.json');
  if (!existsSync(file)) {
    if (existsSync(join(root, dir, 'package.json'))) rows.push(`| ${label} | not run | | | |`);
    continue;
  }
  const { total } = JSON.parse(readFileSync(file, 'utf8'));
  rows.push(
    `| ${label} | ${pct(total.statements)} | ${pct(total.branches)} | ${pct(total.functions)} | ${pct(total.lines)} |`,
  );
}

console.log('### Test coverage\n');
console.log('| Package | Statements | Branches | Functions | Lines |');
console.log('| --- | ---: | ---: | ---: | ---: |');
console.log(rows.join('\n'));
