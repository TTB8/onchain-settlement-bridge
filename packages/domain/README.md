# @bridge/domain

The bridge's rules as pure functions. No framework, database or chain library, no clock and no
randomness: time and every observation of the chain are arguments. ESLint fails the build if this
package imports NestJS, Prisma or a chain library ([ADR 0004](../../docs/decisions/0004-pure-domain-package.md)).

The other packages decide nothing on their own: the engine gathers evidence, calls these functions,
and writes what they return. The database (`@bridge/db`) enforces the same ledger rules again in
SQL, as a backstop.

## Reading order

`src/index.ts` suggests it: the money first, then the lifecycle, then when the chain can be
believed, then how the two are proven to agree.

| Module              | What it decides                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `money.ts`          | `bigint` amounts in the smallest unit, `MAX_LEDGER_AMOUNT`, checked addition ([ADR 0010](../../docs/decisions/0010-amounts-and-time.md)) |
| `accounts.ts`       | The chart of accounts: `fiat_clearing`, and per user `available`, `held`, `incoming`                  |
| `ledger.ts`         | Double-entry journal: the reserve / settle / reverse postings of each operation type, balancing, `assertCanReserve`, and the on-chain balance a settled ledger implies |
| `operation.ts`      | The operation state machine (a table of legal edges), the gated late confirmation, `resolveRevert`, `mayReverse` |
| `reference.ts`      | The 32-byte single-use reference derived from an operation's UUID ([ADR 0003](../../docs/decisions/0003-single-use-references.md)) |
| `confirmation.ts`   | Finality: when a receipt, an event or a nonce use counts, attempt verdicts (stuck, dropped, give up) and whether any attempt can still be mined ([ADR 0006](../../docs/decisions/0006-settle-on-final-evidence.md)) |
| `reorg.ts`          | Reorg detection from the stored block window, telling a lagging node apart from a reorg, the next scan range |
| `nonce.ts`          | The next nonce for a signer, from the chain's count and the nonces the bridge already reserved        |
| `gas.ts`            | EIP-1559 fees for a first attempt and for a replacement (strictly above the 12.5% bump, rounded up)   |
| `compliance.ts`     | Who may transact, the compliance change lifecycle, and what happens to an in-flight operation when a party is frozen |
| `chainstate.ts`     | The journal checked as a whole per operation, and the chain state it implies at a given block        |
| `reconciliation.ts` | Ledger against chain: every mismatch kind, and when a run must be `unknown` instead of clean         |
| `audit.ts`          | The shape of an audit-trail record and its validating constructor                                     |
| `errors.ts`, `primitives.ts` | Typed errors; addresses, hashes and other validated primitives                               |

## The operation lifecycle

`OPERATION_TRANSITIONS` in `src/operation.ts` is the whole table. Anything not in it throws
`InvalidTransitionError`, and the database refuses the same edges again (guard 4 in
`@bridge/db`).

| From              | Event   | To                |
| ----------------- | ------- | ----------------- |
| `requested`       | RESERVE | `ledger_reserved` |
| `ledger_reserved` | SUBMIT  | `submitted`       |
| `submitted`       | SUBMIT  | `submitted` (fee bump or resubmission) |
| `submitted`       | CONFIRM | `confirmed`       |
| `ledger_reserved` | FAIL    | `failed`          |
| `submitted`       | FAIL    | `failed`          |
| `failed`          | REVERSE | `reversed`        |

`failed -> confirmed` is deliberately not in the table: it exists only as `confirmLate`, which
demands a `confirm` judgement from `lateConfirmation` (a final, canonical event matching the
operation exactly). `confirmed` and `reversed` are terminal. REVERSE needs `mayReverse` to accept
evidence gathered from final chain state ([ADR 0007](../../docs/decisions/0007-never-reverse-on-absence-of-evidence.md)).

## Tests

```bash
pnpm --filter @bridge/domain test
pnpm --filter @bridge/domain test:cov
```

No database and no chain: every edge case (a receipt that vanishes in a reorg, a nonce consumed by
another transaction, a conflicting event under the same reference) is a table row in a unit test.
`test/ledger.property.spec.ts` is a seeded property test of conservation across random journals.
