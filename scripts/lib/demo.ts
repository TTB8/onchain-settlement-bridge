/**
 * @file `pnpm demo`, the steps: drives the running bridge (`pnpm dev`) through its PUBLIC HTTP API
 * only, the way a platform backend and an operator would, and checks the result against the
 * chain.
 *
 * 1. `/ready` must answer 200 (else: "start pnpm dev").
 * 2. Two users with Anvil dev wallets #4 and #5 (`POST /v1/users`; a re-run gets the same users),
 *    both allowed through the admin route (`POST /v1/admin/compliance-changes`, idempotent per
 *    wallet), waiting until each change is `confirmed`.
 * 3. deposit (alice) -> transfer (alice -> bob) -> withdrawal (bob), each waited for until
 *    `confirmed`, printing every status it passes through and its transaction hash(es), the
 *    confirming one with its block (`mined in block N`).
 * 4. Both users' ledger balance (`expectedOnChain`) next to the token's `balanceOf` on the node.
 * 5. `POST /v1/admin/reconciliations`: `CLEAN: 0 mismatches`, or the mismatches. A run that is
 *    `unknown` (the index has not caught up yet) is retried until the deadline; `unknown` is never
 *    reported as clean.
 * 6. `--rogue`: the dev MINTER account (unlocked on Anvil) mints directly on the token, outside the
 *    bridge, and the demo shows the reconciler catching it (mismatch kinds printed). This leaves the
 *    local chain permanently out of line with the ledger: reset with
 *    `docker compose restart anvil && pnpm setup:local --reset-db`.
 *
 * Exit code (`demoExitCode`): 0 only when every operation confirmed, the ledger equals the chain,
 * and the reconciliation was CLEAN (and, with `--rogue`, the rogue mint was then reported as a
 * mismatch). Never prints a token, a key or a URL with credentials.
 */

import { DEV_ROLE_ADDRESSES } from './local-env';
import { calldata, type Rpc, SELECTORS } from './rpc';

/** DEV ONLY: Anvil's public dev accounts #4 and #5, the demo's two users. */
export const DEMO_WALLETS = {
  alice: '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65',
  bob: '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc',
} as const;

/** The amounts the demo moves (smallest unit, 6 decimals). */
export const DEMO_AMOUNTS = {
  deposit: 100_000_000n,
  transfer: 40_000_000n,
  withdrawal: 15_000_000n,
  rogue: 5_000_000n,
} as const;

/** What the demo needs (from `.env` in the CLI; from the test stack in the e2e suite). */
export interface DemoOptions {
  /** The API base URL, e.g. http://127.0.0.1:3000. */
  readonly apiUrl: string;
  /** API_PLATFORM_TOKEN (never printed). */
  readonly platformToken: string;
  /** API_ADMIN_TOKEN (never printed). */
  readonly adminToken: string;
  /** JSON-RPC on the node. */
  readonly rpc: Rpc;
  /** TOKEN_ADDRESS. */
  readonly tokenAddress: string;
  /** Also run the rogue mint. */
  readonly rogue: boolean;
  /** How long to wait for each operation / reconciliation (ms). */
  readonly timeoutMs: number;
  /** Delay between polls (ms). */
  readonly pollMs: number;
  /** A unique id for this run's idempotency keys. */
  readonly runId: string;
  /** Where lines go. */
  readonly log: (line: string) => void;
}

/** The facts the exit code is decided from. */
export interface DemoFacts {
  /** Every operation reached `confirmed`. */
  readonly operationsConfirmed: boolean;
  /** Ledger expectedOnChain == balanceOf for both users. */
  readonly ledgerMatchesChain: boolean;
  /** Status of the reconciliation after the clean flow (null: none could be run). */
  readonly cleanRun: { readonly status: string; readonly mismatchCount: number } | null;
  /** Whether --rogue was asked for. */
  readonly rogueRequested: boolean;
  /** Status of the reconciliation after the rogue mint (null: not run or not reached). */
  readonly rogueRun: { readonly status: string; readonly kinds: readonly string[] } | null;
}

/**
 * The exit code: 0 only for a fully clean run (and a caught rogue mint when asked for), 1
 * otherwise. `unknown` is never clean; a clean run needs status `ok` AND zero mismatches.
 *
 * @param f The facts.
 */
export function demoExitCode(f: DemoFacts): 0 | 1 {
  if (!f.operationsConfirmed || !f.ledgerMatchesChain) return 1;
  if (f.cleanRun === null || f.cleanRun.status !== 'ok' || f.cleanRun.mismatchCount !== 0) {
    return 1;
  }
  if (!f.rogueRequested) return 0;
  if (f.rogueRun === null || f.rogueRun.status !== 'mismatch') return 1;
  // Caught means: the balance it moved is reported, not just any mismatch.
  return f.rogueRun.kinds.includes('balance_mismatch') ? 0 : 1;
}

/**
 * Smallest unit -> "100.000000".
 *
 * @param amount The amount.
 */
export function formatTokens(amount: bigint): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/** A reconciliation run, as the API returns it (the fields the demo uses). */
export interface RunBody {
  /** ok, mismatch or unknown. */
  readonly status: string;
  /** True only for ok with zero mismatches. */
  readonly clean: boolean;
  /** How many. */
  readonly mismatchCount: number;
  /** The final block compared at. */
  readonly finalBlock: string | null;
  /** Why unknown. */
  readonly error: string | null;
  /** The mismatches. */
  readonly mismatches: readonly { kind: string; detail: Record<string, unknown> }[];
}

/**
 * The lines that describe one run: `CLEAN: 0 mismatches`, `MISMATCH: n mismatches` with one line
 * per mismatch, or `UNKNOWN: <why>`.
 *
 * @param run The run.
 */
export function describeRun(run: RunBody): string[] {
  if (run.status === 'ok' && run.mismatchCount === 0) {
    return [`CLEAN: 0 mismatches (final block ${run.finalBlock ?? '?'})`];
  }
  if (run.status === 'mismatch') {
    return [
      `MISMATCH: ${run.mismatchCount} mismatch${run.mismatchCount === 1 ? '' : 'es'} (final block ${run.finalBlock ?? '?'})`,
      ...run.mismatches.map((m) => {
        const d = m.detail;
        const parts = ['address', 'expected', 'observed', 'why', 'kind']
          .filter((k) => d[k] !== undefined && !(k === 'kind' && d[k] === m.kind))
          .map((k) => `${k}=${String(d[k])}`);
        return `  - ${m.kind}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
      }),
    ];
  }
  return [`UNKNOWN: ${run.error ?? 'no reason given'} (never treated as clean)`];
}

/** One entry of an operation's `transactions`, as the API returns it. */
export interface TxView {
  /** Hash. */
  readonly hash: string;
  /** Nonce. */
  readonly nonce: number;
  /** mined for the confirming transaction; otherwise the last broadcast status. */
  readonly status: string;
  /** The confirming block (decimal string) for the mined one; null otherwise. */
  readonly blockNumber: string | null;
}

/**
 * `tx 0x… (nonce 3, mined in block 14)`, or `tx 0x… (nonce 3, sent)` for a transaction that did
 * not settle the operation (a replaced bump, for example).
 *
 * @param tx The transaction.
 */
export function describeTransaction(tx: TxView): string {
  const where = tx.blockNumber !== null ? ` in block ${tx.blockNumber}` : '';
  return `tx ${tx.hash} (nonce ${tx.nonce}, ${tx.status}${where})`;
}

/** A failure the demo explains in one line and stops on. */
export class DemoError extends Error {}

/** One HTTP call to the API. */
async function api(
  o: DemoOptions,
  scope: 'platform' | 'admin' | 'none',
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  idempotencyKey?: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> {
  const token = scope === 'platform' ? o.platformToken : scope === 'admin' ? o.adminToken : null;
  let res: Response;
  try {
    res = await fetch(`${o.apiUrl}${path}`, {
      method,
      headers: {
        ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(idempotencyKey !== undefined ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new DemoError(`the API does not answer at ${o.apiUrl}: is \`pnpm dev\` running?`);
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

function expectStatus(what: string, res: { status: number; body: unknown }, ok: number[]): void {
  if (!ok.includes(res.status)) {
    const code = (res.body as { code?: string } | null)?.code ?? 'no problem code';
    throw new DemoError(`${what}: HTTP ${res.status} (${code})`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs the demo. Resolves with the exit code; never prints a secret.
 *
 * @param o Options.
 */
export async function runDemo(o: DemoOptions): Promise<0 | 1> {
  const log = o.log;
  const facts: {
    operationsConfirmed: boolean;
    ledgerMatchesChain: boolean;
    cleanRun: DemoFacts['cleanRun'];
    rogueRun: DemoFacts['rogueRun'];
  } = { operationsConfirmed: false, ledgerMatchesChain: false, cleanRun: null, rogueRun: null };
  const verdict = () => demoExitCode({ ...facts, rogueRequested: o.rogue });

  try {
    // 1. Ready.
    const deadline = Date.now() + o.timeoutMs;
    for (;;) {
      const ready = await api(o, 'none', 'GET', '/ready');
      if (ready.status === 200) break;
      if (Date.now() > deadline) {
        const checks = JSON.stringify(ready.body?.checks ?? {});
        throw new DemoError(`the API is not ready (${checks}): did pnpm setup:local run?`);
      }
      await sleep(o.pollMs);
    }
    log(`API ${o.apiUrl} is ready`);

    // 2. Users, allowed.
    const users: Record<'alice' | 'bob', { id: string; walletAddress: string }> = {
      alice: { id: '', walletAddress: '' },
      bob: { id: '', walletAddress: '' },
    };
    for (const name of ['alice', 'bob'] as const) {
      const res = await api(o, 'platform', 'POST', '/v1/users', {
        walletAddress: DEMO_WALLETS[name],
      });
      expectStatus(`create ${name}`, res, [200, 201]);
      users[name] = res.body;
      log(
        `user ${name}: ${res.body.walletAddress} (id ${res.body.id})${res.status === 200 ? ', already registered' : ''}`,
      );
    }
    for (const name of ['alice', 'bob'] as const) {
      const res = await api(
        o,
        'admin',
        'POST',
        '/v1/admin/compliance-changes',
        { action: 'allow', walletAddress: users[name].walletAddress, reason: 'demo: kyc passed' },
        `demo-allow-${users[name].walletAddress}`,
      );
      expectStatus(`allow ${name}`, res, [200, 201]);
      const change = await waitFor(
        o,
        `allow ${name}`,
        () => api(o, 'admin', 'GET', `/v1/admin/compliance-changes/${res.body.id}`),
        ['confirmed'],
        ['failed'],
      );
      log(`allow ${name}: ${change.status} (block ${change.confirmedBlock ?? '?'})`);
    }

    // 3. Operations.
    const before: Record<string, bigint> = {};
    for (const name of ['alice', 'bob'] as const) {
      const b = await api(o, 'platform', 'GET', `/v1/users/${users[name].id}/balances`);
      before[name] = BigInt(b.body.expectedOnChain);
    }
    const ops: [string, string, Record<string, unknown>][] = [
      [
        `deposit ${formatTokens(DEMO_AMOUNTS.deposit)} to alice`,
        `/v1/users/${users.alice.id}/deposits`,
        { amount: DEMO_AMOUNTS.deposit.toString() },
      ],
      [
        `transfer ${formatTokens(DEMO_AMOUNTS.transfer)} alice -> bob`,
        `/v1/users/${users.alice.id}/transfers`,
        { amount: DEMO_AMOUNTS.transfer.toString(), toUserId: users.bob.id },
      ],
      [
        `withdrawal ${formatTokens(DEMO_AMOUNTS.withdrawal)} by bob`,
        `/v1/users/${users.bob.id}/withdrawals`,
        { amount: DEMO_AMOUNTS.withdrawal.toString() },
      ],
    ];
    for (const [i, [what, path, body]] of ops.entries()) {
      const res = await api(o, 'platform', 'POST', path, body, `demo-${o.runId}-${i}`);
      expectStatus(what, res, [201]);
      const seen: string[] = [res.body.status];
      const op = await waitFor(
        o,
        what,
        () => api(o, 'platform', 'GET', `/v1/operations/${res.body.id}`),
        ['confirmed'],
        ['failed', 'reversed'],
        (s) => {
          if (seen[seen.length - 1] !== s) seen.push(s);
        },
      );
      log(`${what}: ${seen.join(' -> ')} (block ${op.confirmedBlock})`);
      for (const tx of op.transactions as TxView[]) log(`  ${describeTransaction(tx)}`);
    }
    facts.operationsConfirmed = true;

    // 4. Ledger next to chain.
    log('balances (ledger expectedOnChain | on chain):');
    let match = true;
    const expected: Record<string, bigint> = {
      alice: (before.alice as bigint) + DEMO_AMOUNTS.deposit - DEMO_AMOUNTS.transfer,
      bob: (before.bob as bigint) + DEMO_AMOUNTS.transfer - DEMO_AMOUNTS.withdrawal,
    };
    for (const name of ['alice', 'bob'] as const) {
      const b = await api(o, 'platform', 'GET', `/v1/users/${users[name].id}/balances`);
      const ledger = BigInt(b.body.expectedOnChain);
      const chain = await o.rpc.balanceOf(o.tokenAddress, users[name].walletAddress);
      const ok = ledger === chain && ledger === expected[name];
      match &&= ok;
      log(
        `  ${name.padEnd(5)} ${formatTokens(ledger).padStart(14)} | ${formatTokens(chain).padStart(14)}  ${ok ? 'equal' : 'DIFFERENT'}`,
      );
    }
    facts.ledgerMatchesChain = match;

    // 5. Reconciliation.
    const clean = await reconcileUntil(o, ['ok', 'mismatch']);
    facts.cleanRun = { status: clean.status, mismatchCount: clean.mismatchCount };
    log('reconciliation:');
    for (const line of describeRun(clean)) log(`  ${line}`);

    // 6. Rogue.
    if (o.rogue) {
      if (facts.cleanRun.status !== 'ok') {
        log('--rogue skipped: the reconciliation was not clean to begin with');
      } else {
        const ref = `0x${Buffer.from(`demo-rogue-${o.runId}`).toString('hex').padEnd(64, '0').slice(0, 64)}`;
        log(
          `rogue: the dev minter ${DEV_ROLE_ADDRESSES.settlement} mints ${formatTokens(DEMO_AMOUNTS.rogue)} to alice directly on the token, outside the bridge`,
        );
        const tx = await o.rpc.sendUnlocked({
          from: DEV_ROLE_ADDRESSES.settlement,
          to: o.tokenAddress,
          data: calldata(SELECTORS.mint, users.alice.walletAddress, DEMO_AMOUNTS.rogue, ref),
        });
        log(`  tx ${tx.hash} (${tx.success ? 'mined' : 'REVERTED'} in block ${tx.blockNumber})`);
        if (tx.success) {
          const caught = await reconcileUntil(o, ['mismatch']);
          facts.rogueRun = { status: caught.status, kinds: caught.mismatches.map((m) => m.kind) };
          log('reconciliation after the rogue mint:');
          for (const line of describeRun(caught)) log(`  ${line}`);
          if (caught.status === 'mismatch') {
            log('the reconciler caught the mint that bypassed the bridge.');
            log(
              'the local chain now disagrees with the ledger for good: reset with  docker compose restart anvil && pnpm setup:local --reset-db',
            );
          }
        }
      }
    }
  } catch (err) {
    if (!(err instanceof DemoError)) throw err;
    log(`demo: ${err.message}`);
  }
  const code = verdict();
  log(code === 0 ? 'demo: OK' : 'demo: FAILED (see above)');
  return code;
}

/** Polls a resource until its `status` is one of `done` (resolves) or `bad` (DemoError). */
async function waitFor(
  o: DemoOptions,
  what: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  read: () => Promise<{ status: number; body: any }>,
  done: string[],
  bad: string[],
  onStatus: (s: string) => void = () => undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const deadline = Date.now() + o.timeoutMs;
  for (;;) {
    const res = await read();
    expectStatus(what, res, [200]);
    onStatus(res.body.status);
    if (done.includes(res.body.status)) return res.body;
    if (bad.includes(res.body.status)) {
      throw new DemoError(
        `${what} ended ${res.body.status}${res.body.failureReason ? ` (${res.body.failureReason})` : ''}`,
      );
    }
    if (Date.now() > deadline) {
      throw new DemoError(
        `${what} is still ${res.body.status} after ${o.timeoutMs} ms: is the worker running (pnpm dev)?`,
      );
    }
    await sleep(o.pollMs);
  }
}

/**
 * Runs reconciliations until one ends in `want` (an `unknown` run, e.g. the index one block
 * behind, is retried) or the deadline passes; returns the last run either way.
 */
async function reconcileUntil(o: DemoOptions, want: string[]): Promise<RunBody> {
  const deadline = Date.now() + o.timeoutMs;
  for (;;) {
    const res = await api(o, 'admin', 'POST', '/v1/admin/reconciliations');
    expectStatus('reconciliation', res, [200]);
    const run = res.body as RunBody;
    if (want.includes(run.status) || Date.now() > deadline) return run;
    await sleep(o.pollMs);
  }
}
