#!/usr/bin/env python3
# harness-kit v0.9.0 - installed copy. Edit in harness-kit, then re-install.
"""Run the repo's checks, driven by harness.json.

  verify.py fast            checks for changed files only (Stop hook, pre-commit)
  verify.py fast --staged   same, for staged files only (pre-commit)
  verify.py full            every stack, every package (before a PR; CI mirrors it)

Fast mode runs, per changed stack: typecheck, lint on the changed files (never
--fix: a sensor reports, it doesn't rewrite), and tests related to the changed
files. A change inside a zone that requires zone-tests runs that package's whole
unit suite instead. Exit 0 = pass, 1 = a check failed. Missing tools are reported
as WARN so a check is never silently skipped.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path, PurePosixPath

sys.dont_write_bytecode = True  # never leave __pycache__ in the repo
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import changed_files, load_manifest, repo_root, stack_for, zones_for  # noqa: E402

CODE = re.compile(r"\.(ts|tsx|js|jsx|mjs|cjs)$")
TIMEOUT = 900
results = []  # (status, label, seconds, detail)


def resolve(exe):
    """Full path for a command name. On Windows, pnpm/npm/yarn are .cmd shims and
    forge is forge.exe: subprocess can't start them by bare name."""
    if os.path.isabs(exe):
        return exe
    return shutil.which(exe) or tool(exe) or exe


def bash_exe():
    """bash for custom commands. On Windows prefer Git for Windows' bash: the
    System32 bash.exe is WSL's launcher and would run the checks in another
    system entirely."""
    if os.name == "nt":
        try:
            core = subprocess.run(["git", "--exec-path"], capture_output=True, text=True, encoding="utf-8", errors="replace").stdout.strip()
            for cand in (Path(core).parents[2] / "bin" / "bash.exe", Path(core).parents[1] / "bin" / "bash.exe"):
                if cand.is_file():
                    return str(cand)
        except (OSError, IndexError):
            pass
        found = shutil.which("bash")
        if found and "system32" not in found.lower():
            return found
        return None
    return shutil.which("bash")


def run(label, cmd, cwd, env=None):
    t = time.time()
    cmd = [resolve(cmd[0])] + list(cmd[1:])
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=TIMEOUT,
                           env={**os.environ, "CI": "1", "FORCE_COLOR": "0", "HARNESS_PYTHON": sys.executable, **(env or {})})
        ok, out = p.returncode == 0, (p.stdout + p.stderr)
    except subprocess.TimeoutExpired:
        ok, out = False, f"timed out after {TIMEOUT}s"
    except OSError as e:
        ok, out = False, str(e)
    tail = "\n".join(out.strip().splitlines()[-25:])
    results.append(("PASS" if ok else "FAIL", label, time.time() - t, "" if ok else tail))
    return ok


def warn(label, detail):
    results.append(("WARN", label, 0.0, detail))


def tool(name):
    """Find a CLI even when the hook's PATH lacks the installer's bin dir
    (non-interactive hook shells don't source .bashrc). Lesson 2026-11-09."""
    found = shutil.which(name)
    if found:
        return found
    for d in ("~/.foundry/bin", "~/.cargo/bin", "~/.cyfrin/bin", "~/.local/bin"):
        for n in (name, name + ".exe"):
            p = Path(d).expanduser() / n
            if p.is_file() and os.access(p, os.X_OK):
                return str(p)
    return None


def flat_eslint(root, d):
    """ESLint's --no-warn-ignored exists only for flat config (eslint.config.*);
    ESLint 8 with .eslintrc rejects it (lesson 2026-11-09)."""
    return any(any(x.glob("eslint.config.*")) for x in (d, root))


BASELINE_DIR = ".harness"


def aderyn_check(root, sp, d, exe):
    """Aderyn always exits 0, so read its JSON. Ratchet: high findings already
    in .harness/aderyn-baseline.json (accepted by a human) pass; any NEW high
    finding, or more instances of an accepted one in the same file, fails."""
    import tempfile
    t = time.time()
    out = Path(tempfile.mkdtemp(prefix="harness-aderyn-")) / "report.json"
    p = subprocess.run([exe, ".", "-o", str(out)], cwd=d, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=TIMEOUT)
    try:
        report = json.loads(out.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        results.append(("FAIL", f"{sp}: aderyn", time.time() - t, (p.stdout + p.stderr)[-2000:] or "no report produced"))
        return None
    current = {}
    for issue in report.get("high_issues", {}).get("issues", []):
        for inst in issue.get("instances", []):
            key = f"{issue.get('title')}|{inst.get('contract_path')}"
            current[key] = current.get(key, 0) + 1
    bpath = root / BASELINE_DIR / "aderyn-baseline.json"
    try:
        baseline = json.loads(bpath.read_text(encoding="utf-8")).get(sp, {})
    except (OSError, ValueError):
        baseline = {}
    new = {k: v - baseline.get(k, 0) for k, v in current.items() if v > baseline.get(k, 0)}
    lows = report.get("issue_count", {}).get("low", 0)
    if new:
        detail = "New HIGH static-analysis findings (not in the accepted baseline):\n" + "\n".join(
            f"  +{n}  {k.replace('|', '  in  ')}" for k, n in new.items()) + \
            f"\nFix them, or have a HUMAN review and accept: python3 scripts/harness/verify.py accept-static-baseline"
        results.append(("FAIL", f"{sp}: aderyn", time.time() - t, detail))
    else:
        accepted = sum(current.values())
        results.append(("PASS", f"{sp}: aderyn ({accepted} accepted high, {lows} low categories)", time.time() - t, ""))
    return current


def pkg_json(d):
    try:
        return json.loads((d / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def runner(root, d):
    if (root / "pnpm-lock.yaml").exists():
        return ["pnpm"]
    if (d / "yarn.lock").exists() or (root / "yarn.lock").exists():
        return ["yarn"]
    return ["npm"]


def prisma_client_ready(d):
    """True if the generated Prisma client exists next to @prisma/client.
    The stamp alone isn't enough: a re-created worktree at the same path, or a
    fresh `pnpm install`, has no generated client while the stamp says it was
    generated (lesson 2026-11-09, a repo upgrade). Unknown layout → False,
    which only costs one extra `prisma generate`."""
    # Resolve like Node: walk up from the package dir (pnpm isolated layout keeps
    # it under the app; node-linker=hoisted / npm keep it at the repo root).
    pkg = next((p / "node_modules" / "@prisma" / "client" for p in [d, *d.parents]
                if (p / "node_modules" / "@prisma" / "client").exists()), None)
    if pkg is None:
        return False
    gen = pkg.resolve().parent.parent / ".prisma" / "client"
    return (gen / "index.d.ts").exists() or (gen / "default.d.ts").exists()


def prisma_generate(root, d, ex, sp):
    """Regenerate the Prisma client when the schema changed since the last run.
    Without it a fresh checkout or worktree fails typecheck with hundreds of
    false errors (lesson 2026-11-09). Generating never connects to
    a database, so a placeholder DATABASE_URL is enough when none is set."""
    import hashlib
    import tempfile
    schemas = sorted(d.glob("prisma/**/*.prisma"))
    if not schemas:
        return
    h = hashlib.sha256(b"".join(s.read_bytes() for s in schemas) + str(d).encode()).hexdigest()
    stamp = Path(tempfile.gettempdir()) / "harness-kit" / f"prisma-{hashlib.sha1(str(d).encode()).hexdigest()[:12]}"
    if stamp.exists() and stamp.read_text(encoding="utf-8") == h and prisma_client_ready(d):
        return
    env = {} if os.environ.get("DATABASE_URL") else {"DATABASE_URL": "postgresql://harness:harness@localhost:5432/harness"}
    if run(f"{sp}: prisma generate", ex + ["prisma", "generate"], d, env):
        stamp.parent.mkdir(parents=True, exist_ok=True)
        stamp.write_text(h, encoding="utf-8")


# Build output a full lint must skip. ESLint 9 doesn't read .gitignore, so a bare
# `eslint .` walks a local dist/ (minified bundles) and can crash: SIGABRT on a
# NestJS API (lesson 2026-11-12). Fast mode lints changed tracked files only.
BUILD_OUTPUT = ("dist", "build", "coverage", ".next", ".turbo", "generated")


def eslint_full_args():
    return [a for d in BUILD_OUTPUT for a in ("--ignore-pattern", f"**/{d}/**")]


def node_checks(root, sp, files, full, whole_suite):
    d = root / sp
    pj, pm = pkg_json(d), runner(root, d)
    scripts = pj.get("scripts", {})
    deps = {**pj.get("dependencies", {}), **pj.get("devDependencies", {})}
    ex = pm + (["exec"] if pm[0] != "npm" else ["exec", "--"])
    rel = [PurePosixPath(f).relative_to(sp).as_posix() for f in files if CODE.search(f) and (root / f).exists()]
    if "prisma" in deps or "@prisma/client" in deps:
        prisma_generate(root, d, ex, sp)
    if "typecheck" in scripts:
        run(f"{sp}: typecheck", pm + ["run", "typecheck"], d)
    elif (d / "tsconfig.json").exists():
        run(f"{sp}: tsc", ex + ["tsc", "--noEmit"], d)
    if "eslint" in deps or "lint" in scripts:
        if full:
            run(f"{sp}: eslint", ex + ["eslint", "."] + eslint_full_args(), d)
        elif rel:
            flag = ["--no-warn-ignored"] if flat_eslint(root, d) else []
            run(f"{sp}: eslint ({len(rel)} files)", ex + ["eslint"] + flag + rel, d)
    if "jest" in deps or "jest" in scripts.get("test", ""):
        if full or whole_suite:
            run(f"{sp}: jest (whole suite{', zone' if whole_suite and not full else ''})", ex + ["jest", "--passWithNoTests"], d)
        elif rel:
            run(f"{sp}: jest (related)", ex + ["jest", "--passWithNoTests", "--findRelatedTests"] + rel, d)
    elif "vitest" in deps:
        run(f"{sp}: vitest", ex + ["vitest", "run"] + ([] if full or whole_suite else ["--changed", "HEAD"]), d)


def foundry_checks(root, sp, files, full, static):
    d = root / sp
    forge = tool("forge")
    if not forge:
        return warn(f"{sp}: forge", "forge not installed: Foundry checks skipped")
    if any(f.endswith(".sol") for f in files) or full:
        run(f"{sp}: forge fmt --check", [forge, "fmt", "--check"], d)
        run(f"{sp}: forge build", [forge, "build"], d)
        run(f"{sp}: forge test", [forge, "test"], d)
    if static:
        if tool("aderyn"):
            aderyn_check(root, sp, d, tool("aderyn"))
        elif tool("slither"):
            run(f"{sp}: slither", [tool("slither"), ".", "--fail-high"], d)
        else:
            warn(f"{sp}: static analysis", "zone requires static-analysis but neither aderyn nor slither is installed")


def custom_checks(root, sp, files, full, whole_suite, stack):
    """The project's own commands, for any language or tool the kit has no pack
    for (and extra checks for stacks that do). Declared per stack in harness.json:

      "commands": {"fast": [...], "zone": [...], "full": [...]},
      "extensions": [".py"]          # optional: which changed files count

    Mode picks the list: full -> full (else fast); a change inside a zone that
    requires zone-tests -> zone (else full, else fast); otherwise fast.
    `{files}` expands to the changed files (relative to the stack path, quoted);
    a command using {files} is skipped when none match. Commands run in the
    stack's directory through bash, so pipes and `&&` work."""
    import shlex
    cmds = stack.get("commands") or {}
    if not cmds:
        return
    if full:
        chosen, kind = cmds.get("full") or cmds.get("fast") or [], "full"
    elif whole_suite:
        chosen, kind = cmds.get("zone") or cmds.get("full") or cmds.get("fast") or [], "zone"
    else:
        chosen, kind = cmds.get("fast") or [], "fast"
    exts = tuple(stack.get("extensions") or ())
    d = root / sp
    rel = [PurePosixPath(f).relative_to(sp).as_posix() for f in files
           if (root / f).exists() and (not exts or f.endswith(exts))]
    for c in chosen:
        if "{files}" in c:
            if not rel:
                continue
            c = c.replace("{files}", " ".join(shlex.quote(x) for x in rel))
        bash = bash_exe()
        if not bash:
            warn(f"{sp}: custom commands", "no bash found (on Windows: install Git for Windows). These checks did NOT run.")
            return
        run(f"{sp}: {c if len(c) < 60 else c[:57] + '...'} ({kind})", [bash, "-c", c], d)


def terraform_checks(root, sp, files, full):
    d = root / sp
    if not shutil.which("terraform"):
        return warn(f"{sp}: terraform", "terraform not installed: checks skipped")
    run(f"{sp}: terraform fmt", ["terraform", "fmt", "-check", "-recursive"], d)
    if (d / ".terraform").exists():
        run(f"{sp}: terraform validate", ["terraform", "validate", "-no-color"], d)
    else:
        warn(f"{sp}: terraform validate", "not initialised (.terraform missing): validate skipped")


PII_LOG = re.compile(r"(console\.(log|info|warn|error)|logger\.\w+|this\.logger\.\w+)\(.*\b(email|phone|address|postcode|giftMessage|curp|rfc|dob|dateOfBirth|recipientName)\b", re.I)


def pii_log_check(root, files, staged):
    hits = []
    for f in files:
        if not (root / f).exists():
            continue
        diff = subprocess.run(["git", "-C", str(root), "diff", "-U0"] + (["--cached"] if staged else ["HEAD"]) + ["--", f],
                              capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
        if not diff:  # untracked: check the whole file
            try:
                diff = "\n".join("+" + l for l in (root / f).read_text(errors="ignore", encoding="utf-8").splitlines())
            except OSError:
                continue
        hits += [f"{f}: {l[1:].strip()[:120]}" for l in diff.splitlines() if l.startswith("+") and PII_LOG.search(l)]
    if hits:
        results.append(("FAIL", "pii-log-check", 0.0, "Possible personal data in a log call:\n" + "\n".join(hits[:10])))


def main(argv):
    mode = argv[0] if argv else "fast"
    staged = "--staged" in argv
    root = repo_root()
    m = load_manifest(root)
    if not m:
        print("verify: no harness.json here: nothing to check")
        return 0
    if mode == "accept-static-baseline":
        # HUMAN-ONLY: records today's high findings as accepted debt. The guard
        # blocks agents from running this; commit the file through a PR.
        base = {}
        for s in m["stacks"]:
            if s["pack"] != "foundry":
                continue
            for sp in s["paths"]:
                exe = tool("aderyn")
                if not exe:
                    print("aderyn not installed")
                    return 1
                cur = aderyn_check(root, sp.rstrip("/"), root / sp.rstrip("/"), exe)
                if cur is not None:
                    base[sp.rstrip("/")] = cur
        out = root / BASELINE_DIR / "aderyn-baseline.json"
        out.parent.mkdir(exist_ok=True)
        out.write_text(json.dumps(base, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"wrote {out.relative_to(root)}: " + ", ".join(f"{k}: {sum(v.values())} high" for k, v in base.items()))
        print("Review each finding (e.g. Patrick /audit) before committing this file.")
        return 0
    full = mode == "full"
    if staged:
        files = subprocess.run(["git", "-C", str(root), "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
                               capture_output=True, text=True, encoding="utf-8", errors="replace").stdout.split()
    else:
        files = changed_files(root)
    t0 = time.time()
    groups = {}
    for s in m["stacks"]:
        for sp in s["paths"]:
            sp = sp.rstrip("/")
            mine = [f for f in files if stack_for(f, m)[1] == sp]
            if full or mine:
                groups[(s["pack"], sp)] = (mine, s)
    pii_files = []
    for (pack, sp), (fs, stack) in groups.items():
        zones = [z for f in fs for z in zones_for(f, m)]
        reqs = {r for z in zones for r in z.get("requires", [])}
        pii_files += [f for f in fs if any(z["risk"] == "pii" and "pii-log-check" in z.get("requires", []) for z in zones_for(f, m))]
        before = len(results)
        if pack in ("nextjs", "node-ts", "nestjs-prisma"):
            node_checks(root, sp, fs, full, "zone-tests" in reqs)
        elif pack == "foundry":
            foundry_checks(root, sp, fs, full, "static-analysis" in reqs or (full and any("static-analysis" in z.get("requires", []) for z in m.get("zones", []))))
        elif pack == "terraform":
            terraform_checks(root, sp, fs, full)
        custom_checks(root, sp, fs, full, "zone-tests" in reqs, stack)
        if len(results) == before:
            # Never silent: a declared stack whose changes ran no check at all is a gap.
            warn(f"{sp}: no checks ran ({pack})",
                 "Nothing checked these changes. Declare this stack's lint/test commands in harness.json "
                 "(\"commands\": {\"fast\": [...], \"full\": [...]}), or use a pack that has built-in checks.")
    if pii_files:
        pii_log_check(root, pii_files, staged)
    elapsed = time.time() - t0
    if not results:
        print("verify: no changed files under a declared stack: nothing to check")
        return 0
    print(f"harness verify ({mode}) in {root.name}")
    for status, label, secs, _ in results:
        print(f"  {status}  {label}  ({secs:.0f}s)")
    for status, label, _, detail in results:
        if detail and status != "PASS":
            print(f"\n--- {status} {label}\n{detail}")
    budget = m.get("budgets", {}).get("verifyFastSeconds")
    if mode == "fast" and budget and elapsed > budget:
        print(f"\nWARN fast checks took {elapsed:.0f}s, over the {budget}s budget. Slow hooks get switched off: split or speed up.")
    failed = any(r[0] == "FAIL" for r in results)
    print(f"\n{'FAILED' if failed else 'PASSED'} in {elapsed:.0f}s")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
