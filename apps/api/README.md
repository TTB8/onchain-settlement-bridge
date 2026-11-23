# @bridge/api

The bridge's HTTP API (NestJS 11, Express): users, deposits, withdrawals, transfers, balances,
compliance requests and reconciliation runs, on top of `@bridge/engine`. It **holds no signing
key**: it reserves funds and enqueues chain calls in the database (the worker signs and sends),
and its chain gateway is read-only (`src/chain/read-only-gateway.ts`).

## Run

```bash
docker compose up -d
pnpm install
pnpm setup:local                  # migrate, deploy, register, write .env (DEV ONLY values)
pnpm dev                          # api + worker; or only this app:
pnpm --filter @bridge/api start
```

Every variable is documented in `.env.example`. The full walkthrough is
[docs/local-development.md](../../docs/local-development.md).

Startup fails fast, before serving a request: the environment is validated (every problem listed
by name, never a value; `packages/engine/src/env.ts`), a mainnet / testnet / unknown chain is
refused unless its `ALLOW_*` flag is `true`, the database must answer `SELECT 1` ("the database is
not reachable: check DATABASE_URL and that Postgres is up", exit 1), and the node must report
`CHAIN_ID`. If the database goes away while serving, requests answer 503 `NOT_READY` with
`Retry-After` (Prisma initialization errors and P1001 / P1002 / P1017), never 500, and the API logs
one `database unavailable` warn line per request.

OpenAPI: `GET /docs` (UI) and `GET /docs/openapi.json`. Served by default only on a local chain;
elsewhere set `API_DOCS_ENABLED=true` explicitly (and `false` turns them off anywhere).

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
| GET    | `/ready`                                | public   | Database, node chain id, deployment binding (cached 2 s)    |

### Amounts

Decimal **strings** of the token's smallest unit (6 decimals: `"1500000"` = 1.5 tokens). JSON
numbers, floats, signs, exponents, leading zeros, zero and more than 19 digits are refused (400);
above `API_MAX_AMOUNT` is `AMOUNT_ABOVE_LIMIT` (400). Responses use the same format. ADR 0010.

### Idempotency

Every POST that moves money or changes compliance needs `Idempotency-Key` (1-255 visible ASCII
characters). Same key + same body: the stored result, **200** and `Idempotent-Replayed: true`,
nothing written. Same key + another body: **409** naming only the caller's own operation. New:
**201**. Keys are scoped per user (operations) and per operator (compliance), by the engine.

### Users

`POST /v1/users` with a wallet that already has a user returns that user with **200** and
`Idempotent-Replayed: true` (nothing written; concurrent registrations create one user). The body
is the wallet and nothing else, so a repeat IS the same request and the route is safe to retry
without a key; if the body ever gains fields, a repeat whose other fields differ must be a 409.

### Transactions of an operation

Every operation response (`POST` deposits / withdrawals / transfers, `GET /v1/operations/:id`, the
user's list) carries `transactions`: each chain transaction the worker signed for it, as
`{ hash, nonce, status, blockNumber }`, ordered by (nonce, fee bumps). It is empty until the worker
signs; a fee bump or a resubmission adds an entry, and at most one of them settles the operation.
`status` and `blockNumber` are observations, not decisions. When the worker confirms the operation,
the ONE transaction whose hash carried the confirming event is recorded as `mined` with that
event's block (so `blockNumber` equals the operation's `confirmedBlock`). Every other entry keeps
the last broadcast status (`signed`, `sent`, `dropped`) with `blockNumber: null`; that includes a
replaced fee bump, and every transaction of a failed or reversed operation. The operation's own
`status` and `confirmedBlock` are authoritative; nothing in the engine decides on these fields. The
attempts are read through the operation's outbox rows, one query per page.

### Balances

Derived from the ledger on every read, never stored. `incoming` is a pending deposit (not minted
yet); a transfer reserves only on the sender's side (`available -> held`) and credits the
recipient at settlement. `expectedOnChain = available + held` is what the wallet holds once
everything pending is settled or reversed, the figure the reconciler checks.

## Trust assumptions

- **A deposit is a MINT AUTHORITY.** `POST /v1/users/:userId/deposits` is the platform asserting
  that fiat arrived; the worker then mints that amount. The bridge cannot verify the fiat leg, and
  the reconciler cannot see an unbacked deposit: the ledger and the chain agree with each other.
  Call the route only after the platform has confirmed the fiat payment settled. Anyone holding
  `API_PLATFORM_TOKEN` can create supply. Production mitigations, out of scope here: a unique fiat
  receipt reference per deposit, a rolling mint cap, a proof-of-reserve gate on minting (engine
  README, "Trust assumptions").
- **All admin operations share ONE operator identity.** With a single static admin token every
  compliance change is recorded with `requestedBy = "admin-token"`, and idempotency keys are scoped
  to that one identity, so the audit trail cannot attribute a freeze or a reconciliation to a
  person. Production needs per-operator identities from an identity provider (the subject claim
  becomes `requestedBy`), with MFA for compliance actions.
- **Alarms are log lines only**: there is no transport (pager, webhook, table). Ship stdout to a log
  pipeline and alert on `"msg":"alarm"`.
- **The non-owner database role is not enforced by the app**: it is an operator obligation (above).
- **`pnpm dev` gives both processes one environment**, so locally the API process also holds the
  signer keys in its environment (it never reads them). In production the API's environment must
  not contain `SETTLEMENT_SIGNER_KEY` / `COMPLIANCE_SIGNER_KEY`.

## Authentication and authorisation

Two static bearer tokens from the environment, compared in constant time (SHA-256 of both sides,
then `timingSafeEqual`; both tokens are always compared), at least 32 characters, and different:

- `API_PLATFORM_TOKEN`: the trusted platform backend calling on its users' behalf (user, operation
  and balance routes). It may act on any user: the platform maps its logged-in user to a `userId`.
- `API_ADMIN_TOKEN`: an operator (compliance and reconciliation routes).

The scopes are **disjoint**: the admin token on a platform route is **403**, never silently
accepted (an operator credential that can also move users' money doubles what one leak costs and
blurs the audit trail). No or an unknown credential is **401** with `WWW-Authenticate: Bearer`.
The guard is global and deny-by-default: a controller route that declares no `@Access(...)` is
refused with 403, so a forgotten decorator can never publish a route. `/docs` and
`/docs/openapi.json` are not controller routes (Swagger serves them outside the guard), which is
why they are off by default except on a local chain; unknown paths answer 404 before any guard.

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
| 400    | VALIDATION_FAILED, MALFORMED_JSON, BAD_REQUEST_BODY, IDEMPOTENCY_KEY_MISSING, IDEMPOTENCY_KEY_INVALID, AMOUNT_ABOVE_LIMIT, SELF_TRANSFER |
| 401    | UNAUTHENTICATED                                                                        |
| 403    | FORBIDDEN                                                                              |
| 404    | NOT_FOUND, USER_NOT_FOUND, OPERATION_NOT_FOUND, COMPLIANCE_CHANGE_NOT_FOUND            |
| 409    | IDEMPOTENCY_CONFLICT                                                                   |
| 413    | PAYLOAD_TOO_LARGE                                                                      |
| 415    | UNSUPPORTED_MEDIA_TYPE (charset or content encoding the body parser refuses)           |
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
| `transactions` on the operation (hash per attempt) | operations.http: "an operation shows its chain transactions ..."; security.http: "serves the document ..." |
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
