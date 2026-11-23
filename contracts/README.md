# contracts

Two Solidity contracts (0.8.28, OpenZeppelin, Foundry `v1.5.1`) that enforce on chain what the
ledger decides off chain. The ledger in Postgres is the source of truth
([ADR 0001](../docs/decisions/0001-database-is-authoritative.md)); these contracts make sure the
chain can only move in ways that pass compliance and that each move maps to exactly one ledger
operation.

| Contract                 | What it does                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `src/ComplianceRegistry.sol` | Allowlist (`verified`) and `frozen` flags per address, changed only by `COMPLIANCE_ROLE`; every change consumes a single-use reference and emits `VerificationSet` / `FrozenSet` with it |
| `src/SettlementToken.sol`    | ERC-20, 6 decimals. `mint`, `burn` (`MINTER_ROLE`) and `settleTransfer` (`SETTLER_ROLE`) each consume a single-use reference and emit `Minted` / `Burned` / `SettledTransfer` with it. Every balance change goes through one `_update` override: not paused, and both ends allowed by the registry. `PAUSER_ROLE` halts every movement |

Design points, each explained in the contract's NatSpec and the decision records:

- **References are single-use per contract.** A second use reverts `ReferenceAlreadyUsed`; the
  zero reference is refused. The token shares one set across mint, burn and settle
  ([ADR 0003](../docs/decisions/0003-single-use-references.md)).
- **Compliance is enforced here, not only in the API.** A frozen or unverified address can neither
  send, receive nor be burned from, by any role
  ([ADR 0008](../docs/decisions/0008-compliance-in-the-contract.md)).
- **Holder-signed ERC-20 (`transfer`, `transferFrom`, `approve`) is off by default**, because the
  model is custodial. The admin can switch it on with `setHolderTransfersEnabled`; it is then
  compliance-checked too and emits no reference event, which is how the reconciler recognises it
  as a movement the ledger did not authorise. `approve(spender, 0)` (a revoke) is always accepted.
- **The registry is immutable on the token.** A different registry is a new deployment
  ([ADR 0011](../docs/decisions/0011-deployment-binding.md)).

## Deploying

`script/Deploy.s.sol` takes role addresses from the environment and the deployer key on the
`forge script` command line (never from the environment). It refuses a known mainnet without
`ALLOW_MAINNET=true` and an unknown chain without `ALLOW_UNKNOWN_CHAIN=true`; off Anvil it also
requires `ADMIN_ADDRESS` (a contract unless `ALLOW_EOA_ADMIN=true`), a compliance address
separate from the other roles, and no service role left with the deployer. A broadcast writes only
`deployments/<chainId>.pending.json`.

`script/promote-deployment.sh <chainId> <rpcUrl> [confirmations]` checks that pending record
against one confirmed block (code and runtime bytecode, wiring, every role holder rebuilt from the
role events, the holder switch) and only then writes `deployments/<chainId>.json`. It never
replaces an existing record, except on local chain 31337 with `PROMOTE_REPLACE=1`.
`script/test-promote.sh` tests it against its own Anvil.

For local development, `pnpm setup:local` runs both for you (see
[docs/local-development.md](../docs/local-development.md)).

## Tests

```bash
forge test                                   # unit, fuzz (1000 runs) and invariant (256 x 64) tests
forge snapshot --check --no-match-test "testFuzz|invariant"
forge coverage --report summary --no-match-coverage "(test|script)"
bash script/test-promote.sh                  # from the repository root: bash contracts/script/test-promote.sh
```

| Suite                                   | What it proves                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| `test/SettlementToken.t.sol`, `test/ComplianceRegistry.t.sol` | Functions, role checks, reverts and events of each contract              |
| `test/*.fuzz.t.sol`                     | Conservation, exactly-once references, role exclusivity, frozen balances never move, the holder switch never affects the platform paths |
| `test/invariants/SettlementInvariants.t.sol` | Against a model under random action sequences: supply equals the sum of balances and minted minus burned, a restricted balance never moves, every reference settles at most once, no valid action was refused |
| `test/Deploy.t.sol`                     | The deploy script's refusals and the wiring it leaves behind                            |

The root `pnpm contracts:*` scripts wrap these commands.
