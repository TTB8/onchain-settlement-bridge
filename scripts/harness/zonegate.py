#!/usr/bin/env python3
# harness-kit v0.9.0 - installed copy. Edit in harness-kit, then re-install.
"""CI gate: a PR that touches a zone requiring `reviewer-label` must carry the
`independent-review` label, added by a human after a fresh reviewer agent (the
repo's declared auditor) has looked at it.

  zonegate.py <base-ref> <labels-json>
Exit 0 = pass, 1 = label missing. Prints which files triggered the gate.
"""
import json
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True  # never leave __pycache__ in the repo
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import load_manifest, repo_root, zones_for  # noqa: E402

LABEL = "independent-review"


def main(argv):
    base, labels = argv[0], json.loads(argv[1] if len(argv) > 1 else "[]")
    root = repo_root()
    m = load_manifest(root)
    files = subprocess.run(["git", "-C", str(root), "diff", "--name-only", f"{base}...HEAD"],
                           capture_output=True, text=True, encoding="utf-8", errors="replace", check=True).stdout.split()
    hits = [(f, z["risk"]) for f in files for z in zones_for(f, m) if "reviewer-label" in z.get("requires", [])]
    if not hits:
        print("zonegate: no reviewer-label zone touched: pass")
        return 0
    names = {l["name"] if isinstance(l, dict) else l for l in labels}
    print(f"zonegate: {len(hits)} file(s) in review-required zones:")
    for f, risk in hits[:30]:
        print(f"  [{risk}] {f}")
    if LABEL in names:
        print(f"zonegate: '{LABEL}' label present: pass")
        return 0
    r = m.get("review", {})
    who = f"{r.get('agent', 'a fresh reviewer agent')}" + (f" (/{r['skill']})" if r.get("skill") else "")
    print(f"\nzonegate: FAIL. Run {who} on this PR, address its findings, then add the '{LABEL}' label.")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
