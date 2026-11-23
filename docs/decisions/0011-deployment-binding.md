# 0011. Operations are bound to one deployment, and a record is never silently replaced

**Status:** accepted

## Context

The single-use reference flags live inside each contract ([0003](0003-single-use-references.md)). If
the engine follows a *new* token deployment while operations are still open, `referenceUsed` on the
new contract is false for references already consumed on the old one, which empties the
duplicate-reference guard and lets a reversal or a resubmission pay twice.

## Decision

- Every operation and every submission attempt records the chain id and the token address it targets.
  The engine never switches deployment while any operation is not terminal.
- `forge script` writes only a **pending** record, and only when broadcasting. A separate
  `promote-deployment.sh` verifies it on chain (code at both addresses, role holders rebuilt from the
  contracts' own logs, the runtime code hash, everything read at one confirmed block) before writing
  the final record, and **refuses to overwrite** an existing one (except on a throwaway local chain,
  by explicit request).
- Off a local chain, the deploy script requires a contract admin and separate role addresses; the
  deployer never keeps a service role.

## Consequences

- A redeploy is a migration procedure (drain or block the queue, then switch), not a configuration
  edit.
- Local development re-deploys freely.
