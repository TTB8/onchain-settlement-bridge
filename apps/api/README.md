# @bridge/api

The bridge's HTTP API (NestJS 11, Express): users, deposits, withdrawals, transfers, balances,
compliance requests and reconciliation runs, on top of `@bridge/engine`. It **holds no signing
key**: it reserves funds and enqueues chain calls in the database (the worker signs and sends),
and its chain gateway is read-only (`src/chain/read-only-gateway.ts`).

## Run

```bash
docker compose up -d postgres anvil
cp .env.example .env              # DEV ONLY values; every variable is documented there
pnpm dev                          # api + worker; or only this app:
pnpm --filter @bridge/api start
```

Startup fails fast, before serving a request: the environment is validated (every problem listed
by name, never a value; `packages/engine/src/env.ts`), a mainnet / testnet / unknown chain is
refused unless its `ALLOW_*` flag is `true`, and the node must report `CHAIN_ID`.

OpenAPI: `GET /docs` (UI) and `GET /docs/openapi.json` (`API_DOCS_ENABLED=false` turns both off).

## Operators: connect as a NON-OWNER database role

The ledger's guarantees (balanced entries, no overdraft, append-only history, legal transitions)
are SQL triggers and constraints in `packages/db/prisma/migrations`. **The table owner (and any
superuser) can disable triggers.** In production, run migrations as the owner, and give the API
and the worker a `DATABASE_URL` for a separate role that owns nothing and has only the
`SELECT` / `INSERT` / `UPDATE` grants the engine needs. Role management is not part of this repo.

## Routes

| Method | Path                                    | Scope    | What                                                        |
| ------ | --------------------------------------- | -------- | ----------------------------------------------------------- |
| POST   | `/v1/users`                             | platform | Create a user with their wallet (+ three ledger accounts)   |
| GET    | `/v1/users/:userId`                     | platform | Read a user                                                 |
| POST   | `/v1/users/:userId/deposits`            | platform | Deposit (fiat received; mint). `Idempotency-Key` required   |
| POST   | `/v1/users/:userId/withdrawals`         | platform | Withdrawal (burn; pay out). `Idempotency-Key` required      |
| POST   | `/v1/users/:userId/transfers`           | platform | Transfer to `toUserId`. `Idempotency-Key` required          |
| GET    | `/v1/users/:userId/operations`          | platform | The user's operations (owner or recipient), newest first    |
| GET    | `/v1/users/:userId/balances`            | platform | available, held, incoming, expectedOnChain (derived)        |
| GET    | `/v1/operations/:operationId`           | platform | Read an operation                                           |
| POST   | `/v1/admin/compliance-changes`          | admin    | allow / disallow / freeze / unfreeze. `Idempotency-Key`     |
| GET    | `/v1/admin/compliance-changes/:changeId`| admin    | Read a compliance change                                    |
| POST   | `/v1/admin/reconciliations`             | admin    | Run a reconciliation now (200 for ok, mismatch AND unknown) |
| GET    | `/v1/admin/reconciliations`             | admin    | The latest runs                                             |
| GET    | `/health`                               | public   | Liveness (no dependency touched)                            |
| GET    | `/ready`                                | public   | Database, node chain id, deployment binding                 |

### Amounts

Decimal **strings** of the token's smallest unit (6 decimals: `"1500000"` = 1.5 tokens). JSON
numbers, floats, signs, exponents, leading zeros, zero and more than 19 digits are refused (400);
above `API_MAX_AMOUNT` is `AMOUNT_ABOVE_LIMIT` (400). Responses use the same format. ADR 0010.

### Idempotency

Every POST that moves money or changes compliance needs `Idempotency-Key` (1-255 visible ASCII
characters). Same key + same body: the stored result, **200** and `Idempotent-Replayed: true`,
nothing written. Same key + another body: **409** naming only the caller's own operation. New:
**201**. Keys are scoped per user (operations) and per operator (compliance), by the engine.

### Balances

Derived from the ledger on every read, never stored. `incoming` is a pending deposit (not minted
yet); a transfer reserves only on the sender's side (`available -> held`) and credits the
recipient at settlement. `expectedOnChain = available + held` is what the wallet holds once
everything pending is settled or reversed, the figure the reconciler checks.

## Authentication and authorisation

Two static bearer tokens from the environment, compared in constant time (SHA-256 of both sides,
then `timingSafeEqual`; both tokens are always compared), at least 32 characters, and different:

- `API_PLATFORM_TOKEN`: the trusted platform backend calling on its users' behalf (user, operation
  and balance routes). It may act on any user: the platform maps its logged-in user to a `userId`.
- `API_ADMIN_TOKEN`: an operator (compliance and reconciliation routes).

The scopes are **disjoint**: the admin token on a platform route is **403**, never silently
accepted (an operator credential that can also move users' money doubles what one leak costs and
blurs the audit trail). No or an unknown credential is **401** with `WWW-Authenticate: Bearer`.
Every route must declare `@Access(...)`; a route without it is refused (deny by default).

**Real deployments put an identity provider in front**: OAuth 2 client credentials or OIDC for
the platform, SSO with MFA for operators, short-lived tokens with per-user subjects, an
object-ownership check on every `:userId` route, and rate limiting at the edge (none here: there
is no login endpoint to brute-force, and a static token is not a user session).

## Errors

RFC 9457 `application/problem+json` from a closed catalog (`src/core/problem.ts`): stable `type`
(`urn:bridge:problem:<code>`) and `code`, a fixed `detail` per code, `instance` =
`urn:request:<X-Request-Id>`. Engine, Prisma and chain messages never reach a response (they
carry other users' ids, SQL and RPC URLs); unexpected errors are a bare 500 with the request id
and are logged redacted, without the stack.

| Status | Codes                                                                                  |
| ------ | -------------------------------------------------------------------------------------- |
| 400    | VALIDATION_FAILED, MALFORMED_JSON, IDEMPOTENCY_KEY_MISSING, IDEMPOTENCY_KEY_INVALID, AMOUNT_ABOVE_LIMIT, SELF_TRANSFER |
| 401    | UNAUTHENTICATED                                                                        |
| 403    | FORBIDDEN                                                                              |
| 404    | NOT_FOUND, USER_NOT_FOUND, OPERATION_NOT_FOUND, COMPLIANCE_CHANGE_NOT_FOUND            |
| 409    | IDEMPOTENCY_CONFLICT, WALLET_ALREADY_REGISTERED                                        |
| 413    | PAYLOAD_TOO_LARGE                                                                      |
| 422    | INSUFFICIENT_FUNDS                                                                     |
| 503    | NO_ACTIVE_DEPLOYMENT, DEPLOYMENT_MISMATCH, DEPLOYMENT_NOT_REGISTERED, BUSY, NOT_READY (all with `Retry-After`; retry with the same key) |
| 500    | INTERNAL                                                                               |

## Logging

One JSON line per request (method, path without query, status, duration, request id) and per
event, every message redacted with the engine's `sanitizeText` and the configured secrets.
Headers and bodies are never logged.

## Design notes

- **Shared env module in the engine package** (`packages/engine/src/env.ts`, imported as
  `@bridge/engine/env`): both processes must apply the same chain and key refusals; two copies
  would drift. It is pure and framework-free.
- **NestJS 11, not 12**: 12 is ESM-only and the workspace is CommonJS with ts-jest.
- **Started from source** (`node -r ts-node/register/transpile-only -r tsconfig-paths/register`):
  no workspace package is built yet (see the engine README); type checking is `pnpm typecheck`.
- **No `GET /v1/admin/alarms`**: the engine's alarms are process-local (`AlarmSink`), and the
  worker raises almost all of them, so an API endpoint would show a misleading subset. Alarms go
  to the structured log of the process that raised them; persisting them is an open question.
- `app_user.verified` / `frozen` are a non-authoritative cache: never returned, never used.

## Tests

`pnpm --filter @bridge/api test` / `test:cov` (thresholds 90 / 85 / 95 / 90). HTTP tests run on
a fresh Postgres database per file (`bridge_api_test_<hex>`, migrated with the db package, so every
SQL guard is live) with the `FakeChainGateway` and a `BridgeEngine` ticking in the test.

| Property                                       | Test (file: name)                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| Deposit / withdrawal / transfer, balances      | operations.http: "moves the balances exactly, derived on every read"  |
| 422, self transfer, unknown user               | operations.http: "insufficient funds is 422 ...", "a transfer to oneself ..." |
| Replay, 409, concurrent copies, missing key    | operations.http: "idempotency" (4)                                    |
| Amount spellings, cap                          | operations.http: "amounts" (18); units: "parseAmount"                 |
| 401 / 403 on every route (vs the OpenAPI doc)  | security.http: "the route table", "401 / 403 matrix" (12)             |
| problem+json, no leaks, body parser, headers   | security.http: "problem+json" (6)                                     |
| OpenAPI document                               | security.http: "OpenAPI" (2)                                          |
| Compliance flow to the registry                | admin.http: "a compliance request is recorded, carried ... confirmed" |
| Reconciliation ok / mismatch / unknown, /ready | admin.http: "a clean run, then a rogue transfer ..., then a node failure ..." |
| 503 binding refusals                           | admin.http: "deployment binding" (2)                                  |
| Startup refusals                               | startup: "startApi" (3)                                               |
| Constant-time compare, guard decision          | units: "auth" (5)                                                     |
