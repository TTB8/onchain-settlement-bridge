# 0005. Chain access behind one interface, a faithful fake, and a parity test

**Status:** accepted

## Context

The failures that matter (a revert, a dropped transaction, a stuck fee, a reorg that removes a
mined transaction) cannot be produced on demand against a real node, so they would go untested.

## Decision

All chain access goes through `ChainGateway`, written in the language of the two contracts (typed
calls, typed events, receipts with decoded revert names), not of a chain library.
`ViemChainGateway` talks to a real node. `FakeChainGateway` is an in-memory chain that mirrors the
contracts' rules and check order exactly and can simulate reverts, dropped and stuck transactions,
slow confirmations and reorgs. A parity test runs the same scenarios against the fake and a real
Anvil and asserts they agree; the known differences (fee-replacement threshold, same-block revert
reasons) are pinned and written down.

## Consequences

- Engine unit tests run against failures a real node only produces by accident.
- The fake can drift from the contracts; the parity test and the ABI check (committed ABIs must
  equal a fresh Foundry build) are what stop it.
