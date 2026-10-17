"""Shared paths and helpers for run.py, grade.py and report.py (stdlib only)."""
import json
import os
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL = HERE.parents[1]  # skills/spick
TASKS_DIR = HERE / "tasks"
VENV = HERE / ".venv"

ARMS = {
    # name -> (model alias passed to --model, whether the spick hook and agents are loaded)
    "haiku-spick": ("haiku", True),
    "haiku-bare": ("haiku", False),
    "sonnet-bare": ("sonnet", False),
    "opus-bare": ("opus", False),
}


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


def find_turn_record(session_id):
    """Last line of turns.jsonl whose sessionId matches; None when the file or the line is absent."""
    path = claude_dir() / "spick" / "turns.jsonl"
    if not session_id or not path.exists():
        return None
    found = None
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if rec.get("sessionId") == session_id or rec.get("session_id") == session_id:
                found = rec
    except OSError:
        return None
    return found


def run_dirs(out):
    """Every <out>/<arm>/<task>/run-<n> directory that holds a result.json, as (arm, task, n, path)."""
    out = Path(out)
    found = []
    for p in sorted(out.glob("*/*/run-*/result.json")):
        d = p.parent
        found.append((d.parent.parent.name, d.parent.name, int(d.name.split("-")[1]), d))
    return found
