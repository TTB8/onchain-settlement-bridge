#!/usr/bin/env python3
# harness-kit v0.9.0 - installed copy. Edit in harness-kit, then re-install.
"""PreToolUse guard: a computational guide that blocks actions before they run.

Reads the hook payload (JSON) on stdin. Exit 0 = allow. Exit 2 = block, with the
reason on stderr (Claude Code shows it to the model; Codex hooks use the same
convention). It never blocks on its own errors: a broken guard must not brick
the agent, so unexpected failures exit 0 with a warning.

Universal rules (every repo, even without harness.json):
  - no reading or touching credential files (creds.txt and the like, SSH keys, keystores)
  - no writing live secrets (Stripe live keys, PEM private keys, raw private keys)
  - no force-push, no --mirror, no hook bypass (--no-verify, core.hooksPath)
Repo rules (from harness.json):
  - no push to a protected branch, no `gh pr merge` where a push deploys
  - no broadcast/apply when a zone requires a human deploy
  - guard.blockedCommands: extra regexes with a reason

This guards against mistakes, not a determined adversary: obfuscated commands
can get past it. The git pre-push hook and branch protection are the deeper layers.
"""
import json
import os
import re
import shlex
import sys
from pathlib import Path

sys.dont_write_bytecode = True  # never leave __pycache__ in the repo
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import current_branch, load_manifest, repo_root  # noqa: E402

# Credential files: a file name with the word cred/creds/credential(s) and a document
# extension (creds.txt, "Bank Credentials.csv", team_cred.csv), git's and AWS's credential
# stores, SSH private keys, Foundry keystores. Letters may not touch the word, so
# credit.txt and incredible.txt stay allowed.
SECRET_NAME = re.compile(
    r"(^|[/\\\s'\"])[^/\\\s'\"]*?(?<![a-z])cred(s|entials?)?(?![a-z])[^/\\\s'\"]*\.(txt|csv|json|xlsx?|ini)\b"
    r"|\.git-credentials\b|\.aws/credentials\b"
    r"|(^|[/\\])id_(rsa|ed25519|ecdsa)(?!\.pub)\b|\.foundry/keystores", re.I)
SECRET_VALUE = re.compile(
    r"\b(sk|rk)_live_[A-Za-z0-9]{10,}"
    r"|-----BEGIN [A-Z ]*PRIVATE KEY-----"
    r"|PRIVATE_KEY\s*[=:]\s*['\"]?0x[0-9a-fA-F]{64}\b"
)
BASELINE_FILE = ".harness/aderyn-baseline.json"
OPS = {"&&", "||", ";", "|", "&", "(", ")", "\n"}
SHELLS = {"bash", "sh", "zsh", "dash"}


class Block(Exception):
    pass


def segments(cmd):
    """Split a shell command into simple-command token lists, respecting quotes."""
    lex = shlex.shlex(cmd.replace("\n", " ; "), posix=True, punctuation_chars=";&|()")
    lex.whitespace_split = True
    seg = []
    try:
        for tok in lex:
            if tok in OPS or set(tok) <= set(";&|()"):
                if seg:
                    yield seg
                seg = []
            else:
                seg.append(tok)
    except ValueError:  # unbalanced quotes: fall back to a plain split
        seg = cmd.split()
    if seg:
        yield seg


def strip_env(tokens):
    i = 0
    while i < len(tokens) and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[i]):
        i += 1
    while i < len(tokens) and tokens[i] in ("sudo", "command", "env", "nohup", "time", "exec"):
        i += 1
    return tokens[i:]


def push_targets(args, cwd):
    """Branches a `git push <args>` would update. '*' means all branches."""
    opts_with_value = {"--repo", "-o", "--push-option", "--receive-pack", "--exec"}
    pos, flags, skip = [], set(), False
    for a in args:
        if skip:
            skip = False
            continue
        if a in opts_with_value:
            skip = True
        elif a.startswith("-"):
            flags.add(a.split("=")[0])
        else:
            pos.append(a)
    if flags & {"--all", "--mirror", "--branches"}:
        return {"*"}, flags
    refspecs = pos[1:]
    if not refspecs:
        if "--tags" in flags:
            return set(), flags
        return {current_branch(cwd) or "?"}, flags
    out = set()
    for r in refspecs:
        dst = r.lstrip("+").split(":", 1)[-1]
        dst = dst.removeprefix("refs/heads/")
        if dst in ("HEAD", ""):
            dst = current_branch(cwd) or "?"
        out.add(dst)
    return out, flags


def check_git(tokens, cwd, manifest):
    args = tokens[1:]
    while args and args[0] in ("-C", "-c"):
        if args[0] == "-C" and len(args) > 1:
            cwd = (Path(cwd) / args[1]).resolve()
            manifest = load_manifest(repo_root(cwd))
        if args[0] == "-c" and len(args) > 1 and args[1].lower().startswith("core.hookspath"):
            raise Block("Overriding core.hooksPath disables the repo's git hooks. Leave hooks on.")
        args = args[2:]
    if not args:
        return
    sub, rest = args[0], args[1:]
    if sub == "config" and any(a.lower() == "core.hookspath" for a in rest):
        # Reading it is fine (`--get`, or the key alone); changing it is not.
        i = [a.lower() for a in rest].index("core.hookspath")
        writes = {"--unset", "--unset-all", "--replace-all", "--add", "--remove-section"}
        if writes & set(rest) or (i + 1 < len(rest) and not rest[i + 1].startswith("-")):
            raise Block("Changing core.hooksPath disables the repo's git hooks. The harness installer manages it.")
    if sub in ("commit", "push", "merge", "rebase") and ("--no-verify" in rest or (sub == "commit" and "-n" in rest)):
        raise Block(f"`git {sub} --no-verify` skips the harness checks. Fix what the hook reports instead.")
    if sub != "push":
        return
    def is_force(a):
        if a.startswith("--"):
            return a == "--force" or a.startswith(("--force-with-lease", "--force-if-includes"))
        return a.startswith("-") and "f" in a[1:]  # -f, -uf, -fu
    if any(is_force(a) for a in rest) or any(a.startswith("+") for a in rest):
        raise Block("Force-push is blocked for agents. If history really must be rewritten, ask the human to do it.")
    if "--mirror" in rest:
        raise Block("`git push --mirror` overwrites every remote ref. Blocked.")
    protected = set(manifest.get("protected", {}).get("branches", []))
    if not protected:
        return
    targets, _ = push_targets(rest, cwd)
    hit = protected & targets if "*" not in targets else protected
    if "?" in targets:
        hit = hit or protected  # unknown current branch: fail closed
    if hit:
        deploy = manifest.get("protected", {}).get("deployOnPush")
        raise Block(
            f"Push to protected branch {', '.join(sorted(hit))} is blocked"
            + (" (a push there is a production deploy)" if deploy else "")
            + ". Push a feature branch and open a PR; a human merges it."
        )


def check_command(cmd, cwd, manifest, depth=0):
    if depth > 3:
        return
    if SECRET_VALUE.search(cmd):
        raise Block("The command contains what looks like a live secret or private key. Never put secrets in commands, files or logs.")
    if SECRET_NAME.search(cmd):
        raise Block("The command touches a credentials file (a creds/credentials document, SSH key or keystore). Agents must not read or copy these.")
    # Repo rules are evaluated per segment against the manifest of the repo that
    # segment runs in, so `cd repo && <cmd>` from the hub gets that repo's rules.
    for seg in segments(cmd):
        t = strip_env(seg)
        if not t:
            continue
        exe = os.path.basename(t[0])
        if exe == "cd" and len(t) > 1:
            cwd = (Path(cwd) / os.path.expanduser(t[1])).resolve()
            manifest = load_manifest(repo_root(cwd)) or manifest
            continue
        if exe == "git" and len(t) > 2 and t[1] == "-C":
            seg_manifest = load_manifest(repo_root((Path(cwd) / t[2]).resolve())) or manifest
        else:
            seg_manifest = manifest
        seg_text = " ".join(seg)
        # Accepting static-analysis findings is human-only. Match an actual
        # invocation, not a mention in text (lesson 2026-11-09: a note that merely
        # named the command was blocked).
        if "accept-static-baseline" in t and any(x.endswith("verify.py") for x in t):
            raise Block("Accepting static-analysis findings is a human decision. Fix the finding, or ask the human to review it and run `verify.py accept-static-baseline`.")
        if exe in ("tee", "cp", "mv", "rm", "truncate") and any(x.endswith(BASELINE_FILE) for x in t[1:]):
            raise Block("The static-analysis baseline records findings a human accepted. Agents can't change it.")
        if any(a in (">", ">>") and b.endswith(BASELINE_FILE) for a, b in zip(t, t[1:])) or any(x.startswith((">", ">>")) and x.endswith(BASELINE_FILE) for x in t):
            raise Block("The static-analysis baseline records findings a human accepted. Agents can't change it.")
        if exe == "sed" and "-i" in t and any(x.endswith(BASELINE_FILE) for x in t):
            raise Block("The static-analysis baseline records findings a human accepted. Agents can't change it.")
        for pat in seg_manifest.get("guard", {}).get("blockedCommands", []):
            if re.search(pat["pattern"], seg_text):
                raise Block(pat["reason"])
        human_deploy = any("human-deploy" in z.get("requires", []) for z in seg_manifest.get("zones", []))
        if exe in SHELLS and "-c" in t[1:]:
            i = t.index("-c")
            if i + 1 < len(t):
                check_command(t[i + 1], cwd, manifest, depth + 1)
            continue
        if exe == "eval" and len(t) > 1:
            check_command(" ".join(t[1:]), cwd, manifest, depth + 1)
            continue
        if exe == "git":
            check_git(t, cwd, manifest)
        if exe == "gh" and t[1:3] == ["pr", "merge"] and manifest.get("protected", {}).get("deployOnPush"):
            raise Block("Merging a PR here deploys to production. Only the human merges.")
        if human_deploy and exe == "forge" and "script" in t and "--broadcast" in t:
            rpc = next((t[i + 1] for i, a in enumerate(t[:-1]) if a in ("--rpc-url", "-f", "--fork-url")), "")
            if not re.search(r"localhost|127\.0\.0\.1|anvil", rpc):
                raise Block("Broadcasting a deploy from an onchain zone needs a human. Dry-run without --broadcast, or use --rpc-url http://127.0.0.1:8545 (anvil).")
        if human_deploy and exe == "terraform" and len(t) > 1 and t[1] in ("apply", "destroy"):
            raise Block("`terraform apply/destroy` is human-only in this repo. Run `terraform plan` and hand over the plan.")


def check_file(tool, inp):
    path = inp.get("file_path") or inp.get("path") or inp.get("notebook_path") or ""
    if path and SECRET_NAME.search(path):
        raise Block(f"{path} is a credentials file. Agents must not read or modify it.")
    if path.replace("\\", "/").endswith(BASELINE_FILE) and tool in ("Write", "Edit", "MultiEdit"):
        raise Block("The static-analysis baseline records findings a human accepted. Agents can't edit it; fix the finding instead.")
    text = "\n".join(str(x) for x in [inp.get("content"), inp.get("new_string")] + [e.get("new_string") for e in inp.get("edits", []) if isinstance(e, dict)] if x)
    if tool in ("Write", "Edit", "MultiEdit", "NotebookEdit") and SECRET_VALUE.search(text):
        raise Block("This edit writes what looks like a live secret or private key into a file. Use an env var that a human sets.")


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except ValueError:
        return 0
    tool = payload.get("tool_name") or payload.get("tool") or ""
    inp = payload.get("tool_input") or payload.get("input") or {}
    cwd = payload.get("cwd") or os.getcwd()
    cmd = inp.get("command")
    if isinstance(cmd, list):
        cmd = " ".join(shlex.quote(c) for c in cmd)
    try:
        if cmd:
            check_command(cmd, cwd, load_manifest(repo_root(cwd)))
        else:
            check_file(tool, inp)
    except Block as b:
        print(f"[harness guard] {b}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # never brick the agent on a guard bug
        print(f"[harness guard] internal error, allowing: {e}", file=sys.stderr)
        sys.exit(0)
