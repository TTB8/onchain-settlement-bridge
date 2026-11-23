#!/usr/bin/env python3
# harness-kit v0.9.0 - installed copy. Edit in harness-kit, then re-install.
"""Stop hook: the agent can't call the work done while the fast checks fail.

Runs when the agent finishes a turn. If source under a declared stack changed:
  1. run verify.py fast. On failure, block once with the output so the agent fixes it.
     If it is still failing on the retry, allow the stop but say so loudly: a hook
     that never lets go traps the session.
  2. if no context doc listed in harness.json "docs" changed, nudge once per session
     to sync them (replaces the older check-context-docs.sh).
A passing tree is fingerprinted, so an unchanged tree isn't re-checked every turn.

The same script gates /team workers, so a worker can't report "done" while the
checks fail:
  - PreToolUse on SubagentHandback (the tool a sub-agent reports through): deny the
    first hand-back while the checks fail, so the worker fixes them and resends; the
    second is allowed with a loud warning (never trap a worker).
  - SubagentStop: the same check for a sub-agent that stops without a hand-back.
    Claude Code's internal agents (empty agent_type) are skipped.
A sub-agent is checked only if its transcript shows it edited files (a read-only
reviewer or searcher is never blocked for the lead's half-finished tree; an
unreadable transcript is checked, never skipped). Failures outside its brief are
reported, not fixed, and the docs nudge is left to the lead.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True  # never leave __pycache__ in the repo
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import changed_files, load_manifest, repo_root, stack_for  # noqa: E402

HERE = Path(__file__).resolve().parent


def fingerprint(root, files):
    h = hashlib.sha256(subprocess.run(["git", "-C", str(root), "diff", "HEAD"], capture_output=True).stdout)
    for f in sorted(files):
        p = root / f
        if p.is_file():
            st = p.stat()
            h.update(f"{f}:{st.st_size}:{st.st_mtime_ns}".encode())
    return h.hexdigest()


EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
# Bash commands that write files. Deliberately broad: a false "edited" only costs one check run.
SHELL_WRITE = re.compile(r"(^|[^0-9&>])>{1,2}\s*(?!/dev/null|&)\S|\b(sed|perl)\s+(-\w*\s+)*-i|\btee\b|"
                         r"\bgit\s+(apply|am|checkout|restore|reset|merge|rebase|cherry-pick|stash|mv|rm)\b|"
                         r"\b(mv|cp|rm|patch|truncate|install)\s|\b(write_text|write_bytes|writeFile\w*|appendFile\w*)|"
                         # script writes (workers often edit through a python/node heredoc)
                         r"\.write\(|\bopen\([^)]*,\s*['\"][wax+]|\bjson\.dump\(|\bshutil\.(copy|move|rmtree)|\bos\.(remove|rename|replace|unlink)\(")


def subagent_tools(path):
    """(edited, tools used) from a sub-agent's transcript. Unreadable counts as edited (then we check)."""
    try:
        lines = Path(path).expanduser().read_text(encoding="utf-8", errors="replace").splitlines()
    except (OSError, TypeError, ValueError):
        return True, set()
    edited, names = False, set()
    for line in lines:
        try:
            content = (json.loads(line).get("message") or {}).get("content")
        except (ValueError, AttributeError):
            continue
        for c in content if isinstance(content, list) else []:
            if not isinstance(c, dict) or c.get("type") != "tool_use":
                continue
            names.add(c.get("name"))
            if c.get("name") in EDIT_TOOLS or (c.get("name") == "Bash" and
                                               SHELL_WRITE.search(str((c.get("input") or {}).get("command", "")))):
                edited = True
    return edited, names


def agent_transcript(payload):
    """SubagentStop names the sub-agent's transcript; PreToolUse inside a sub-agent only names the
    session's, so derive it: <session>.jsonl -> <session>/subagents/agent-<id>.jsonl."""
    if payload.get("agent_transcript_path"):
        return payload["agent_transcript_path"]
    t, aid = payload.get("transcript_path"), str(payload.get("agent_id") or "")
    if not t or not aid:
        return None
    return str(Path(t).expanduser().with_suffix("") / "subagents" / f"agent-{aid.removeprefix('agent-')}.jsonl")


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except ValueError:
        payload = {}
    if os.environ.get("HARNESS_SKIP") == "1":
        return 0
    event = payload.get("hook_event_name")
    handback = event == "PreToolUse" and payload.get("tool_name") == "SubagentHandback"
    if event == "PreToolUse" and not handback:
        return 0
    sub = handback or event == "SubagentStop"
    if event == "SubagentStop" and payload.get("agent_type") == "":
        return 0  # Claude Code's own internal agents (prompt suggestions, /btw)
    if sub:
        edited, tools = subagent_tools(agent_transcript(payload))
        if not edited or (event == "SubagentStop" and "SubagentHandback" in tools):
            return 0  # read-only, or already gated at the hand-back
    root = repo_root(payload.get("cwd") or os.getcwd())
    m = load_manifest(root)
    if not m:
        return 0
    files = changed_files(root)
    source = [f for f in files if stack_for(f, m)[0] and not f.endswith(".md")]
    if not source:
        return 0
    session = "".join(c for c in str(payload.get("session_id", "nosession")) if c.isalnum() or c in "-_")
    state = Path(tempfile.gettempdir()) / "harness-kit" / hashlib.sha1(str(root).encode()).hexdigest()[:12]
    state.mkdir(parents=True, exist_ok=True)
    fp = fingerprint(root, files)
    passed = state / "last-pass"
    if not (passed.exists() and passed.read_text(encoding="utf-8") == fp):
        p = subprocess.run([sys.executable, "-I", str(HERE / "verify.py"), "fast"], cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace")
        out = (p.stdout + p.stderr).strip()
        if p.returncode != 0:
            if handback:
                aid = "".join(c for c in str(payload.get("agent_id", "")) if c.isalnum() or c in "-_")
                once = state / f"handback-{aid}"
                if once.exists():
                    print(json.dumps({"systemMessage": f"harness: worker {payload.get('agent_type') or aid} handed back with the fast checks STILL failing. Not done: re-run scripts/harness/verify.py fast."}))
                    return 0
                once.touch()
                print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                    "permissionDecisionReason": "harness: the fast checks fail, so this report can't say done yet. Fix the failures "
                    "your change caused, then hand back again. Failures outside your brief: don't fix them, list them under "
                    "Open questions and hand back.\n\n" + out[-6000:]}}))
                return 0
            if payload.get("stop_hook_active"):
                print(json.dumps({"systemMessage": "harness: fast checks are STILL failing after a retry. Not done: see scripts/harness/verify.py fast."}))
                return 0
            ask = ("Fix the failures your change caused. Failures outside your brief: don't fix them, "
                   "report them under Open questions. Then finish." if sub else "Fix the failures below, then finish.")
            print(json.dumps({"decision": "block", "reason": f"harness: the fast checks failed, so this isn't done yet. {ask}\n\n" + out[-6000:]}))
            return 0
        passed.write_text(fp, encoding="utf-8")
    if sub:
        return 0  # context docs are the lead's job
    docs = m.get("docs", [])
    nudged = state / f"docs-{session}"
    if docs and not any(f in docs for f in files) and not nudged.exists():
        nudged.touch()
        print(json.dumps({"decision": "block", "reason": f"harness: {len(source)} source file(s) changed but none of {', '.join(docs)} did. Update the context docs (sync-context skill), or say explicitly why no doc change is needed, then finish. This nudge fires once per session."}))
        return 0
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # never trap the session on a hook bug
        print(json.dumps({"systemMessage": f"harness stop hook error (allowed): {e}"}))
        sys.exit(0)
