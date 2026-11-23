#!/usr/bin/env node
/**
 * @file `pnpm dev`: runs the API and the worker side by side against the local Postgres and Anvil.
 *
 * 1. Loads `.env` from the repository root (copy `.env.example`; it is never committed).
 * 2. Checks that Postgres and the node answer, and prints what to start if they do not (never the
 *    URLs themselves: they can carry a password or an API key; only host and port).
 * 3. Starts `@bridge/api` and `@bridge/worker` with that environment, each line prefixed with its
 *    name; Ctrl+C (SIGINT) or SIGTERM is forwarded to both, and when one exits the other is
 *    stopped and `pnpm dev` exits with the first one's code.
 *
 * Both processes validate the environment themselves (packages/engine/src/env.ts): this script
 * only checks reachability so that a stopped container gives a one-line answer, not a stack.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(root, '.env');

if (!existsSync(envFile)) {
  console.error('dev: no .env file. Copy the template first:  cp .env.example .env');
  process.exit(1);
}
process.loadEnvFile(envFile);

/** host:port of a URL, or null when it does not parse (the value itself is never printed). */
function endpoint(value, defaultPort) {
  try {
    const u = new URL(value ?? '');
    return { host: u.hostname, port: Number(u.port || defaultPort) };
  } catch {
    return null;
  }
}

function tcpReachable({ host, port }, timeoutMs = 2000) {
  return new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (ok) => {
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function nodeAnswers(url, timeoutMs = 2000) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    return typeof body?.result === 'string';
  } catch {
    return false;
  }
}

const problems = [];
const db = endpoint(process.env.DATABASE_URL, 5432);
if (db === null) problems.push('DATABASE_URL is missing or not a URL (see .env.example)');
else if (!(await tcpReachable(db))) {
  problems.push(
    `Postgres is not reachable at ${db.host}:${db.port}. Start it:  docker compose up -d postgres`,
  );
}
const rpc = endpoint(process.env.RPC_URL, 8545);
if (rpc === null) problems.push('RPC_URL is missing or not a URL (see .env.example)');
else if (!(await nodeAnswers(process.env.RPC_URL))) {
  problems.push(
    `No JSON-RPC node answers at ${rpc.host}:${rpc.port}. Start Anvil:  docker compose up -d anvil`,
  );
}
if (problems.length > 0) {
  console.error(`dev: not starting:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

const children = new Map();
let exiting = false;

function prefixLines(name, stream, out) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) out.write(`[${name}] ${line}\n`);
  });
  stream.on('end', () => {
    if (buffer.length > 0) out.write(`[${name}] ${buffer}\n`);
  });
}

function stopAll(signal) {
  for (const child of children.values()) if (child.exitCode === null) child.kill(signal);
}

// Each app is started the way its `start` script does (from source through ts-node, no package
// manager in between, so signals reach the process itself).
const START = [
  '-r',
  'ts-node/register/transpile-only',
  '-r',
  'tsconfig-paths/register',
  'src/main.ts',
];
for (const name of ['api', 'worker']) {
  const child = spawn(process.execPath, START, {
    cwd: resolve(root, 'apps', name),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.set(name, child);
  prefixLines(name, child.stdout, process.stdout);
  prefixLines(name, child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    if (exiting) return;
    exiting = true;
    console.error(`dev: ${name} exited (${signal ?? `code ${code}`}); stopping the other process`);
    if (name === 'worker' && code === 1) {
      console.error(
        'dev: a worker exit 1 at startup usually means no ACTIVE deployment row matches TOKEN_ADDRESS /\n' +
          '     REGISTRY_ADDRESS, or its signer rows are not the configured keys (see apps/worker/README.md).',
      );
    }
    stopAll('SIGTERM');
    process.exitCode = code ?? 1;
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    exiting = true;
    stopAll(signal);
  });
}
