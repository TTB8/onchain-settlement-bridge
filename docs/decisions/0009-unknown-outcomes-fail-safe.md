# 0009. An unknown outcome is not a rejection

**Status:** accepted

## Context

When sending a transaction fails, "it did not work" covers situations that need opposite reactions.
A timeout, a proxy error or an unfamiliar message may mean the node *did* accept the transaction.
Treating that as a rejection and sending again, or releasing the funds, is a double payment.

## Decision

`mapSubmitError` is an **allowlist** of definite rejections (invalid signature or sender, intrinsic
gas too low, fee cap below the base fee, exceeds the block gas limit, invalid chain id, nonce gap).
Everything else, including wording nobody anticipated, becomes `ChainUnavailableError`: the outcome
is unknown, so check by hash before sending anything again. Even a definite rejection is only
definite for the node that answered (another node behind a load balancer may already hold the same
bytes), so the engine keeps a record of **every signed transaction until its nonce is final** and
counts rejected attempts when deciding whether anything can still land.

A decline is not an error: a mined transaction that reverted is a receipt with status `reverted` and
a decoded reason. The revert reason is a convenience; decisions about money use events and the
contract's own reference flag, never the reason.

RPC URLs (which can carry API keys) are scrubbed from every error and cause the gateway throws.

## Consequences

- A node outage cannot cancel anything or pay anything twice.
- More operations sit in "unknown" until the engine can decide; that is the safe direction.
