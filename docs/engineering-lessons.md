# Engineering lessons

Things that surprised us while building this repository, one line each: what happened and what now prevents it.
Several came from mutation testing (breaking the code on purpose to see whether a test notices) and from independent reviews.

- 2026-11-23: a jest `roots` entry pointed at an empty directory git does not track, so a fresh clone failed before running a single test. A fresh-clone run of the full checks caught it; run them in a fresh clone before publishing. Fixed by tracking the directory.
- 2026-11-23: a mutant that matched transfers on sender and receiver only (ignoring the amount) survived 260 domain tests, because the amount-mismatch tests changed both events together. When a rule compares several fields, mutate each field's comparison on its own.
- 2026-11-23: Jest cannot ship an assertion failure containing a BigInt between its parallel workers, so a failing anvil suite shows as "failed to run". Re-run with `--runInBand` to see which test failed.
- 2026-11-23: in a forge test, a `run()` that reverts leaves its broadcast open, so the test must call `vm.stopBroadcast()`; and `vm.mockCall` on an empty address gives it stub code, so a later CREATE at that address fails unless the test first calls `vm.etch(addr, "")`.
- 2026-11-23: allowances set while holder transfers were switched on can be spent again if the switch is later turned back on, and while it is off nobody can revoke them. This is by design (custodial default is off) and is documented in the token's NatSpec and the decision records.
- 2026-11-23: a mutant that removed a stage check survived the unit tests because a second guard (the negative-balance rule) rejected the same journals, so the test passed for the wrong reason. When two guards reject the same input, make each test assert the specific error of the guard it is about, then mutate each guard on its own.
- 2026-11-23: a safe-looking helper (`mayReverse`) returned true for a failure that meant "our index is incomplete and the money already moved". When a rule decides whether to release funds, ask what the absence of evidence means: here, "no event seen" was not "no settlement happened". Require the authoritative flag, at a final block.
- 2026-11-23: the monitor picked the "newest" attempt by (submitted_at, id); two attempts signed under a frozen test clock tied and the random id decided, so a fee bump could be judged against the old attempt. Order attempts by what defines them (nonce, then bump count), never by a timestamp alone.
