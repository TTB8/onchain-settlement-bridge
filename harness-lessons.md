# Harness lessons

One line per lesson: date, what happened, which guide or check now prevents it.
A lesson that recurs becomes a check; one that applies to other repos goes up into harness-kit.

- 2026-11-23: a jest `roots` entry pointed at an empty directory git does not track, so a fresh clone failed before running a single test. `verify.py full` in a fresh worktree caught it; always run it there right after installing. Fixed by tracking the directory.
- 2026-11-23: the guard's credential rule matches credential documents, SSH keys, git/AWS stores and Foundry keystores. A `.env` file is not one of them, so reading it is allowed. Keep `.env` values to local development only (Anvil dev keys), which is the repo rule anyway.
- 2026-11-23: a test command that merely spells out a credential file name or a key-shaped string trips the user-level guard before it runs, even when it is only a payload. Test guards with payload files, not literals on the command line, and do not rewrite the text to slip past it.
- 2026-11-23: a stack whose package does not exist yet only gives a "no checks ran" WARN, and `validate.py` insists every zone path sit under a declared stack, so declare the planned packages up front and the harness covers each one from its first file.
