# @bridge/engine

The bridge engine, framework-free: plain classes and functions that take a Prisma client, a clock
and an id source. No NestJS here; the API and worker apps wire these up.

This is **piece A**: the operation service, the single status-move helper, and the outbox
dispatcher. Piece B (submitter, confirmer, indexer, reconciler) builds on it.

| Module                    | What it does                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `operation-service.ts`    | `OperationService`: deposit / withdrawal / transfer requests, each ONE transaction                 |
| `move-operation.ts`       | `moveOperation(tx, input)`: the only way an operation changes status                               |
| `outbox-dispatcher.ts`    | `OutboxDispatcher`: claim, hand off to an `OutboxHandler`, back off, recover stale locks          |
| `transaction.ts`          | `runTransaction`: one interactive transaction, retried a bounded number of times on 40001 / 40P01 |
| `ledger-writes.ts`        | Shared writes: account resolution, journal entry + postings, audit row                             |
| `errors.ts`               | Typed `EngineError`s, and the translation from domain errors                                       |
| `ports.ts`                | `Clock`, `IdSource` and their production implementations                                         |

## A request, step by step

`OperationService.request` runs one transaction (READ COMMITTED by default, retried on conflicts):

1. The **active** deployment of the configured chain, which must be the configured token
   (`NoActiveDeploymentError`, `DeploymentMismatchError`). ADR 0011, obligation 17.
2. The parties' accounts and wallets (`UnknownUserError`).
3. `lockRows(tx, 'account', ...)` on every user account the reserve entry posts to, ascending id
   order. `fiat_clearing` is not locked: it is never overdraft-checked and locking it would
   serialise every deposit.
4. Idempotency, after the lock: same key + same content returns the stored operation and writes
   nothing (`replayed: true`); same key + different content is `IdempotencyConflictError`.
5. The available balance read in the same transaction, under the lock, and the domain's
   `assertCanReserve` (`InsufficientFundsError`). Obligation 18.
6. Operation (`ledger_reserved`, version 0, id = fresh UUID, `ref = referenceFromUuid(id)`), the
   domain's reserve entry and postings, ONE outbox row (signer `settlement`, the `ContractCall`
   with amounts as decimal strings), and an audit row. All or nothing.

## Status moves

`moveOperation(tx, { operationId, from, version, move, at, note, txHash? })`:

- decides the next status with the domain's `transition`, or `confirmLate` for `CONFIRM_LATE`,
  **before any query** (illegal edges never reach the database); `RESERVE` is refused (only the
  service reserves, because only it reads the balance under lock);
- updates with `WHERE id = ? AND version = <read> AND status = <read>` and writes
  `version = <read> + 1` as a literal; zero rows means `VersionConflictError`;
- writes the settle (CONFIRM, CONFIRM_LATE) or reverse (REVERSE) entry from `buildEntry`, after the
  status, in the same transaction;
- appends an audit row.

It takes the caller's transaction, so piece B can write its chain attempt in the same commit.
`OperationService.move(input)` wraps it in its own transaction for callers with nothing else to
write. The caller of `REVERSE` must have checked `mayReverse`; of `CONFIRM_LATE`, `lateConfirmation`.

## The outbox dispatcher

`runOnce()`:

1. **Reap**: stale `processing` rows (lock older than `lockTimeoutMs`) with no attempts left become
   `dead`, with an audit row.
2. **Claim**: one autocommit `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n)`
   of due `pending` rows and stale `processing` rows: `processing`, `locked_at`, a per-claim lease
   token in `locked_by`, `attempts_count + 1`. Committed before any handler runs.
3. **Handle** with no transaction open. `done`; `{ retryAt }` (a deliberate wait: the attempt is
   given back); `{ failed }` (dead + audit row). A thrown error is an unknown outcome (ADR 0009):
   retried after `baseMs * 2^(attempts-1)` capped at `maxMs`, and dead at `maxAttempts`.
4. **Finish** fenced by the lease token: a worker whose lease was taken over changes nothing and
   reports `lostLease`.

The handler must be idempotent: a worker that stalls past `lockTimeoutMs` and then resumes, and the
worker that took over, can both have called it. The single-use reference (ADR 0003) is what makes a
second send harmless on chain; the lease fence makes sure only one outcome is recorded.

## Tests

Real PostgreSQL 16 (the db package's migrations, so every SQL guard is live). Each test file
creates `bridge_engine_test_<random>`, migrates it with `packages/db`'s `prisma migrate deploy`,
seeds `fiat_clearing`, and drops it afterwards. Admin URL: `DB_TEST_ADMIN_URL`, default the
docker-compose DEV database on `localhost:5434` (user/password `bridge`).

```bash
docker compose up -d postgres
pnpm --filter @bridge/engine test        # all tests
pnpm --filter @bridge/engine test:cov    # with thresholds (90% statements/lines, 85% branches)
```

| Obligation / property                         | Test (file: name)                                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Exact journal + outbox per type               | operation-service: "deposit: ...", "withdrawal: ...", "transfer: ..."                                 |
| 18: balance read under the lock               | operation-service: "N parallel withdrawals ...", "withdrawals and transfers racing ..."              |
| Idempotent replay / conflict                  | operation-service: idempotency (5 tests, incl. concurrent copies and a same-key race across users)   |
| 17: deployment binding                        | operation-service: "no active deployment ...", "the active token is not ...", "after a redeploy ..." |
| 40001 retry and its bound                     | operation-service: "retries the whole transaction ...", "gives up with RetriesExhaustedError ..."    |
| Atomicity                                     | operation-service: "a failure inserting into posting / outbox_message / audit_log ..."               |
| Domain table first, version literal           | move-operation: "illegal edges are refused before the database is touched", "stale reads"            |
| SKIP LOCKED, no double processing             | outbox-dispatcher: "skips a row another transaction has locked ...", "two dispatchers racing ..."   |
| No transaction across the handler             | outbox-dispatcher: "claims due rows, commits the claim before the handler runs ..."                  |
| Backoff, cap, unknown outcome = retry         | outbox-dispatcher: "doubles from baseMs ...", "a thrown error is a retry ... then dead at the cap"   |
| Crash recovery, lease fence                   | outbox-dispatcher: "crashes and stale locks" (4 tests)                                              |

## Using the workspace packages

`@bridge/domain`, `@bridge/db` and `@bridge/chain` are consumed from source: `tsconfig.json`
`paths` and Jest `moduleNameMapper` point at `../<pkg>/src`, because no workspace package is built
in dev or CI. Building the engine into `dist/` needs a build order (or source `exports`) decided
for the whole workspace first.
