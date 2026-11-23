## What and why

<!-- One paragraph. Link the issue if there is one. -->

## How it was checked

<!-- Commands run and their result, verbatim where it matters. -->

## Checklist

- [ ] `python3 scripts/harness/verify.py full` passes locally
- [ ] Tests added or changed for the new behaviour (a fix comes with a test that failed before it)
- [ ] Docs updated: the package README, an ADR in `docs/decisions/` for a design change,
      `CHANGELOG.md` under "Unreleased"
- [ ] Money or on-chain zone touched (`packages/domain`, `packages/engine`, `packages/db`,
      `apps/api/src/operations`, `apps/api/src/balances`, `contracts/src`, `contracts/script`,
      `packages/chain/src`)? Then an independent review was run, its findings are addressed, and the
      `independent-review` label is set
- [ ] No secrets: no real keys, no RPC URLs with API keys, no mainnet addresses (Anvil dev keys only,
      labelled as such)
- [ ] Conventional commit messages
