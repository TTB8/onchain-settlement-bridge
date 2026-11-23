# Harness lessons

One line per lesson: date, what happened, which guide or check now prevents it.
A lesson that recurs becomes a check; one that applies to other repos goes up into harness-kit.

- 2026-11-23: a jest `roots` entry pointed at an empty directory git does not track, so a fresh clone failed before running a single test. `verify.py full` in a fresh worktree caught it; always run it there right after installing. Fixed by tracking the directory.
- 2026-11-23: the guard's credential rule matches credential documents, SSH keys, git/AWS stores and Foundry keystores. A `.env` file is not one of them, so reading it is allowed. Keep `.env` values to local development only (Anvil dev keys), which is the repo rule anyway.
- 2026-11-23: a test command that merely spells out a credential file name or a key-shaped string trips the user-level guard before it runs, even when it is only a payload. Test guards with payload files, not literals on the command line, and do not rewrite the text to slip past it.
- 2026-11-23: a stack whose package does not exist yet only gives a "no checks ran" WARN, and `validate.py` insists every zone path sit under a declared stack, so declare the planned packages up front and the harness covers each one from its first file.
- 2026-11-23: the harness checks do not run Prettier, so a hand-written `harness.json` failed `pnpm format:check` and would have gone red in CI. Run `pnpm lint && pnpm format:check` before committing config and docs-adjacent files, not only `verify.py`.
- 2026-11-23: a mutant that matched transfers on sender and receiver only (ignoring the amount) survived 260 domain tests, because the amount-mismatch tests changed both events together. When a rule compares several fields, mutate each field's comparison on its own.
- 2026-11-23: both team workers reported the wrong number of commits (14 for 13, 8 for 7). Count commits and files with git; treat every number in a hand-back as a claim.
- 2026-11-23: Jest cannot ship an assertion failure containing a BigInt between its parallel workers, so a failing anvil suite shows as "failed to run". Re-run with `--runInBand` to see which test failed.
