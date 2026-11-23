# 0008. Compliance is enforced by the contracts, in a custodial model

**Status:** accepted

## Context

If compliance lives only in the API, anyone who reaches the chain by another route (a leaked key, a
direct call) bypasses it. This bridge is custodial: users hold no keys, and the platform moves tokens
on their behalf.

## Decision

`ComplianceRegistry` holds the allowlist (verified addresses) and freezes, managed by a compliance
role. `SettlementToken` checks the registry on **every** balance change through one internal choke
point: both ends must be verified and not frozen, and the token must not be paused. A frozen address
can neither send, receive nor be burned from. Compliance changes reach the registry through the same
outbox as everything else ([0002](0002-transactional-outbox.md)).

Because users hold no keys, holder-signed ERC-20 `transfer`, `transferFrom` and `approve` are **off by
default** behind an admin switch. When switched on they are hardened (the spender and the owner must
be allowed; `approve` is blocked while paused) and still emit no reference event, which is how the
reconciler recognises them as movements the ledger did not authorise.

## Deliberate limitations (see the README's "Out of scope")

- **No forced transfer or burn, no recovery path.** A frozen holder's balance can be acted on by no
  role. A production deployment would add a separately held enforcement role.
- **No mint cap and a single-step admin.** A compromised minter can mint without bound until the
  reconciler flags it. A production deployment would add a cap and a two-step, delayed admin.
- Admin events (role grants, pause, the holder-transfer switch) are not reconciled; alert on them.

## Consequences

- The registry is fixed at token deployment (immutable): swapping it would change who may hold the
  token, which should be a new deployment ([0011](0011-deployment-binding.md)), not a setting.
