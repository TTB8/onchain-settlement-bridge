# @bridge/worker

The bridge worker: a NestJS standalone application context (no HTTP server) that builds the viem
gateway with both signer keys and the `BridgeEngine` from validated environment variables, and
runs the engine loop (`start()`: dispatch, index, monitor, compliance, reconcile) until SIGTERM /
SIGINT.

## Run

```bash
docker compose up -d postgres anvil
cp .env.example .env      # DEV ONLY Anvil keys, labelled as such
pnpm dev                  # api + worker; or only this app:
pnpm --filter @bridge/worker start
```

The database needs an ACTIVE `deployment` row for `CHAIN_ID` whose token and registry are
`TOKEN_ADDRESS` / `REGISTRY_ADDRESS`, with `signer_state` rows holding the addresses of
`SETTLEMENT_SIGNER_KEY` and `COMPLIANCE_SIGNER_KEY` (the local setup script of phase 3b writes
them). Connect as a **non-owner** database role in production (see `apps/api/README.md`).

## Startup: every refusal exits 1 with one log line saying why

1. The environment (`packages/engine/src/env.ts`): every invalid variable listed, never a value;
   mainnet / testnet / unknown chains refused unless `ALLOW_MAINNET` / `ALLOW_TESTNET` /
   `ALLOW_UNKNOWN_CHAIN` is `true`; Anvil's ten public development keys refused on any non-local
   chain; the two signer keys must differ (each signer has its own nonce sequence);
   `FEE_CAP_WEI` is required.
2. The node's chain id must equal `CHAIN_ID`.
3. The engine's constructor: the gateway's deployment must be the configured token.
4. `engine.assertDeployment()`: the database's active deployment must be the gateway's token AND
   registry (`deployment_mismatch` alarm + "refusing to run: the deployment binding does not
   match").
5. The recorded signer addresses must be the configured keys' addresses.

## Running and stopping

- Alarms are written as structured `warn` lines (`msg: "alarm"`, kind, detail, ids), redacted with
  the engine's `sanitizeText` and every configured secret (database URL, RPC URL, both keys).
- `deployment_mismatch`, `chain_mismatch` and `reorg_beyond_window` while running are **fatal**:
  the engine already refuses the affected work (a mismatch makes every tick throw; a reorg deeper
  than the indexer window halts the indexer on every pass), so the worker stops and exits 1 with
  a line naming what a person must fix, instead of looping on the same alarm.
- **Alarms are log lines only.** There is no transport (no pager, no webhook, no table): ship the
  worker's stdout to a log pipeline and alert on `"msg":"alarm"`, or wire a real `AlarmSink`.
- **The non-owner database role is not enforced by the app** (see `apps/api/README.md`): it is an
  operator obligation.
- **`pnpm dev` runs both apps with ONE environment**, so locally the API process also holds the
  signer keys in its environment (it never reads them). In production give each process its own
  environment: the API must not have `SETTLEMENT_SIGNER_KEY` / `COMPLIANCE_SIGNER_KEY` at all.
- SIGTERM / SIGINT: stop scheduling ticks, wait for the tick in progress (bounded by
  `SHUTDOWN_TIMEOUT_MS`, default 30 s; past it exit 1), then close the context (Prisma
  disconnects). Exit 0 after a clean stop. Cutting a tick short is safe (commit before broadcast,
  leases expire), but it is reported as unclean.
- Several workers may run against one database (outbox leases, `SKIP LOCKED`); `WORKER_ID`
  labels each (default `<hostname>:<pid>`).

## Tests

`pnpm --filter @bridge/worker test` / `test:cov` (thresholds 90 / 85 / 95 / 90).

| Property                                                    | Test (file: name)                                         |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| Start, SIGTERM / SIGINT, exit 0, handlers detached          | runner: "starts the loop, and SIGTERM ...", "SIGINT ..."  |
| In-flight tick awaited on shutdown                          | runner: "waits for the tick in progress before resolving" |
| Shutdown timeout -> exit 1                                  | runner: "a tick that outlives the shutdown timeout exits 1" |
| Deployment mismatch at startup -> exit 1, loop never started | runner: "refuses to run ..."; worker: "refuses to run when no deployment is registered", "... another token ..." |
| Signer mismatch -> exit 1                                   | worker: "refuses to run when the recorded signer is not the configured key" |
| Fatal alarm while running -> exit 1                         | runner: "a fatal alarm while running ..."; worker: "exits 1 when the deployment is deactivated while it runs" |
| Real engine loop, clean exit, Prisma closed, no secret logged | worker: "runs the real engine loop until SIGTERM ..."    |
| Env refusal, node chain id                                  | worker: "refuses an invalid environment ...", "refuses a node on another chain ..." |
| `.env.example` valid for both apps, DEV keys only            | env-example (3)                                           |
