# harness-kit v0.9.0 - installed copy. Edit in harness-kit, then re-install.
"""Shared helpers for the harness scripts. Standard library only."""
import fnmatch
import json
import os
import subprocess
from pathlib import Path

KIT_VERSION = "0.6.1"


def repo_root(start=None):
    """Git top-level for `start` (a dir or file path), or None outside a repo."""
    start = Path(start or os.getcwd())
    if start.is_file() or not start.exists():
        start = start.parent
    while not start.exists() and start != start.parent:
        start = start.parent
    try:
        out = subprocess.run(["git", "-C", str(start), "rev-parse", "--show-toplevel"],
                             capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return Path(out.stdout.strip()) if out.returncode == 0 and out.stdout.strip() else None


def load_manifest(root):
    """harness.json for a repo root, or {} if absent or unreadable."""
    if not root:
        return {}
    p = Path(root) / "harness.json"
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def current_branch(cwd):
    try:
        out = subprocess.run(["git", "-C", str(cwd), "rev-parse", "--abbrev-ref", "HEAD"],
                             capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def match_any(path, patterns):
    """True if a repo-relative path matches any glob. '**' and '*' both cross '/'."""
    path = path.replace("\\", "/").removeprefix("./")
    return any(fnmatch.fnmatchcase(path, pat.replace("\\", "/").removeprefix("./")) for pat in patterns)


def zones_for(path, manifest):
    return [z for z in manifest.get("zones", []) if match_any(path, z["paths"])]


def stack_for(path, manifest):
    """The stack whose path is the longest prefix of `path`, plus that stack path."""
    path = path.replace("\\", "/")
    best, root_stack = (None, ""), None
    for s in manifest.get("stacks", []):
        for sp in s["paths"]:
            sp = sp.replace("\\", "/").rstrip("/")
            if sp in (".", ""):
                root_stack = (s, ".")  # a stack covering the whole repo, used if nothing deeper matches
            elif (path == sp or path.startswith(sp + "/")) and len(sp) > len(best[1]):
                best = (s, sp)
    return best if best[0] or not root_stack else root_stack


def changed_files(root):
    """Repo-relative paths changed vs HEAD: staged, unstaged and untracked."""
    try:
        out = subprocess.run(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=all"],
                             capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return []
    files = []
    for line in out.stdout.splitlines():
        p = line[3:]
        if " -> " in p:
            p = p.split(" -> ", 1)[1]
        files.append(p.strip().strip('"'))
    return files
