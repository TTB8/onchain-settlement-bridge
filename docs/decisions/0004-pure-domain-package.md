# 0004. All bridge rules live in a pure domain package

**Status:** accepted

## Context

The expensive bugs in a bridge are in the seams: a rule decided in a controller, a retry computed in
a job, a balance check done next to a database call. Rules mixed with a framework can only be tested
through it.

## Decision

`packages/domain` holds the ledger balancing rules, the operation state machine, confirmation and
reorg logic, nonce and fee bumping, compliance rules and reconciliation as pure functions. It has no
runtime dependencies and no clock, randomness or I/O: time and observations are passed in. ESLint
fails the build if it imports NestJS, Prisma or a chain library.

It deliberately does **not** import the chain package, so it declares its own input types
(`ObservedEvent`, `ObservedReceipt`, ...). The engine maps between them; a type-level check in the
engine keeps the two from drifting.

## Consequences

- The rules read as a specification, and edge cases (a receipt that vanishes in a reorg, a nonce
  consumed by another transaction) are table rows in unit tests, not timing-dependent integration tests.
- The cost is a mapping layer in the engine.
