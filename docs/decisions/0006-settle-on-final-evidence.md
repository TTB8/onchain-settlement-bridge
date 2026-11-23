# 0006. Decide on final evidence, never on the head

**Status:** accepted

## Context

A transaction in block N with fewer than `depth` confirmations can still be removed by a reorg.
Treating it as settled, or treating a nonce as used, from the head's view would let the ledger act on
something the chain later forgets, including reversing an operation whose original transaction then
returns.

## Decision

Nothing is trusted before it is `depth` confirmations deep. The engine reads the signer's nonce at
block `head - depth + 1` (`getNonce(signer, block)`) to learn whether a nonce is *finally* used; a
receipt or settling event counts only once its block is that deep; the contract's own reference flag
is read at that same block. Where the evidence is not final yet, the answer is `wait`, never a guess.
Reconciliation runs at a final block and takes its canonical block hashes from the node at run
time, so events from orphaned blocks are reported as stale instead of satisfying a check.

A reorg deeper than the configured depth is outside the guarantee; the indexer stops and asks for a
person ([0012](0012-engine-obligations.md)).

## Consequences

- Latency is `depth` blocks (1 on Anvil, configurable on a testnet).
- Every "is this safe?" function takes the finality inputs as arguments, so it is a pure function and
  testable at the exact boundary.
