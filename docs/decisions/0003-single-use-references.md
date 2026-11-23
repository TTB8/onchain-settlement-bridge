# 0003. Every on-chain action carries a single-use reference

**Status:** accepted

## Context

Submitting the same operation twice (a retry after a timeout, a resubmission after a dropped
transaction, a replacement racing the original) must never mint, burn or move twice.

## Decision

Each operation and each compliance change has a UUID. Its 32-byte reference is that UUID, left-padded
with zeros (`packages/domain/src/reference.ts`; the nil UUID is rejected because the contracts
reject the zero reference). The contracts (`SettlementToken`, `ComplianceRegistry`) record every
consumed reference and revert `ReferenceAlreadyUsed` on a second use. The token shares one set
across mint, burn and settle; the registry keeps its own. Every state-changing call emits an event
carrying the reference, so each on-chain effect maps to exactly one ledger operation.

A reference proves only that it was *used*, not what it was used for. So the off-chain side never
treats "this reference is used" as "my operation settled": it compares the settling event's type,
parties, amount and reference with the operation, and anything else is a conflict that needs a
person ([0007](0007-never-reverse-on-absence-of-evidence.md)).

## Consequences

- Idempotency is enforced by the chain itself, not only by the engine's bookkeeping.
- References are per contract: redeploying the token resets them, which is why operations stay bound
  to one deployment ([0011](0011-deployment-binding.md)).
