# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

The first version, 0.1.0, not released yet.

- **Contracts** (`contracts/`, Foundry): `SettlementToken`, an ERC-20 with six decimals where every
  balance change is checked against `ComplianceRegistry` (verified and not frozen, both ends) and
  every platform-driven mint, burn and transfer consumes a single-use reference. Holder-signed
  transfers are off by default behind an admin switch. Role-separated deploy script and a
  promotion script that verifies a deployment on chain before recording it. Unit, fuzz and
  invariant tests and a gas snapshot.
- **Domain** (`packages/domain`): the bridge rules as pure functions: double-entry journal, the
  operation state machine with a gated late confirmation, finality and reorg detection, nonce and
  fee-bump logic, compliance ordering, reversal evidence and reconciliation.
- **Database** (`packages/db`): PostgreSQL 16 schema with SQL guards: balanced entries at commit,
  no overdraft, append-only history, legal transitions only, deployment binding, one outbox row per
  signer nonce.
- **Chain gateway** (`packages/chain`): one interface, a viem implementation, an in-memory fake that
  can simulate reverts, drops, stuck fees and reorgs, and a parity test of the two on Anvil.
- **Engine** (`packages/engine`): transactional outbox and dispatcher with leases, settlement and
  compliance submitters (sign, verify, commit, then broadcast), transaction and compliance
  monitors, a reorg-aware indexer and a reconciler that persists every run.
- **API** (`apps/api`, NestJS): users, deposits, withdrawals, transfers, balances, compliance
  changes and reconciliation runs, with idempotency keys, two disjoint bearer-token scopes,
  RFC 9457 errors and an OpenAPI document.
- **Worker** (`apps/worker`): runs the engine loop with startup refusals and a bounded shutdown.
- **Local development**: `docker compose` stack, `pnpm setup:local`, `pnpm dev`, `pnpm demo`
  (including a rogue mint the reconciler catches), and an end-to-end suite on a real chain.
- **Docs**: twelve design decision records, package READMEs, and the community files.

[Unreleased]: https://github.com/TTB8/onchain-settlement-bridge/commits/main
