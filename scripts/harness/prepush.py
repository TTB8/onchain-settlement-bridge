#!/usr/bin/env python3
# harness-kit v0.9.0 - installed copy. Edit in harness-kit, then re-install.
"""git pre-push: block pushes to protected branches, for every author.

This is the layer below the agent guard: it runs for Claude, Codex and humans
alike. A human who really means it can set HARNESS_ALLOW_PROTECTED_PUSH=1 for
that one push. git passes "<local ref> <local sha> <remote ref> <remote sha>"
lines on stdin.
"""
import os
import sys
from pathlib import Path

sys.dont_write_bytecode = True  # never leave __pycache__ in the repo
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import load_manifest, repo_root  # noqa: E402


def main():
    m = load_manifest(repo_root())
    protected = set(m.get("protected", {}).get("branches", []))
    if not protected or os.environ.get("HARNESS_ALLOW_PROTECTED_PUSH") == "1":
        return 0
    hits = set()
    for line in sys.stdin:
        parts = line.split()
        if len(parts) == 4 and parts[2].startswith("refs/heads/"):
            b = parts[2].removeprefix("refs/heads/")
            if b in protected:
                hits.add(b)
    if hits:
        deploy = " A push there deploys to production." if m.get("protected", {}).get("deployOnPush") else ""
        print(f"harness pre-push: {', '.join(sorted(hits))} is protected.{deploy}\n"
              "Push a feature branch and open a PR. A human who really means it:\n"
              "  HARNESS_ALLOW_PROTECTED_PUSH=1 git push ...", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
