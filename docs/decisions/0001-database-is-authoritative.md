# 0001. The database stays the source of truth; the chain enforces and records

**Status:** accepted

## Context

"Just put it on-chain" breaks accounting. A chain cannot reserve funds for a withdrawal that is still
being compliance-checked, cannot reverse a failed operation, and cannot hold the fiat side of a
deposit. A business that makes the chain the ledger loses the books the moment a transaction
reverts, is dropped, or is reorganised away.

## Decision

Balances live in a double-entry ledger in PostgreSQL. The token on chain is a *mirror that enforces
compliance*: it can only move when the ledger has already decided it should, every movement carries
the id of the ledger operation behind it, and a reconciler compares the two continuously.

Every operation reserves funds first (`available -> held`, or fiat `-> incoming`), then settles when
the chain confirms (`held -> ...`), or reverses when it provably will not. Balances are always
derived from postings, never stored (`packages/domain/src/ledger.ts`, and database constraints in
`packages/db`).

## Consequences

- A chain failure is a ledger state (`failed`, then `reversed`), not a lost balance.
- The chain can be wrong (a rogue transfer, a compromised minter). The reconciler exists to say so.
- The ledger has to wait for finality before it treats an on-chain effect as real
  ([0006](0006-settle-on-final-evidence.md)).
