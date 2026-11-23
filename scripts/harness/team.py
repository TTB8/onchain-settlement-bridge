#!/usr/bin/env python3
# harness-kit v0.9.0 - installed copy. Edit in harness-kit, then re-install.
"""Team routing for /team: which agent, which model, which reviewer, which level.

  python3 scripts/harness/team.py plan <path>... [--json]
  python3 scripts/harness/team.py plan --changed [--json]

<path> is a file or directory the task will touch (repo-relative). The plan is
deterministic: it comes from harness.json (stacks, zones, team), not from the
lead's memory, so the floors can't be forgotten:

  - any path in a money, onchain or pii zone: the worker and the reviewer run on opus
  - patrick always runs on opus
  - team.minimumModel raises every floor (e.g. a client that wants nothing below sonnet)

The lead may pick a cheaper model than the default (haiku for a mechanical sweep),
never one below the floor. Paths no stack or route covers go to the lead.
"""
import json
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import load_manifest, repo_root, stack_for, zones_for, changed_files  # noqa: E402

RANK = {"haiku": 0, "sonnet": 1, "opus": 2}
ZONE_FLOOR = "opus"
# Kit defaults; tests keep these in sync with the agents' frontmatter.
ROLE_MODEL = {"patrick": "opus", "compliance-officer": "opus", "tokenization-architect": "opus",
              "solidity-engineer": "sonnet", "backend-engineer": "sonnet", "ui-engineer": "sonnet",
              "devops-engineer": "sonnet", "lead": "sonnet"}
PACK_AGENT = {"foundry": "solidity-engineer", "nestjs-prisma": "backend-engineer", "node-ts": "backend-engineer",
              "nextjs": "ui-engineer", "terraform": "devops-engineer"}
RISK_REVIEWER = {"onchain": "patrick", "money": "patrick", "pii": "compliance-officer"}


def top(*models):
    return max((m for m in models if m), key=lambda m: RANK[m])


def route(path, manifest):
    """(area, pack, agent) for one path. Explicit team.routes win over the stack default."""
    path = path.replace("\\", "/").removeprefix("./").rstrip("/")
    team = manifest.get("team") or {}
    best = None
    for r in team.get("routes", []):
        for rp in r["paths"]:
            rp = rp.replace("\\", "/").rstrip("/")
            if rp in (".", "") or path == rp or path.startswith(rp + "/"):
                if best is None or len(rp) > len(best[0]):
                    best = (rp or ".", r["agent"])
    stack, sp = stack_for(path, manifest)
    pack = stack["pack"] if stack else None
    if best:
        return best[0], pack, best[1]
    if stack:
        return sp, pack, PACK_AGENT.get(pack, "lead")
    return ".", None, "lead"


def zone_risks(path, manifest):
    """Risks a path touches. A directory touches a zone that lies inside it (apps/api/src holds
    apps/api/src/payments/**) as well as one that contains it."""
    path = path.replace("\\", "/").removeprefix("./").rstrip("/")
    risks = {z["risk"] for z in zones_for(path, manifest)} | {z["risk"] for z in zones_for(path + "/x", manifest)}
    for z in manifest.get("zones", []):
        for pat in z["paths"]:
            fixed = re.split(r"[*?\[]", pat.replace("\\", "/").removeprefix("./"), maxsplit=1)[0]
            if path in (".", "") or fixed.startswith(path + "/"):
                risks.add(z["risk"])
    return risks


def plan(paths, manifest):
    team = manifest.get("team") or {}
    models = team.get("models") or {}
    minimum = team.get("minimumModel", "haiku")
    reviewers = {**RISK_REVIEWER, **(team.get("reviewers") or {})}
    areas = {}
    for p in paths:
        area, pack, agent = route(p, manifest)
        a = areas.setdefault((area, agent), {"area": area, "pack": pack, "agent": agent, "paths": [], "zones": set()})
        a["paths"].append(p)
        a["zones"].update(zone_risks(p, manifest))
    out, risks = [], set()
    for a in areas.values():
        default = models.get(a["agent"], ROLE_MODEL.get(a["agent"], "sonnet"))
        floor = top(minimum, ZONE_FLOOR if a["zones"] else None, "opus" if a["agent"] == "patrick" else None)
        risks |= a["zones"]
        out.append({**a, "zones": sorted(a["zones"]), "model": top(default, floor), "default": default, "floor": floor,
                    "why": (f"zone {', '.join(sorted(a['zones']))} -> opus floor" if a["zones"] else
                            "patrick always runs on opus" if a["agent"] == "patrick" else
                            f"minimumModel {minimum}" if RANK[minimum] > RANK[default] else "role default")})
    review = []
    for r in sorted(risks):
        rv = reviewers.get(r)
        if rv and rv not in [x["reviewer"] for x in review]:
            review.append({"reviewer": rv, "for": [x for x in sorted(risks) if reviewers.get(x) == rv], "model": "opus"})
    workers = [a for a in out if a["agent"] != "lead"]
    if risks:
        level, why = "L3", "a risk zone is touched: independent review before it reaches the user"
    elif len(workers) >= 2:
        level, why = "L2", "several independent areas: one worker per area, each in its own worktree"
    elif workers:
        level, why = "L1", "one area: one worker (L0, the lead alone, is fine if the change is trivial)"
    else:
        level, why = "L0", "no stack area: the lead does it"
    return {"level": level, "why": why, "areas": sorted(out, key=lambda a: a["area"]), "review": review}


def show(p):
    print(f"Level {p['level']}: {p['why']}")
    for a in p["areas"]:
        z = f"  zones: {', '.join(a['zones'])}" if a["zones"] else ""
        print(f"  {a['area']} ({a['pack'] or 'no stack'}) -> {a['agent']} on {a['model']}"
              f" (default {a['default']}, floor {a['floor']}: {a['why']}){z}")
    for r in p["review"]:
        print(f"  review: {r['reviewer']} on {r['model']} for {', '.join(r['for'])}")
    print("The lead may choose a cheaper model than the default for mechanical work, never one below the floor.")


def main(argv):
    if not argv or argv[0] != "plan":
        sys.exit(__doc__)
    args = [a for a in argv[1:] if not a.startswith("--")]
    root = repo_root()
    manifest = load_manifest(root)
    if not manifest:
        sys.exit("team: no readable harness.json in this repo (run /harness-install first)")
    paths = changed_files(root) if "--changed" in argv else args
    if not paths:
        sys.exit("team: name the paths the task will touch (or --changed)")
    p = plan(paths, manifest)
    if "--json" in argv:
        print(json.dumps(p, indent=2))
    else:
        show(p)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
