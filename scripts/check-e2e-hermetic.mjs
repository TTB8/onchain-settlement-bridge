#!/usr/bin/env node
/**
 * @file `pnpm test:e2e:hermetic [--runs N]`: proves the end-to-end suite is hermetic. It must pass
 * next to a developer's own local state and leave that state exactly as it was.
 *
 * 1. Plants, in the REAL `contracts/deployments`, a stale `31337.json` (what an earlier
 *    `pnpm setup:local` leaves) and a `31337.pending.json` (what an aborted deploy leaves). It plants
 *    only files that are not already there: a developer's own files are used as they are and never
 *    replaced.
 * 2. Holds 127.0.0.1:3000 (the API port `pnpm dev` uses) if it is free, so a test that fell back to
 *    the default port would fail instead of passing by luck.
 * 3. Runs `pnpm --filter @bridge/e2e test` N times in a row (default 2).
 * 4. Requires every file under `contracts/deployments` and `contracts/broadcast` to be byte for
 *    byte as it was (sha256, same file set), then removes ONLY the files it planted and releases
 *    the port, on success, failure or Ctrl+C.
 *
 * Exit 0 only when every run passed and nothing changed. Works while the compose stack is up and
 * the dev `bridge` database is populated: the suite uses its own databases, anvils and ports.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deployments = join(root, 'contracts', 'deployments');
const watched = [deployments, join(root, 'contracts', 'broadcast')];

const runsArg = process.argv.indexOf('--runs');
const runs = runsArg === -1 ? 2 : Number(process.argv[runsArg + 1]);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10) {
  console.error('usage: pnpm test:e2e:hermetic [--runs N]   (1 <= N <= 10)');
  process.exit(2);
}

/** path -> sha256 of every file under the watched directories. */
function snapshot() {
  const out = new Map();
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(root, p), createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  };
  for (const d of watched) walk(d);
  return out;
}

const STALE = {
  '31337.json': `${JSON.stringify({ chainId: 31337, note: 'stale record planted by check-e2e-hermetic' })}\n`,
  '31337.pending.json': `${JSON.stringify({ chainId: 31337, note: 'aborted deploy planted by check-e2e-hermetic' })}\n`,
};
const planted = [];
let server = null;
let cleaned = false;

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const p of planted) {
    // Only a file still holding exactly what we wrote is ours to remove.
    if (existsSync(p) && readFileSync(p, 'utf8') === STALE[p.split('/').pop()]) unlinkSync(p);
  }
  server?.close();
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

for (const [name, content] of Object.entries(STALE)) {
  const p = join(deployments, name);
  if (existsSync(p)) {
    console.log(`hermetic: ${relative(root, p)} exists already: using the developer's own file`);
  } else {
    writeFileSync(p, content, { flag: 'wx' });
    planted.push(p);
    console.log(`hermetic: planted ${relative(root, p)}`);
  }
}

server = await new Promise((done) => {
  const s = createServer();
  s.once('error', () => {
    console.log('hermetic: 127.0.0.1:3000 is taken already (pnpm dev?): good, that is the point');
    done(null);
  });
  s.listen(3000, '127.0.0.1', () => {
    console.log('hermetic: holding 127.0.0.1:3000 as pnpm dev would');
    done(s);
  });
});

const before = snapshot();
let failed = 0;
for (let i = 1; i <= runs; i += 1) {
  console.log(`hermetic: run ${i}/${runs}: pnpm --filter @bridge/e2e test`);
  const res = spawnSync('pnpm', ['--filter', '@bridge/e2e', 'test'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    failed += 1;
    console.error(`hermetic: run ${i} FAILED (exit ${res.status ?? res.signal})`);
  }
}
const after = snapshot();
const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
  (k) => before.get(k) !== after.get(k),
);
cleanup();

for (const k of [...before.keys()].sort()) {
  console.log(
    `hermetic: ${after.get(k) === before.get(k) ? 'unchanged' : 'CHANGED  '} ${k} ${before.get(k).slice(0, 16)}`,
  );
}
if (changed.length > 0) console.error(`hermetic: CHANGED or new: ${changed.join(', ')}`);
const ok = failed === 0 && changed.length === 0;
console.log(
  `hermetic: ${ok ? 'OK' : 'FAILED'}: ${runs - failed}/${runs} runs passed, ${changed.length} developer file(s) changed`,
);
process.exit(ok ? 0 : 1);
