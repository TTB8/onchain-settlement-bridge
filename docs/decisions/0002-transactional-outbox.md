# 0002. A transactional outbox; the chain is never called inside a database transaction

**Status:** accepted (implemented in the engine)

## Context

A request that writes the ledger and then calls the chain has two bad endings: the ledger commits and
the call fails (money reserved, nothing sent), or the call succeeds and the ledger rolls back (a
payment with no record). A database transaction cannot span a blockchain.

## Decision

The API writes the operation, its reserve entry and an outbox row in **one** database transaction.
A separate worker reads the outbox and talks to the chain. The chain call never happens inside a
database transaction, and a locked row is never held across a network call.

The outbox row is keyed by the operation's reference ([0003](0003-single-use-references.md)), so
retrying a row after a crash re-sends the same logical operation, and the contract refuses a second
settlement of it.

## Consequences

- At-least-once delivery to the chain, made safe by single-use references.
- The worker can be stopped, restarted or duplicated without losing or duplicating an operation.
- Latency is the worker's polling interval; this is a settlement system, not an exchange.
