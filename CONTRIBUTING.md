# Contributing

Thanks for looking. This repository moves money between a ledger and a chain, so the bar for a
change is a test that shows it is safe, not only one that shows it works.

## Setup

You need Docker (with `docker compose`), Node 20 or newer with pnpm (`corepack enable`), Foundry
`v1.5.1`, `bash` and `python3`. The full walkthrough, with troubleshooting, is
[docs/local-development.md](docs/local-development.md).

```bash
git clone https://github.com/TTB8/onchain-settlement-bridge.git
cd onchain-settlement-bridge
git submodule update --init --recursive   # forge-std and OpenZeppelin
pnpm install --frozen-lockfile
docker compose up -d                      # Postgres on localhost:5434, Anvil on 127.0.0.1:8545
pnpm setup:local                          # migrate, deploy, promote, register, write .env
```

Only Anvil's public development keys are ever used, and both apps refuse them on any non-local
chain. Never commit a `.env`, a real key, an RPC URL that carries an API key, or a mainnet address.

## Branches and commits

- `main` is protected. Work on a branch (`feat/...`, `fix/...`, `docs/...`) and open a pull
  request. A person merges.
- One commit per logical change, with a [Conventional Commits](https://www.conventionalcommits.org)
  message: `feat(engine): ...`, `fix(api): ...`, `docs: ...`, `test(db): ...`, `chore(ci): ...`.
  The scope is the package or app (`domain`, `chain`, `db`, `engine`, `api`, `worker`,
  `contracts`, `e2e`, `dev`).
- Do not force-push a shared branch.

## Checks

Run these before you push; CI (`.github/workflows/ci.yml`) runs all of them:

| Command                                                    | What it covers                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| `pnpm lint && pnpm format:check && pnpm typecheck`         | ESLint, `forge fmt --check`, Prettier, TypeScript           |
| `pnpm test:cov`                                            | Every package's tests with its coverage thresholds          |
| `pnpm contracts:test` and `pnpm contracts:snapshot:check`  | Foundry unit, fuzz and invariant tests; the gas snapshot    |

A check is never weakened to make a change pass: no auto-fixing inside a check, no test edited only
so that it passes. When a check or a review catches something surprising, add one line to
[docs/engineering-lessons.md](docs/engineering-lessons.md).

## Tests are required

- A new behaviour comes with tests. A bug fix comes with a test that fails without the fix.
- Money and chain rules belong in `packages/domain` as pure functions, tested there first.
- Database guards are tested by attacking them on a real Postgres: assert the guard's own error tag,
  so the test passes only when that guard fired.
- Contracts: unit tests, plus fuzz or invariant tests when the change touches balances, roles or
  references. Run `pnpm contracts:snapshot:check` and regenerate the ABIs
  (`pnpm --filter @bridge/chain abi:generate`) when an interface changes.
- When the fake chain changes, the parity test against Anvil must still pass.

How to run each suite is in the README's "Testing" section.

## Money and on-chain zones need an independent review

The repository has two risk zones:

- **money**: `packages/domain/src`, `packages/engine/src`, `packages/db/prisma`, `packages/db/src`,
  `apps/api/src/operations`, `apps/api/src/balances`
- **onchain**: `contracts/src`, `contracts/script`, `packages/chain/src`

A pull request that touches either one needs an independent review: a reviewer who did not write
the change, working from an audit methodology, with every finding addressed before merge.

## Adding a design decision (ADR)

Design decisions live in [docs/decisions/](docs/decisions/README.md).

1. Copy the format of an existing record: a title `# NNNN. <decision in one line>`, a
   `**Status:**` line, then `## Context`, `## Decision`, `## Consequences`.
2. Take the next number (`0013-short-slug.md`).
3. Say what the alternative was and what the choice costs, so a reader can disagree with the
   reasoning and not only with the result.
4. Add a row to the table in `docs/decisions/README.md`.
5. A decision that is replaced is marked `**Status:** superseded by NNNN`, never edited away.

## Documentation

A change that alters behaviour updates the package README that describes it, and adds a line under
"Unreleased" in [CHANGELOG.md](CHANGELOG.md). Documentation claims must match the code and the
tests: quote real numbers, and name what was not checked.

## Conduct and security

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately,
as described in [SECURITY.md](SECURITY.md).
