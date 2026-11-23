# @bridge/engine

The bridge engine, framework-free: plain classes and functions that take a Prisma client, a clock
and an id source. No NestJS here; the API and worker apps wire these up.

**Piece A**: the operation service, the single status-move helper, and the outbox dispatcher.
**Piece B**: the settlement submitter, the transaction monitor, the indexer and the `BridgeEngine`
composition root (below). **Piece C**: compliance sending and monitoring, the signer router and
the reconciler (section "Piece C" below).

| Module                 | What it does                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `operation-service.ts` | `OperationService`: deposit / withdrawal / transfer requests, each ONE transaction                 |
| `move-operation.ts`    | `moveOperation(tx, input)`: the only way an operation changes status, evidence checked             |
| `outbox-dispatcher.ts` | `OutboxDispatcher`: claim, renew, hand off to an `OutboxHandler`, back off, recover stale leases   |
| `transaction.ts`       | `runTransaction`: one interactive transaction, retried a bounded number of times on 40001 / 40P01 |
| `ledger-writes.ts`     | Shared writes: account resolution, journal entry + postings, audit row                             |
| `redact.ts`            | `sanitizeText` / `describeError`: URL-free, single-line, bounded error text                       |
| `signing.ts`           | `signAndVerify` (bytes checked before storage), `RawTransactionInspector`, `ViemTransactionInspector` |
| `signer-binding.ts`    | Gateway deployment binding (`bindingOf`, `assertBound`) and the signer-address check               |
| `attempts.ts`          | Shared attempt/nonce machinery: call codec, nonce under the signer lock, lease fence, broadcast classification |
| `settlement-submitter.ts` | `SettlementSubmitter`: the `OutboxHandler` for `settlement` rows                               |
| `tx-monitor.ts`        | `TxMonitor`: submitted/failed operations decided on final evidence                                 |
| `indexer.ts`           | `Indexer`: events + block hashes into the database, reorg-aware                                    |
| `alarms.ts`            | `AlarmSink` / `AlarmLog`: conditions a person must look at                                         |
| `compliance-service.ts` | `ComplianceService`: allow / disallow / freeze / unfreeze requests, each ONE transaction          |
| `compliance-move.ts`   | `moveComplianceChange(tx, input)`: the only way a compliance change changes status                 |
| `compliance-submitter.ts` | `ComplianceSubmitter`: the `OutboxHandler` for `compliance` rows                                |
| `compliance-monitor.ts` | `ComplianceMonitor`: submitted/failed compliance changes decided on final registry events         |
| `signer-router.ts`     | `SignerRouter`: one dispatcher, each row to its signer's handler                                   |
| `reconciler.ts`        | `Reconciler`: ledger vs chain at the final block; every run (ok / mismatch / unknown) persisted    |
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

### Sign first, check, commit, then broadcast (obligation 1, review M-3)

The gateway signs without sending (`signTransaction`, local) and later sends exactly those bytes
(`sendRaw`, idempotent for known bytes). Before anything is stored, `signAndVerify` checks in the
engine that `keccak256(raw) === hash` and that the bytes, decoded by a `RawTransactionInspector`,
are EIP-1559 with the request's chain id, nonce, both fee fields and exact call, aimed at the
deployment's contract for that call, and recover to the deployment's recorded signer
(`signer_state`). Any difference is `SignedTransactionMismatchError`: nothing stored, nothing sent.
`ViemTransactionInspector` (viem `parseTransaction` + `recoverTransactionAddress` + the ABIs) is
the real one; the tests' `FakeTransactionInspector` decodes the fake's canonical encoding (it
cannot check `to` independently; the Anvil suite does).

**No lock across a sign.** A first send or a new-nonce resubmit signs for the PREDICTED next nonce
outside any lock, then in one transaction fences the lease, locks `signer_state`, allocates, and
commits only if the allocation equals the signed nonce; otherwise the signature is discarded and
the step repeats (at most 3 times, `commitWithFreshNonce`). A bump keeps its nonce, so it is
signed and verified before its transaction with no lock at all.

### Deployment binding (review M-2)

The binding is the gateway's own `deployment()` (chain id, token, registry, lowercase). At
construction, a configured `chainId` / `tokenAddress` (validated, case-normalised) must agree with
it (`DeploymentMismatchError`). At the start of every `tick()`, the database's ACTIVE deployment
of that chain must match token AND registry, or the tick raises `deployment_mismatch` and throws.
The submitter, monitor and indexer load their deployment row from the binding and refuse a row
whose registry differs.

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

### Review fixes (Patrick, round 1)

- **H-1, drops and give-ups.** A dropped attempt is retried at most every `dropRetrySeconds`
  (time, never pass count). If its `maxFeePerGas` is below the node's current estimate, the same
  bytes would be dropped again, so a REPLACEMENT is signed: same nonce, same call, fees =
  max(current estimate + margin, previous bumped), as a `bump` committed with its SUBMIT move.
  A `give_up` verdict is acted on only `giveUpAfterSeconds` after the first attempt, and never
  FAILs while the attempt's nonce is not final: the operation stays `submitted` (it could not be
  reversed anyway) and `nonce_stuck` names the signer and the lowest non-final nonce, for this
  and every operation queued behind it. A failed operation still not reversible after
  `failedAlarmAfterSeconds` raises `failed_not_reversible`.
- **M-1, signer binding.** Before any nonce read or signature, the gateway's settlement address
  must equal `signer_state.address` of the operation's deployment (`assertSignerBound`). A
  mismatch raises `signer_mismatch`; the submitter waits (`retryAt`) and the monitor decides
  nothing (no confirmation, no reversal).
- **M-4, unsent reservations.** A `ledger_reserved` operation older than `orphanAfterSeconds`
  with no attempt and no live outbox row (its row died before anything was signed) is failed
  (`rejected`) and reversed in ONE transaction that locks the operation row and re-checks every
  condition. Safe because an attempt is only ever inserted together with SUBMIT `first`. If the
  reference is consumed on chain, it is failed but not reversed (and escalated).
- **L-1** `node_unreachable` after `headStallTicks` failed chain views; `indexer_stalled` after
  `stallPasses` passes without progress. **L-2** the indexer's writes take
  `pg_advisory_xact_lock(hashtext(deployment_id))` and compare-and-set the cursor; block inserts
  use `skipDuplicates`; `tick()` isolates each component (`component_failed`, the others still
  run). **L-3** a failed operation whose reference is consumed with no indexed event raises
  `escalation`.
- **Rollback audit.** The indexer's rollback audit row lists every deleted event (`deletedEvents`:
  block, block hash, tx hash, log index, kind, ref, amount).

### Review round 2

- **N-1, drop patience.** Every rebroadcast of an existing nonce is stamped on the attempt
  (`last_checked_at`, compare-and-set) in the transaction that decides it, before the broadcast,
  whatever the node answers; the next one waits `dropRetrySeconds` from that stamp. Once the
  domain's counter is used up (`give_up(max_resubmits)`), a nonce that is not final is still
  rebroadcast on that cadence, uncounted, before and after `giveUpAfterSeconds` (which only raises
  `nonce_stuck`). The new-nonce budget counts new nonces (distinct attempt nonces - 1), not
  rebroadcasts.
- **L-A.** `operation_skipped` after `skipAlarmPasses` consecutive failed evidence reads of one
  operation (an in-memory counter per operation id; a restart only delays the alarm).
- **L-B.** `commitWithFreshNonce` runs at READ COMMITTED and refuses any other level
  (`UnsafeIsolationError`); the database refuses it too (guard 8 of `@bridge/db`: one nonce, one
  outbox row; attempts recorded at READ COMMITTED only).
- **Inspector.** Also refuses a non-zero `value` and calldata with trailing bytes, and compares the
  gas limit when the caller passes `gasLimit`.
- **Inactive deployment.** An engine bound to an inactive deployment refuses to run
  (`assertDeployment`). Nothing needs draining: the database refuses to deactivate a deployment
  with work in flight.

### Info (documented, not enforced)

- One outbox row per (deployment, signer, nonce) is lock discipline only (`signer_state FOR
  UPDATE` + `nextNonce` over every attempt nonce); there is no database constraint.
- The default `AlarmLog` is in memory. The application must wire a real `AlarmSink` (monitoring),
  or alarms are lost on restart.

### Known limit: a dead nonce blocks the signer (accepted, documented)

An attempt that was dropped everywhere and given up keeps its nonce reserved (attempts are never
deleted, and it can still mine). Until something uses that nonce, later transactions of the signer
queue behind the gap, and the operation cannot be reversed (its nonce is not final). Releasing it
needs a "cancel" transaction (a zero-value self-send with that nonce) that the gateway does not
offer yet (open question).

## Piece C: compliance and reconciliation

### Compliance requests (`ComplianceService`)

`request{Allow,Disallow,Freeze,Unfreeze}({ address, reason, idempotencyKey, requestedBy })` (allow
and disallow set the registry's `verified` flag) runs ONE transaction: the active deployment
`FOR SHARE` (the shared `lockActiveDeployment`), which must be the gateway's token AND registry;
the user owning the address (`UnknownUserError`); a transaction-scoped advisory lock on (requester,
key), then idempotency per requester (same content: the stored change, nothing written; other
content: `ComplianceIdempotencyConflictError`); the change (`requested`, version 0,
`ref = referenceFromUuid(id)`), ONE outbox row for the `compliance` signer with the registry call,
and an audit row.

### Sending and watching

The dispatcher routes rows by signer (`SignerRouter`). `ComplianceSubmitter` has the settlement
submitter's discipline and machinery: the call must be exactly the change's registry call; an
existing attempt is rebroadcast (same bytes); otherwise `assertSignerBound(..., 'compliance')`,
node reads first, `commitWithFreshNonce` (signed and verified outside any lock with the registry as
`to`; lease fence, `signer_state` (compliance) lock, nonce, attempt, SUBMIT `first` in one commit),
then `sendForOutbox` (shared with the settlement submitter): lease and abort re-checked, unknown =
thrown (same bytes next time), rejected = recorded and still counted.

`ComplianceMonitor` (a separate class: different subject, signer and terminal states; the same
view and alarm code) confirms ONLY on a registry event carrying the change's reference, on the
node's canonical block, final, and matching exactly (`judgeComplianceEvent`), with
`confirmedBlock` = the event block; a failed change only through `confirmComplianceChangeLate`. A
reference used to write something else (`conflict`) FAILs `reference_conflict` and escalates
(`compliance_escalation` + audit). Without an event it follows the attempt verdicts exactly as the
transaction monitor (bump, rebroadcast, same-nonce replacement, give-up only on a final nonce,
`readReferenceUsed('registry', ref, finalBlock)` before a new nonce). There is no reversal (the
domain table has no edge out of `confirmed`). A `requested` change whose outbox row died before
anything was signed is FAILed `rejected` after `orphanAfterSeconds`.

### The reconciler

`Reconciler.runOnce()` / `reconcileNow()` (the admin entry point; returns the persisted run with
its mismatches) and `latestRuns(limit)`:

1. DB snapshot in one short read-only REPEATABLE READ transaction (operations, ledger balances
   with `readBalances` (available + held per user), compliance changes, indexed events, the
   indexer cursor). No node call inside.
2. Head from the node, then `finalBlock = head - depth + 1` (checklist 15).
3. All node reads at `finalBlock`: the canonical hash of every block that holds an indexed event
   up to `finalBlock`; balances for exactly the ledger addresses plus both sides of every indexed
   `Transfer`, and the supply; registry flags for that set plus every account a registry event or
   a known change touched (checklist 16).
4. Expected flags: `deriveExpectedCompliance` applies final canonical registry events in (block,
   log index) order, only those matching a known change, then lets the latest CONFIRMED decision
   per account and flag win where it disagrees (a late-landing old change becomes a
   `compliance_mismatch`). Never the database's confirmation order (checklist 13).
5. Domain `reconcile`, then one transaction: `reconciliation_run`, one `reconciliation_mismatch`
   row per mismatch, an audit row; then one alarm per kind (`reconciliation_<kind>`).

Unknown, never clean: a read error, an index behind `finalBlock`, a ledger behind the chain (an
in-flight operation whose settling event is already final), a node missing a block, or input the
domain refuses: an `unknown` run with the redacted reason and `reconciliation_unknown`.
`BridgeEngine.tick()` runs it every `reconcileEveryTicks` ticks (default 10), after the monitors.

**Deviation (documented):** canonical hashes are read for every block that holds an indexed event
up to `finalBlock` (all the domain needs), not for every block since the deployment block.

### Quick items from the piece B review

- `BridgeEngine` refuses a `transactions.isolationLevel` other than `ReadCommitted` at
  construction (`UnsafeIsolationError`). The reconciler's own read-only snapshot uses REPEATABLE
  READ internally (it allocates nothing).
- `SigningExpectation.gasLimit` was REMOVED (the smaller change): nobody set it, the gateway
  chooses the limit, and a wrong limit can only make a transaction revert out of gas.

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
| C / compliance happy paths, idempotency   | compliance: "each change is signed once ...", "a replay with the same key ...", "concurrent copies ...", "refuses a malformed request ..." |
| C / frozen mid-operation, exact ledger    | compliance: "a withdrawal already signed when the freeze lands reverts ..."                               |
| C / 1-4: unknown, rejected                | compliance: "unknown outcome, then mined ...", "unknown outcome and NOT taken ...", "rejected by our node but mined elsewhere ..." |
| C / 8, 9, 12: event-only confirmation     | compliance: "a stale event from an orphaned block never confirms ...", "... under ANOTHER reference never confirms ...", "a front-run under OUR reference ..."; compliance-paths: "a final successful receipt without an indexed event is NOT a confirmation ..." |
| C / attempt paths, orphans, refusals      | compliance-paths: 11 monitor tests, "ComplianceSubmitter refusals", "moveComplianceChange: ...", "SignerRouter" |
| 13: expected flags from chain order       | reconciler: "deriveExpectedCompliance" (3), "the bridge's latest confirmed decision disagrees ..."         |
| 15: final block, node hashes              | reconciler: "a reorg of NOT-final blocks leaves the run stable ...", "a stale index ...: stale_block from the NODE hashes ..." |
| 16: exact address set                     | reconciler: "a rogue transfer to an OUTSIDER: its balance is read because it appears in a Transfer"         |
| C / every mismatch kind, persisted, alarmed | reconciler: "a rogue holder transfer ...", "a rogue registry freeze ...", "a rogue mint ...", "a confirmation the chain never made ...", "... at another block ..." |
| C / unknown runs                          | reconciler: "a node read error ...", "a read error AFTER the head ...", "an index behind the final block, a ledger behind the chain, a node missing a block ..." |
| C / end to end on a real chain            | reconciler.anvil: "allow -> deposit -> transfer -> withdrawal on Anvil reconciles with ZERO mismatches; a direct holder transfer is caught" |
| C / isolation refused at construction     | scenarios: "the engine refuses any isolation level but READ COMMITTED at construction ..."                 |

## Using the workspace packages

`@bridge/domain`, `@bridge/db` and `@bridge/chain` are consumed from source: `tsconfig.json`
`paths` and Jest `moduleNameMapper` point at `../<pkg>/src`, because no workspace package is built
in dev or CI. Building the engine into `dist/` needs a build order (or source `exports`) decided
for the whole workspace first.
