# Security policy

This is a reference implementation, published as a portfolio piece. It has not had a human
security audit and it is not deployed anywhere with real money. Read the README's
"Out of scope / known limits" before you build on it.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting:
**Security** tab of this repository, then **Report a vulnerability**
(<https://github.com/TTB8/onchain-settlement-bridge/security/advisories/new>).

Please do not open a public issue, pull request or discussion for a security problem.

A useful report says:

- what an attacker (or a fault: a crash, a reorg, a node error) can make the system do;
- the commit you looked at;
- the steps, ideally as a failing test (a Foundry test, or a Jest test against the fake chain);
- which safety property from the README it breaks.

Reports are handled on a best-effort basis by one maintainer. There is no response-time
commitment and no bug bounty.

## Scope

In scope, at the latest commit of `main`:

- `contracts/src` and `contracts/script`: the token, the compliance registry, the deploy and
  promotion scripts;
- `packages/domain`, `packages/engine`, `packages/db` (schema and SQL guards), `packages/chain`;
- `apps/api` and `apps/worker`.

Out of scope:

- `e2e/` and `scripts/` local-development tooling (they refuse to run off a local chain);
- the Anvil development keys in `.env.example` and the tests: they are public on purpose and
  refused by both apps on any non-local chain;
- third-party dependencies (report those upstream), unless this repository uses them unsafely.

## What counts as a vulnerability

Examples of what is a vulnerability here:

- a path where the ledger and the chain end up disagreeing without the reconciler reporting it;
- any way to pay a user twice, mint twice, or release held funds while the chain can still settle;
- a way past the contracts' compliance check (an unverified or frozen address moving tokens);
- a secret (key, token, RPC URL with credentials) reaching a log line, an error or an API response;
- an API route reachable without the right bearer token scope.

Not a vulnerability (these are documented limits, see the README):

- anything that needs the platform token, the admin token, a signer key or the database owner
  role, where the README says that holder is trusted (for example: the platform token can create
  supply, because a deposit is the platform's assertion that fiat arrived);
- a stuck nonce that leaves funds held and raises an alarm;
- missing rate limiting, missing per-operator identities, alarms that are only log lines.
