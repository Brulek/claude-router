"""Shared paths and helpers for run.py, grade.py and report.py (stdlib only)."""
import json
import os
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL = HERE.parents[1]  # skills/spick
TASKS_DIR = HERE / "tasks"
VENV = HERE / ".venv"

# The globally installed copy of the mod (key in ~/.claude/plugins/installed_plugins.json). Every arm disables it so
# no arm gets the mod by accident; haiku-spick loads the checkout's copy with --plugin-dir instead.
GLOBAL_MOD_KEY = "spick-dashboard@spick"
MOD_DIR = SKILL.parents[1] / "mod" / "spick-dashboard"

# model: --model alias; hook: UserPromptSubmit hook of this checkout; mod: checkout mod via --plugin-dir;
# agents: skills/spick/assets/agents rendered into --agents; agent_tool: Agent allowed (else --disallowedTools Agent);
# hooks_off: disableAllHooks, which keeps the user's global v1 hook out of the run (haiku-spick gets its checklist
# from the mod, which injects it itself; haiku-hook is the only arm that leaves hooks on, see README)
ARMS = {
    "haiku-spick": dict(model="haiku", hook=False, mod=True, agents=True, agent_tool=True, hooks_off=True),
    "haiku-hook": dict(model="haiku", hook=True, mod=False, agents=True, agent_tool=True, hooks_off=False),
    "haiku-bare": dict(model="haiku", hook=False, mod=False, agents=False, agent_tool=False, hooks_off=True),
    "sonnet-bare": dict(model="sonnet", hook=False, mod=False, agents=False, agent_tool=False, hooks_off=True),
    "opus-bare": dict(model="opus", hook=False, mod=False, agents=False, agent_tool=False, hooks_off=True),
    "sonnet-free": dict(model="sonnet", hook=False, mod=False, agents=False, agent_tool=True, hooks_off=True),
    "opus-free": dict(model="opus", hook=False, mod=False, agents=False, agent_tool=True, hooks_off=True),
}
SPICK_ARMS = [a for a, c in ARMS.items() if c["hook"] or c["mod"]]
DEFAULT_ARMS = ["haiku-spick", "haiku-bare", "sonnet-bare", "opus-bare"]  # the headline four; the rest are extras


def load_tasks():
    tasks = json.loads((TASKS_DIR / "tasks.json").read_text(encoding="utf-8"))
    return {t["id"]: t for t in tasks}


def venv_python():
    return VENV / "bin" / "python"


def claude_dir():
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")


# The label line and the Kept: line name the arm, so they are cut before anything is judged or measured by length.
LABEL_RE = re.compile(r"^\s*\[Model:[^\]]*\]\s*$", re.M)
KEPT_RE = re.compile(r"^\s*Kept:.*$", re.M)


def has_label(text):
    return bool(re.search(r"\[Model:", text or ""))


def has_kept(text):
    return bool(KEPT_RE.search(text or ""))


def strip_markers(text):
    text = LABEL_RE.sub("", text or "")
    text = KEPT_RE.sub("", text)
    return text.strip()


def turn_record_path(session_id):
    return claude_dir() / "spick" / "turns" / f"{session_id}.jsonl"


def find_turn_records(session_id):
    """Lines of <state>/turns/<sessionId>.jsonl (one file per session; a late agent appends a `late` line);
    None when the file is absent, which is normal for a headless run."""
    path = turn_record_path(session_id)
    if not session_id or not path.is_file():
        return None
    recs = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                recs.append(json.loads(line))
            except ValueError:
                continue
    except OSError:
        return None
    return recs or None


def run_dirs(out):
    """Every <out>/<arm>/<task>/run-<n> directory that holds a result.json, as (arm, task, n, path)."""
    out = Path(out)
    found = []
    for p in sorted(out.glob("*/*/run-*/result.json")):
        d = p.parent
        found.append((d.parent.parent.name, d.parent.name, int(d.name.split("-")[1]), d))
    return found
