# 0007. Never release held funds because something was not seen

**Status:** accepted

## Context

A failed operation holds the user's funds until it is reversed. Reversing releases them. If the chain
later (or already) settles the same operation, the user is paid twice. The dangerous case is subtle:
a `ReferenceAlreadyUsed` revert with no settling event in *our* index. On the token only a successful
mint, burn or settle consumes a reference, and each emits an event, so "used, but no event we can
see" means our view is incomplete and the money already moved.

## Decision

`mayReverse` (domain) refuses unless **all** hold: no recorded attempt can still be mined (decided
from the final nonce, [0006](0006-settle-on-final-evidence.md)); the canonical index shows no event
for the reference; the contract's own `referenceUsed` flag is false at a final block; and the failure
is not an escalation reason. `duplicate_reference` and `reference_conflict` are escalations: the
operation is failed visibly and a person decides, never an automatic reversal.

A failed operation may still settle late (its attempt landed after we gave up). That path is gated: a
`failed -> confirmed` edge exists only through a function that requires a final event matching the
operation's type, parties, amount and reference, and nothing leaves `reversed`.

## Consequences

- Stuck funds are possible (a person must act); double payment is not.
- An independent review of the first version found the unsafe case, which is why the rule is
  written with the reasoning next to it.
