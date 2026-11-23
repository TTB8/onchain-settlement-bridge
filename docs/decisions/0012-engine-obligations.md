# 0012. What the engine must do for the safety properties to hold

**Status:** accepted

## Context

The domain and chain packages make the unsafe things hard, but they take their evidence as inputs.
Their guarantees hold only if the engine gathers that evidence correctly. This list came out of an
independent review and is the engine's acceptance checklist; each item has a test in the engine.

## Obligations

**Attempts and nonces**
1. Persist every signed transaction (raw bytes, hash, nonce, fees, reference, contract) *before*
   broadcasting; keep it until its nonce is final, whatever `submit` returned.
2. Read the head first. `confirmedNonce = getNonce(signer, head)`;
   `finalNonce = getNonce(signer, max(0, head - depth + 1))`. Never classify from the no-block form.
3. Treat any read error as "unknown, retry", never as false, zero or null.
4. `anAttemptCanStillMine` is true if it is true for **any** recorded attempt, including those that got
   a rejection.

**Evidence and state changes**
5. `referenceConsumedOnChain` is `readReferenceUsed('token', ref, finalBlock)` on the contract the
   operation was submitted to.
6. `chainHasEventForRef` comes from the canonical index and counts events of any kind carrying the
   reference.
7. Reverse only when `mayReverse` is true, using evidence gathered in the same pass.
8. Confirm a failed operation or a failed compliance change only through the gated late-confirmation
   path.
9. Pass a settling event only if its reference equals the operation's; re-read it from the canonical
   index each pass and check its block hash against the node.
10. On `wait`, do nothing and re-evaluate later; alarm if the head stops advancing.
11. On `reference_conflict` or `duplicate_reference`, fail with that reason and escalate; never
    reverse automatically.

**Records and compliance**
12. `confirmedBlock` is the receipt or event block, never the head, and only once final.
13. Derive each address's expected compliance flags from final events in (block, log index) order and
    the bridge's latest decision, never from the order changes were confirmed in the database.

**Indexer and reconciliation**
14. Build `detectReorg`'s lookup from the node. On `nodeBehind`, neither roll back nor advance; on
    `beyondWindow`, stop and ask a person.
15. Reconcile at a final block; take canonical block hashes from the node at run time, never from the
    indexer's own records.
16. Read balances for every address in the expectations and in any `Transfer` since the deployment
    block; read compliance flags for that set plus every account a compliance event touched.

**Deployment and concurrency**
17. Bind every operation and attempt to (chain id, token address); never switch deployment while any
    operation is not terminal ([0011](0011-deployment-binding.md)).
18. Reserve funds and read the balance under one row lock or a serializable transaction; the domain's
    check is only a comparison.

## Consequences

- The engine is where most of the remaining risk is, so it carries most of the end-to-end tests.
