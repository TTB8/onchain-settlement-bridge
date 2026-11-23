# @bridge/engine

The bridge engine, framework-free: plain classes and functions that take a Prisma client, a clock
and an id source. No NestJS here; the API and worker apps wire these up.

**Piece A**: the operation service, the single status-move helper, and the outbox dispatcher.
**Piece B**: the settlement submitter, the transaction monitor, the indexer and the `BridgeEngine`
composition root (below). The reconciler, compliance sending and audit extras are piece C.

| Module                 | What it does                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `operation-service.ts` | `OperationService`: deposit / withdrawal / transfer requests, each ONE transaction                 |
| `move-operation.ts`    | `moveOperation(tx, input)`: the only way an operation changes status, evidence checked             |
| `outbox-dispatcher.ts` | `OutboxDispatcher`: claim, renew, hand off to an `OutboxHandler`, back off, recover stale leases   |
| `transaction.ts`       | `runTransaction`: one interactive transaction, retried a bounded number of times on 40001 / 40P01 |
| `ledger-writes.ts`     | Shared writes: account resolution, journal entry + postings, audit row                             |
| `redact.ts`            | `sanitizeText` / `describeError`: URL-free, single-line, bounded error text                       |
| `signing.ts`           | `TransactionSigner` (sign first, broadcast exactly that later), `ResigningSigner`                  |
| `attempts.ts`          | Shared attempt/nonce machinery: call codec, nonce under the signer lock, lease fence, broadcast classification |
| `settlement-submitter.ts` | `SettlementSubmitter`: the `OutboxHandler` for `settlement` rows                               |
| `tx-monitor.ts`        | `TxMonitor`: submitted/failed operations decided on final evidence                                 |
| `indexer.ts`           | `Indexer`: events + block hashes into the database, reorg-aware                                    |
| `alarms.ts`            | `AlarmSink` / `AlarmLog`: conditions a person must look at                                         |
| `bridge-engine.ts`     | `BridgeEngine`: wiring, `tick()`, a thin `start()`/`stop()` loop                                   |
| `errors.ts`            | Typed `EngineError`s, and the translation from domain errors                                       |
| `ports.ts`             | `Clock`, `IdSource` and their production implementations                                         |

## A request, step by step

`OperationService.request` runs one transaction (READ COMMITTED by default, retried on conflicts):

1. The **active** deployment of the configured chain, read `FOR SHARE` (held until commit), which
   must be the configured token (`NoActiveDeploymentError`, `DeploymentMismatchError`). ADR 0011,
   obligation 17. The share lock means a racing deactivation either waits for this request and is
   then refused by the database (the operation is not final), or commits first and this request
   sees the row as inactive. The db insert guard takes the same lock, for every writer.
2. The parties' accounts and wallets (`UnknownUserError`).
3. `lockRows(tx, 'account', ...)` on every user account the reserve entry posts to, ascending id
   order. `fiat_clearing` is not locked: it is never overdraft-checked and locking it would
   serialise every deposit.
4. Idempotency, after the lock, **per user** (unique on `(user_id, idempotency_key)`): same key and
   same content returns the stored operation and writes nothing (`replayed: true`); same key and
   different content is `IdempotencyConflictError`, which names only the requester's own operation
   and never echoes the key. Two users may use the same key independently.
5. The available balance read in the same transaction, under the lock, and the domain's
   `assertCanReserve` (`InsufficientFundsError`). Obligation 18.
6. Operation (`ledger_reserved`, version 0, id = fresh UUID, `ref = referenceFromUuid(id)`), the
   domain's reserve entry and postings, ONE outbox row (signer `settlement`, the `ContractCall`
   with amounts as decimal strings), and an audit row. All or nothing.

### Transient `NoActiveDeploymentError` during a switch

A deployment switch (deactivate the old row, activate the new one) is atomic in the database, but
a request that reads the deployment while the switch transaction holds the row waits for it and
then sees the old row inactive. Such a request fails with `NoActiveDeploymentError` even though a
new deployment is active a moment later. The error is retryable: the API should map it to 503
with `Retry-After` and the caller should retry with the same idempotency key (nothing was written).

### Replays after a reconfiguration (review I-3)

Step 1 runs before the idempotency lookup, so a replay is answered only while the engine's
configured deployment is the chain's active one:

- the engine still configured for an old token after a redeploy refuses every request, replays
  included (`DeploymentMismatchError`); the caller retries once the engine is reconfigured;
- an engine configured for the new deployment answers a replay of a request made on the old one
  from the stored record: same operation, still bound to the OLD deployment (`deploymentId`,
  `chainId`, `tokenAddress` in the result say so), nothing written, never re-bound;
- while no deployment is active (mid-migration), every request, replays included, gets
  `NoActiveDeploymentError`.

## Status moves

`moveOperation(tx, { operationId, from, version, move, at, note, txHash? })`:

- decides the next status with the domain's `transition` (or `confirmLate`) and checks the move's
  evidence **before any query**:
  - `SUBMIT` is `{ kind: 'first' }` (from `ledger_reserved`), `'bump'` or
    `{ kind: 'resubmit', resubmitsSoFar }` (from `submitted`);
  - `CONFIRM` and `CONFIRM_LATE` need a `SettlementJudgement` with verdict `confirm` (from the
    domain's `lateConfirmation` / `resolveRevert`); anything else, forged literals included, is
    `EvidenceRefusedError`;
  - `REVERSE` needs `ReversalEvidence`, and the domain's `mayReverse` must accept it;
  - `RESERVE` is refused (only the service reserves, because only it reads the balance under lock);
- updates with `WHERE id = ? AND version = <read> AND status = <read>` (plus, for REVERSE, the
  stored `failure_reason` must equal `evidence.failureReason`; for a resubmit, `resubmits_so_far`
  must equal the read value) and writes `version = <read> + 1` (and `resubmits_so_far = <read> + 1`)
  as literals; zero rows is `VersionConflictError`, or `EvidenceRefusedError` when only the
  failure reason differs;
- writes the settle (CONFIRM, CONFIRM_LATE) or reverse (REVERSE) entry from `buildEntry`, after the
  status, in the same transaction;
- on a FAIL from `ledger_reserved` and on every REVERSE, kills the operation's live outbox rows
  (`pending` / `processing` -> `dead`, lease dropped, `last_error` says why), so nothing is ever
  signed for an operation whose funds are released;
- appends an audit row.

**Accepted risk: evidence is self-attested at this API level.** `moveOperation` checks that a
judgement says `confirm` and that `mayReverse` accepts the `ReversalEvidence`, but it cannot tell
whether those values were really produced by the domain functions from real chain observations;
a caller can build the literals by hand. This is an internal API: the only callers are the
engine's own components (piece B), and they must pass only values returned by `lateConfirmation` /
`resolveRevert` and evidence gathered as ADR 0012 items 5-8 require. Review that code path, not
this one, for the provenance of the evidence.

It takes the caller's transaction, so piece B can write its chain attempt in the same commit.
`OperationService.move(input)` wraps it in its own transaction for callers with nothing else to
write.

## The outbox dispatcher

`runOnce()`:

1. **Reap**: stale `processing` rows (lease older than `lockTimeoutMs`) with no attempts left
   become `dead` ("lease expired"), with an audit row.
2. **Claim**: one autocommit `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n)`
   of due `pending` rows and stale `processing` rows: `processing`, `locked_at`, a per-claim lease
   token in `locked_by`, `attempts_count + 1`. Committed before any handler runs.
3. Per row: **renew** the lease (`locked_at = now`, fenced by the token). If another worker took
   the row while it waited behind slower rows of the batch, the renewal changes nothing and the
   row is skipped: its handler is never called (`lostLease`).
4. **Handle** with no transaction open, under a hard limit `handlerTimeoutMs` (must be below
   `lockTimeoutMs`; the constructor refuses otherwise). The handler gets
   `{ stillHolds(), signal }`: `stillHolds()` re-checks the lease (ours, still processing, not
   stale) and `signal` aborts at the limit. Because each row is renewed just before its own
   handler, a lease only has to cover one handler call, so `batchSize * handlerTimeoutMs` may
   exceed `lockTimeoutMs`.
5. **Outcomes**:
   - `done`;
   - `{ retryAt }`: a deliberate wait; the attempt is given back; the date is clamped to at least
     `now + baseMs`; a row older than `maxWaitAgeMs` (since creation) is dead-lettered with an
     audit row instead of waiting again;
   - `{ failed: code, detail? }`: dead + audit row;
   - a thrown error, an Invalid Date or an unknown outcome is an UNKNOWN outcome (ADR 0009):
     retried after `baseMs * 2^(attempts-1)` capped at `maxMs`, dead at `maxAttempts`;
   - a **timeout** is unknown too, but the abort signal is only a request and the handler may
     still be running. Releasing the row would let another worker claim it after `baseMs`, long
     before the lease goes stale: two handlers on one row. So the row stays `processing` under
     the same lease, only `last_error` is written (`timedOut` in the summary), and it comes back
     solely through the stale-lease path `lockTimeoutMs` after its renewal (where the claim counts
     the attempt and the reaper dead-letters it at the cap). Waiting for the handler to settle
     instead was rejected: a hung handler never settles. A handler still running after that is
     fenced by `stillHolds()`.
6. **Finish** fenced by the lease token: a worker whose lease was taken over changes nothing.

Every error text written to `outbox_message.last_error` and to audit notes is
`<ErrorClass>: <message>` (or `failed:<code>: <detail>`) with every URL replaced by
`<redacted-url>` (plain, JSON-escaped and percent-encoded forms), control characters flattened,
and at most 1000 characters.

## Requirements for piece B (review I-2)

The guarantees above hold only if the handler keeps to these:

1. **Commit before broadcast.** Persist the signed attempt (`chain_attempt`, raw bytes, hash,
   nonce, fees) and the SUBMIT move (`moveOperation`, kind `first` / `bump` / `resubmit`) in ONE
   transaction, commit, and only then broadcast. A crash after the commit is recovered from the
   stored bytes; a crash before it sent nothing.
2. **Re-check the lease** with `context.stillHolds()` immediately before broadcasting, and stop if
   it is false. Stop as well when `context.signal` is aborted.
3. **Be idempotent per row.** A row can be handled again after a crash or a lease takeover; look
   for an existing attempt for the row before signing a new one.
4. **Never touch `resubmits_so_far`** except through `SUBMIT { kind: 'resubmit' }`.
5. **Moves with evidence only.** CONFIRM / CONFIRM_LATE with the judgement from the domain,
   REVERSE with `ReversalEvidence` gathered in the same pass (ADR 0012 items 5-8); a FAIL from
   `ledger_reserved` and every REVERSE cancel the operation's live outbox row in the same
   transaction (done by `moveOperation`), so do not re-enqueue for such an operation.
6. **Outcomes.** Return `{ retryAt }` while waiting for finality, `{ failed: code }` only for a
   definite refusal, and throw for anything unknown.

## Piece B: sending, watching, indexing

### Sign first, then commit, then broadcast (obligation 1)

`ChainGateway.submit` signs and sends in one call and reveals the hash only afterwards, while
`chain_attempt` needs the hash and the raw bytes at INSERT. So the engine takes a
`TransactionSigner`: `sign(request)` returns `{ hash, raw }` without sending, and
`broadcast(signed, request)` sends exactly that. `ResigningSigner` adapts a gateway whose signing
is deterministic (both are): it re-submits the same request and refuses to call it a success
unless the gateway reports the recorded hash (`SignedHashMismatchError`, an unknown outcome). The
tests supply the signing function (the fake's hash; viem with Anvil's dev key). **Production needs
a sign-only + send-raw method on the chain package's gateway** (open question): until then no
production key holder can produce the bytes before the send.

### The submitter (`SettlementSubmitter.handle`)

1. Operation + deployment; the deployment must be the gateway's (`DeploymentMismatchError`, a
   retry) (obligation 17).
2. The row already has an attempt: rebroadcast THAT attempt (same bytes, same nonce), or `done` if
   the operation is no longer `submitted`. Never a new nonce for a row that has one.
3. Else: pending nonce and fee estimate read first (no lock across a node call), then ONE
   transaction: lease fence on the outbox row (`UPDATE ... WHERE status='processing' AND
   locked_by=<lease>`, exactly 1 row, else roll back; review L-B), `lockSignerState` + `nextNonce`
   over every attempt nonce at or above the chain's pending count, sign, insert the attempt,
   `moveOperation` SUBMIT `first` (version-fenced).
4. After the commit: `signal` not aborted and `stillHolds()` true, else `LeaseLostError` and no
   send.
5. Broadcast: sent / already known / nonce already used -> `done`; this node refused ->
   attempt marked `dropped` (still counted until its nonce is final), row `failed`, operation
   stays `submitted`; unknown -> thrown, the dispatcher retries and step 2 rebroadcasts.

### The monitor (`TxMonitor.runOnce`)

Chain view head first: `head`, `getNonce(signer, head)`, `getNonce(signer, max(0, head-depth+1))`;
any read error ends the pass with nothing written. Only the bound deployment's operations are
examined; others raise `foreign_deployment`. Per operation: every attempt (rejected ones too) with
its receipt and whether the node knows it, every indexed event carrying the reference, and the
canonical hash of each event's block read from the node now.

- A canonical settling event: `lateConfirmation` -> CONFIRM (CONFIRM_LATE if failed) with
  `confirmedBlock` = the event block; `reference_conflict` -> FAIL + escalation; `wait` -> wait.
- `submitted`, no event: `assessAttempt` per attempt. Mined (final or not) -> wait for the event
  (alarm `settled_without_event` if final). Final revert -> `resolveRevert` -> FAIL with its
  reason (`duplicate_reference` escalated). Newest attempt: `stuck_bump` -> same nonce, bumped
  fees, new attempt + SUBMIT `bump` in one commit; `dropped` -> SUBMIT `resubmit` and rebroadcast
  the same bytes; `give_up` -> FAIL (`dropped` for `max_resubmits`, else `retries_exhausted`);
  `replaced_or_lost` on every attempt -> `readReferenceUsed` at the final block; unused and no
  event -> new nonce (SUBMIT `resubmit`), else wait + alarm.
- `failed`, not an escalation: REVERSE only if `mayReverse` accepts evidence from this pass.
- The head not advancing for `headStallTicks` passes raises `head_stalled`.

### The indexer (`Indexer.runOnce`)

`detectReorg` over the newest `reorgWindow` stored blocks against hashes from the node:
`beyondWindow` halts (alarm, nothing written, every pass); `reorged` removes the blocks above the
fork point with their events and rewinds the cursor in one transaction with an audit row;
`nodeBehind` neither rolls back nor advances. Then `nextScanRange`, blocks and events from the
node, hash-linked and hash-matched, written in one transaction (`skipDuplicates` on block hash +
log index; the cursor never moves back on a scan). Finality is never stored: it is judged from the
head at use.

**Deviation from the brief (schema):** `chain_event` has no canonical flag and cascades with its
`indexed_block` (one row per height), so orphaned events are deleted, not marked. Every consumer
re-checks hashes against the node, so nothing depends on keeping them; a "mark, never delete"
model needs a db migration (open question).

### `BridgeEngine`

`new BridgeEngine({ prisma, gateway, signer, clock, ids, alarms? }, config)`; `tick()` = dispatcher,
indexer, monitor. `maxResubmits` defaults to 3: three rebroadcasts ride out a node restart, pool
eviction or a load balancer flap; a transaction every node keeps dropping after that needs a
person, and a resubmission can never pay twice (single-use reference), so the limit only bounds
noise and gas. `start()`/`stop()` loop around `tick()` without overlap.

### Known limit: a dead nonce blocks the signer

An attempt that was dropped everywhere and given up keeps its nonce reserved (attempts are never
deleted, and it can still mine). Until something uses that nonce, later transactions of the signer
queue behind the gap, and the operation cannot be reversed (its nonce is not final). Releasing it
needs a "cancel" transaction (a zero-value self-send with that nonce) that the gateway does not
offer yet (open question).

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

| Obligation / property                     | Test (file: name)                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Exact journal + outbox per type           | operation-service: "deposit: ...", "withdrawal: ...", "transfer: ..."                                      |
| 18: balance read under the lock           | operation-service: "N parallel withdrawals ...", "withdrawals and transfers racing ..."                    |
| Idempotent replay / conflict, per user    | operation-service: idempotency (7 tests, incl. concurrent copies, per-user keys, no key echo)              |
| 17: deployment binding                    | operation-service: "no active deployment ...", "the active token is not ...", "after a redeploy ..."       |
| 17: deactivation racing a request         | operation-service: "request first: the deactivation waits ...", "deactivation first: the request waits ..." |
| 40001 retry and its bound                 | operation-service: "retries the whole transaction ...", "gives up with RetriesExhaustedError ..."          |
| Atomicity                                 | operation-service: "a failure inserting into posting / outbox_message / audit_log ..."                     |
| Domain table first, version literal       | move-operation: "illegal edges are refused before the database is touched", "stale reads"                  |
| Evidence-typed moves                      | move-operation: "evidence is checked by moveOperation itself (review M-3)"                                 |
| Resubmit counter literal                  | move-operation: "SUBMIT first / bump / resubmit ..."                                                       |
| Outbox cancelled on FAIL-before-send / REVERSE | move-operation: "FAIL records the reason ...", "a FAIL after sending leaves the outbox row alone ...", "a processing (claimed) outbox row is cancelled too ..." |
| SKIP LOCKED, no double processing         | outbox-dispatcher: "skips a row another transaction has locked ...", "two dispatchers racing ..."         |
| No transaction across the handler         | outbox-dispatcher: "claims due rows, commits the claim before the handler runs ..."                        |
| Per-row renewal, stillHolds, timeout      | outbox-dispatcher: "leases are renewed per row and re-checkable (review M-2)" (5 tests, incl. "a timed-out handler keeps the row ...") |
| Backoff, cap, unknown outcome = retry     | outbox-dispatcher: "doubles from baseMs ...", "a thrown error is a retry ... then dead at the cap"         |
| Redacted, bounded last_error              | outbox-dispatcher: "error text is recorded redacted and bounded"; units: "sanitizeText / describeError"   |
| Bounded waits                             | outbox-dispatcher: "deliberate waits are bounded (review L-3)"                                             |
| Crash recovery, lease fence               | outbox-dispatcher: "crashes and stale locks" (4 tests)                                                    |
| B / 1: commit before broadcast, idempotent | scenarios: "an outbox row delivered twice ...", "a crash between the attempt commit and the broadcast ...", "a nonce recorded but never broadcast ..." |
| B / L-B: lease fence, REVERSE race        | scenarios: "a lease taken over while signing ...", "FAIL ... committed first ...", "REVERSE racing the attempt commit ..." |
| B / 2-4: final nonce, unknown, rejected   | scenarios: "dropped and never mined ...", "submit outcome unknown ...", "another node accepted what ours rejected ...", "obligation 3: ..." (2) |
| B / 5-8, 11: evidence and escalations     | scenarios: "frozen address ...", "a plain revert ...", "each piece of reversal evidence blocks on its own" (2), "duplicate_reference ...", "reference_conflict ..." |
| B / 9, 12, 15: canonical, event block     | scenarios: "obligation 12 ...", "a reorg removing a not-yet-final transaction ...", "a stale event from an orphaned block ..." |
| B / 10, 17: alarms, binding               | scenarios: "head_stalled", "another deployment's failed operation ...", "an outbox row bound to another deployment ...", "chain_mismatch" |
| B / 14: indexer                           | indexer: scanning (5), reorgs (6)                                                                         |
| B / end to end on a real chain            | engine.anvil: "deposit -> transfer -> withdrawal through tick() on Anvil ..."                             |

## Using the workspace packages

`@bridge/domain`, `@bridge/db` and `@bridge/chain` are consumed from source: `tsconfig.json`
`paths` and Jest `moduleNameMapper` point at `../<pkg>/src`, because no workspace package is built
in dev or CI. Building the engine into `dist/` needs a build order (or source `exports`) decided
for the whole workspace first.
