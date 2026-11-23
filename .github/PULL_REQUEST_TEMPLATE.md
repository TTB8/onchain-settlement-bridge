## What and why

<!-- One paragraph. Link the issue if there is one. -->

## How it was checked

<!-- Commands run and their result, verbatim where it matters. -->

## Checklist

- [ ] `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test:cov` pass locally
- [ ] Tests added or changed for the new behaviour (a fix comes with a test that failed before it)
- [ ] Docs updated: the package README, an ADR in `docs/decisions/` for a design change,
      `CHANGELOG.md` under "Unreleased"
- [ ] Money or on-chain zone touched (`packages/domain`, `packages/engine`, `packages/db`,
      `apps/api/src/operations`, `apps/api/src/balances`, `contracts/src`, `contracts/script`,
      `packages/chain/src`)? Then an independent review was run (a reviewer who did not write the change)
      and its findings are addressed
- [ ] No secrets: no real keys, no RPC URLs with API keys, no mainnet addresses (Anvil dev keys only,
      labelled as such)
- [ ] Conventional commit messages
