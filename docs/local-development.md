# Local development

This page takes you from a fresh clone to a running bridge: a ledger in Postgres, two contracts on
a local Anvil chain, the API and the worker. Then it shows money moving end to end. Everything
here is **local and DEV ONLY**. The only private keys are Anvil's public development keys,
labelled as such in `.env.example`. Both apps refuse those keys on any real chain.

## What you need

- Docker (with the `docker compose` plugin)
- Node 20 or newer, with pnpm (`corepack enable` gives you the version pinned in `package.json`)
- Foundry `v1.5.1` (`forge`, `cast`, `anvil`), installed with `foundryup`. It can live in
  `~/.foundry/bin`, and the scripts look there too.
- `bash` (version 4 or newer) and `python3`. The deployment promotion script uses them.
- The Solidity libraries are git submodules: `git submodule update --init --recursive`

## Quickstart

```bash
docker compose up -d          # Postgres on localhost:5434, Anvil (chain 31337) on 127.0.0.1:8545
pnpm install
pnpm setup:local              # migrate, deploy, promote, register, write .env
pnpm dev                      # API + worker, in this terminal
pnpm demo                     # in a second terminal
```

Then open Swagger at **http://127.0.0.1:3000/docs**. The raw document is at `/docs/openapi.json`.
The API takes two bearer tokens, `API_PLATFORM_TOKEN` for user and money routes and
`API_ADMIN_TOKEN` for compliance and reconciliation. Both are in your `.env`.

### What `pnpm setup:local` does

The script is `scripts/setup-local.ts`, and each step is documented in `scripts/lib/setup.ts`.

1. It reads `.env` if you have one, otherwise `.env.example`.
2. It checks that Postgres and the node answer. If they don't, it tells you to run
   `docker compose up -d`. It **refuses** a node that is not chain 31337, and any RPC or database
   URL that is not on this machine.
3. It creates the dev database `bridge` if it is missing, applies the migrations
   (`prisma migrate deploy`) and seeds the one system account.
4. It runs `forge build`.
5. If the database already has an ACTIVE deployment that is still on this chain, it reuses it
   and skips steps 6 and 7.
6. It deploys with `contracts/script/Deploy.s.sol`. Account #0 deploys and stays admin. Account
   #1 is the settlement signer (minter + settler). Account #2 is the compliance signer. Account
   #3 is the pauser. It then mines `CONFIRMATION_DEPTH + 1` blocks and promotes the record with
   `contracts/script/promote-deployment.sh`. That script checks the code, the roles and the
   switches on chain before it writes `contracts/deployments/31337.json`.
7. It inserts the ACTIVE `deployment` row and its two `signer_state` rows.
8. It writes `.env` from `.env.example` with `TOKEN_ADDRESS` and `REGISTRY_ADDRESS` filled in.
   It does this only if git ignores the file. It **never** overwrites a `.env` that points at
   another deployment unless you pass `--force`, and then the old file goes to `.env.bak`.

The script is safe to re-run. A second run changes nothing. It never prints a token, a key or a
password.

| Flag         | When                                                                 |
| ------------ | -------------------------------------------------------------------- |
| `--force`    | Your `.env` points at another deployment and you want a fresh one    |
| `--reset-db` | Anvil was restarted (a fresh chain): drop and recreate the dev database |

Exit codes: 0 means done, 1 means refused or failed, 2 means a flag is needed (the message says
which).

### What `pnpm demo` does

The script is `scripts/demo.ts`, with its steps in `scripts/lib/demo.ts`. It uses **only the
public HTTP API**, with the tokens from `.env`:

- It creates two users with Anvil dev wallets #4 (alice) and #5 (bob), and allows both through
  the admin route.
- It runs deposit 100 to alice, then transfer 40 from alice to bob, then withdrawal 15 by bob.
  It waits for each operation to be `confirmed` and prints its statuses and transaction hash.
- It prints each user's ledger balance next to the token balance read from the node.
- It runs a reconciliation and prints `CLEAN: 0 mismatches`, or the mismatches.

`pnpm demo --rogue` then has the dev minter mint 5 tokens to alice **directly on the token,
outside the bridge**. The reconciler catches it. This leaves your local chain permanently out of
line with the ledger, so reset afterwards (see below).

The demo exits 0 only when the run is clean (and, with `--rogue`, only when the rogue mint was
caught). Re-running the demo is fine: the users and their approvals are reused, and the balances
add up.

### A real run

This transcript is from a clean stack. The API was on port 3100 because port 3000 was taken on
that machine (see Troubleshooting). Output is trimmed only where marked.

```text
$ pnpm setup:local
setup:local: [1/8] settings from .env.example
setup:local: [2/8] checking the local stack
setup:local:   Postgres localhost:5434 ok; node 127.0.0.1:8545 is chain 31337
setup:local: [3/8] database bridge
setup:local:   created database bridge
setup:local:   migrations applied
setup:local: [4/8] building the contracts (forge build)
setup:local: [5/8] looking for a registered deployment
setup:local:   none: deploying
setup:local: [6/8] deploying with contracts/script/Deploy.s.sol, then promoting
setup:local:   promote-deployment: checking chain 31337 at block 7 (head 8, 1 confirmation(s))
setup:local:   promote-deployment: chain 31337 verified at block 7; registry 0x5fbdb2315678afecb367f032d93f642f64180aa3, token 0xe7f1725e7734ce288f8367e1bb143e90bb3f0512.
setup:local:   promote-deployment: wrote deployments/31337.json and removed the pending record
setup:local: [7/8] registering the deployment and its signers in the database
setup:local:   deployment e452fcdb-4862-4ea2-ad53-84eea0d4f5e5: token 0xe7f1725e7734ce288f8367e1bb143e90bb3f0512, registry 0x5fbdb2315678afecb367f032d93f642f64180aa3
setup:local: [8/8] .env
setup:local:   wrote .env from .env.example (TOKEN_ADDRESS, REGISTRY_ADDRESS filled)
setup:local: done. Deployed token 0xe7f1725e7734ce288f8367e1bb143e90bb3f0512, registry 0x5fbdb2315678afecb367f032d93f642f64180aa3.

$ pnpm demo
API http://127.0.0.1:3100 is ready
user alice: 0x15d34aaf54267db7d7c367839aaf71a00a2c6a65 (id 4394cbae-aeac-4ece-9cbd-16c8f9be0716)
user bob: 0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc (id 9e02183f-7d5a-4a22-a2c6-d76408aeb637)
allow alice: confirmed (block 9)
allow bob: confirmed (block 10)
deposit 100.000000 to alice: ledger_reserved -> submitted -> confirmed (block 11)
  tx 0xe9b422d0a10f7fe3fd9cf2c47b8920247adc875de10e69dc7c61c34bf8c9377a (nonce 0, sent)
transfer 40.000000 alice -> bob: ledger_reserved -> confirmed (block 12)
  tx 0x7717de61aaf298b803e383f0ee3dc88d3868f0e695f550fd74c4f4131055211a (nonce 1, sent)
withdrawal 15.000000 by bob: ledger_reserved -> confirmed (block 13)
  tx 0x984d10c9b0e90f4ead5d782e521db5fcb4c1ba5a58094ce53b68674b50ac5964 (nonce 2, sent)
balances (ledger expectedOnChain | on chain):
  alice      60.000000 |      60.000000  equal
  bob        25.000000 |      25.000000  equal
reconciliation:
  CLEAN: 0 mismatches (final block 13)
demo: OK

$ pnpm demo --rogue
[... the same flow again ...]
reconciliation:
  CLEAN: 0 mismatches (final block 16)
rogue: the dev minter 0x70997970c51812dc3a010c7d01b50e0d17dc79c8 mints 5.000000 to alice directly on the token, outside the bridge
  tx 0x1cee42f4c85ba2a601eb3e88e8cb80bf3812871cd89853018a11693f8382a7fa (mined in block 17)
reconciliation after the rogue mint:
  MISMATCH: 3 mismatches (final block 17)
    - unexpected_onchain_event (why=unknown_reference)
    - balance_mismatch (address=0x15d34aaf54267db7d7c367839aaf71a00a2c6a65, expected=120000000, observed=125000000)
    - supply_mismatch (expected=170000000, observed=175000000)
the reconciler caught the mint that bypassed the bridge.
the local chain now disagrees with the ledger for good: reset with  docker compose restart anvil && pnpm setup:local --reset-db
demo: OK
```

A status the poller never saw (for example `submitted` on a fast local chain) is skipped in the
progress line. The `sent` next to a hash is the attempt's recorded status. The engine does not
record `mined` on attempts, so the operation's `confirmed` status and block are what count.

## Tests

| Command                                   | What runs                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm test`                               | Every package's suite, the end-to-end suite included                                      |
| `pnpm test:e2e`                           | The end-to-end suite only (`e2e/`, about one minute)                                      |
| `pnpm --filter @bridge/api test`          | One package                                                                               |
| `pnpm lint && pnpm format:check && pnpm typecheck` | Static checks                                                                    |
| `python3 scripts/harness/verify.py fast`  | The repo's harness checks for what you changed                                            |
| `pnpm contracts:test`                     | Foundry unit, fuzz and invariant tests                                                    |

The end-to-end suite (`e2e/test/*.e2e.test.ts`) needs the compose Postgres on `localhost:5434`,
plus `anvil`, `forge`, `cast`, `bash` and `python3`. **It does not use the compose Anvil, and it
does not touch the dev database.** Each file creates its own database (`bridge_e2e_test_<hex>`,
dropped at the end) and spawns its own `anvil` on a free port (killed at the end). It deploys
with the real `setup:local` code path, starts the API with its own `startApi`, and runs the
engine the way the worker builds it.

- `bridge.e2e`: deposit, transfer and withdrawal with ledger == chain at every step and the tx
  hashes; a rogue mint reported by the reconciliation endpoint; an idempotent replay that gives
  one operation and one transaction; a 422 with nothing sent; a frozen sender's transfer that
  reverts on chain and ends `reversed` with the funds released; and a stopped node that gives
  `unknown` (never ok).
- `local-dev.e2e`: the `setup:local` refusals, the first run, the re-run, the `.env` rule, the
  demo against the real worker loop (clean, `--rogue`, then a failing plain run), and the
  restarted chain.
- `setup-local.unit` and `demo.unit`: the pure parts of both scripts.

The files run in band (one at a time), because each one deploys with `forge script`, which
writes one fixed pending record in `contracts/deployments`. Do not run `pnpm setup:local` while
the e2e suite is running.

### In CI

The job needs the same services and tools as the TypeScript job in `.github/workflows/ci.yml`:
a Postgres 16 service on port 5434 (user and password `bridge`), Foundry `v1.5.1`, and the
submodules checked out. Then:

```bash
pnpm install --frozen-lockfile
(cd contracts && forge build)
DB_TEST_ADMIN_URL=postgresql://bridge:bridge@localhost:5434/postgres pnpm test:e2e
```

`pnpm test` and `pnpm test:cov` also include the suite. There is no coverage threshold for it.

## Troubleshooting

**`setup:local: the local stack is not up`** or **`dev: not starting`.** Run `docker compose up -d`
and wait until `docker compose ps` shows both services `healthy`.

**A port is taken.** For example `api: refusing to start: Error: listen EADDRINUSE ... 127.0.0.1:3000`.
Something else is listening on that port. Find it with `ss -ltnp | grep :3000` (Linux) or
`lsof -i :3000` (macOS).

- For the API, set another `API_PORT` in `.env` (for example `3100`). `pnpm demo` reads the same
  value.
- For Postgres (5434) or Anvil (8545), change the host side of `ports:` in `docker-compose.yml`,
  then change `DATABASE_URL` or `RPC_URL` in `.env` to match.

**Docker is stuck,** or a container keeps restarting. Run `docker compose logs postgres anvil`,
then `docker compose down` and `docker compose up -d`. `down` keeps the database volume. If
`docker compose up` says a name or port is already in use, an old stack is still running: check
with `docker compose ls`.

**Reset the chain and the dev database.** Do this after `--rogue`, after any Anvil restart, or
whenever you want a clean slate. Stop `pnpm dev` first (Ctrl+C), then:

```bash
docker compose restart anvil      # a fresh chain (Anvil keeps no state)
pnpm setup:local --reset-db       # drop + recreate the dev database, deploy again
```

If you restart Anvil and run `pnpm setup:local` without `--reset-db`, it refuses: "the database
bridge holds an ACTIVE deployment for chain 31337, but its contracts have no code on this chain
(was Anvil restarted?)". The old operations belong to the old chain, and the worker would refuse
them too.

**Reset only the database:** run `pnpm setup:local --reset-db`. This deploys fresh contracts, so
the old supply on the chain does not count against the new, empty ledger.

**Wipe everything, the database volume included:** run `docker compose down -v`, then
`docker compose up -d`, then `pnpm setup:local`.

**`.env exists and points at another deployment`** (exit code 2). Run `pnpm setup:local --force`.
Your old file is kept as `.env.bak`. Copy any edits you need (such as `API_PORT`) back into the
new `.env`.

**The worker exits 1 at startup.** Usually no ACTIVE deployment matches `TOKEN_ADDRESS` /
`REGISTRY_ADDRESS`, or a signer row does not match the keys. Run `pnpm setup:local`; it fixes
both, or tells you why it can't.

**The demo times out** (`still ledger_reserved after 60000 ms`). The worker is not running or it
stopped. Check the `[worker]` lines in the `pnpm dev` terminal.

**The demo prints `MISMATCH` or `DIFFERENT`** without `--rogue`. The chain and the ledger disagree:
a previous `--rogue`, or something else that sent transactions to the dev chain. Reset as above.
