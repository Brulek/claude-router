#!/usr/bin/env python3
"""Run the A/B matrix: each (arm, task, run) gets a fresh copy of the task template and one `claude -p` call.

    python3 run.py --setup
    python3 run.py --arms haiku-spick,haiku-bare,sonnet-bare,opus-bare --runs 3 --parallel 2 --out results/

Results land in <out>/<arm>/<task>/run-<n>/{work/, result.json}; grade.py and report.py read them from there.
"""
import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import common

# The old mode-compare runner's list; the spick arm adds Agent so it can delegate.
ALLOW = ["Read", "Edit", "Write", "Glob", "Grep", "Bash(python3:*)", "Bash(pytest:*)", "Bash(ls:*)",
         "Bash(cat:*)", "Bash(wc:*)", "Bash(head:*)", "Bash(echo:*)", "Bash(date:*)", "Bash(sort:*)",
         "Bash(shasum:*)"]
SESSION_VARS = {"CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
                "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN"}
BARE_SETTINGS = {"disableAllHooks": True}


def setup_venv():
    """A private venv with pytest: the machine has no system pytest, and agent and grader must use the same one."""
    if not common.venv_python().exists():
        subprocess.run([sys.executable, "-m", "venv", str(common.VENV)], check=True)
    subprocess.run([str(common.venv_python()), "-m", "pip", "install", "--quiet", "pytest"], check=True)
    r = subprocess.run([str(common.venv_python()), "-m", "pytest", "--version"], capture_output=True, text=True)
    print("venv ready:", common.VENV, "|", (r.stdout or r.stderr).strip())


def parse_agent(path):
    """Frontmatter (name/description/model/effort/tools) plus body as prompt; one `key: value` per line."""
    text = path.read_text(encoding="utf-8")
    _, front, body = text.split("---\n", 2)
    meta = {}
    for line in front.splitlines():
        if ": " in line:
            k, v = line.split(": ", 1)
            meta[k.strip()] = v.strip()
    agent = {"description": meta["description"], "prompt": body.strip()}
    if "model" in meta:
        agent["model"] = meta["model"]
    if "effort" in meta:
        agent["effort"] = meta["effort"]
    if "tools" in meta:
        agent["tools"] = [t.strip() for t in meta["tools"].split(",") if t.strip()]
    return meta.get("name", path.stem), agent


def render_agents():
    agents = dict(parse_agent(p) for p in sorted((common.SKILL / "assets" / "agents").glob("*.md")))
    return json.dumps(agents, ensure_ascii=False)


def spick_settings():
    hook = common.SKILL / "scripts" / "triage-hook.sh"
    return json.dumps({"hooks": {"UserPromptSubmit": [{"hooks": [
        {"type": "command", "command": f"bash '{hook}'"}]}]}})


def build_cmd(arm, prompt, agents_file, settings_file, binary="claude"):
    model, spick = common.ARMS[arm]
    cmd = [binary, "-p", prompt, "--output-format", "json", "--permission-mode", "acceptEdits", "--model", model]
    if spick:
        cmd += ["--settings", str(settings_file), "--agents", str(agents_file)]
        allow = ALLOW + ["Agent"]
    else:
        cmd += ["--settings", json.dumps(BARE_SETTINGS), "--disallowedTools", "Agent"]
        allow = ALLOW
    return cmd + ["--allowedTools"] + allow  # variadic flag goes last


def run_claude(cmd, cwd, env, timeout):
    """Returns (stdout, stderr, exit_code, timed_out); the whole process group dies on timeout."""
    p = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        out, err = p.communicate(timeout=timeout)
        return out, err, p.returncode, False
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL)
        out, err = p.communicate()
        return out or "", err or "", None, True


def do_run(job, args, env, agents_file, settings_file, lock):
    arm, tid, n = job
    task = common.load_tasks()[tid]
    rdir = Path(args.out) / arm / tid / f"run-{n}"
    if (rdir / "result.json").exists() and not args.force:
        return f"skip {arm} {tid} run-{n} (result.json exists)"
    if rdir.exists():
        shutil.rmtree(rdir)
    work = rdir / "work"
    if task["template"]:
        shutil.copytree(common.TASKS_DIR / task["template"], work)
    else:
        work.mkdir(parents=True)
    cmd = build_cmd(arm, task["prompt"], agents_file, settings_file, args.claude_bin)
    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    t0 = time.time()
    out, err, code, timed_out = run_claude(cmd, work, env, args.timeout)
    wall = round(time.time() - t0, 1)
    try:
        result = json.loads(out)
    except ValueError:
        result = None
        (rdir / "stdout.txt").write_text(out, encoding="utf-8")
    session = (result or {}).get("session_id")
    rec = {
        "meta": {"arm": arm, "task": tid, "run": n, "started": started, "wall_seconds": wall,
                 "exit_code": code, "timed_out": timed_out, "stderr_tail": err[-600:],
                 "cmd": cmd[:2] + ["<prompt>"] + cmd[3:]},
        "result": result,
        # the mod writes this line at turn end; headless runs may have none
        "turn_record": common.find_turn_record(session) if common.ARMS[arm][1] else None,
    }
    (rdir / "result.json").write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
    cost = (result or {}).get("total_cost_usd")
    models = list(((result or {}).get("modelUsage") or {}).keys())
    with lock:
        print(f"{arm:12} {tid} run-{n} wall {wall:6.1f}s cost {cost} models {models}"
              + (" TIMEOUT" if timed_out else "") + ("" if result else " UNPARSED"), flush=True)
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--setup", action="store_true", help="create the pytest venv and exit")
    ap.add_argument("--arms", default=",".join(common.ARMS))
    ap.add_argument("--tasks", default=",".join(common.load_tasks()))
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--parallel", type=int, default=2)
    ap.add_argument("--out", default="results")
    ap.add_argument("--timeout", type=int, default=900, help="seconds per run (default 15 minutes)")
    ap.add_argument("--force", action="store_true", help="redo runs that already have a result.json")
    ap.add_argument("--claude-bin", default="claude", help="the claude executable (a stub for pipeline tests)")
    ap.add_argument("--dry-run", action="store_true", help="print the commands and exit")
    args = ap.parse_args()

    if args.setup:
        setup_venv()
        return 0
    arms = args.arms.split(",")
    tids = args.tasks.split(",")
    tasks = common.load_tasks()
    for a in arms:
        if a not in common.ARMS:
            sys.exit(f"unknown arm {a}; known: {', '.join(common.ARMS)}")
    for t in tids:
        if t not in tasks:
            sys.exit(f"unknown task {t}; known: {', '.join(tasks)}")
    if not common.venv_python().exists():
        sys.exit("no venv yet: run `python3 run.py --setup` first")

    out = Path(args.out).resolve()
    args.out = str(out)
    arms_dir = out / "_arms"
    arms_dir.mkdir(parents=True, exist_ok=True)
    settings_file = arms_dir / "spick-settings.json"
    agents_file = arms_dir / "spick-agents.json"
    settings_file.write_text(spick_settings(), encoding="utf-8")
    agents_file.write_text(render_agents(), encoding="utf-8")

    # a runner started from inside Claude Code must not make its runs look like children of that session
    env = {k: v for k, v in os.environ.items() if k not in SESSION_VARS}
    env["PATH"] = f"{common.VENV / 'bin'}{os.pathsep}{env.get('PATH', '')}"  # same pytest for agent and grader

    # runs outermost so a partial matrix still has every cell once
    jobs = [(a, t, n) for n in range(1, args.runs + 1) for t in tids for a in arms]
    if args.dry_run:
        for arm, tid, n in jobs:
            print(arm, tid, n, build_cmd(arm, tasks[tid]["prompt"], agents_file, settings_file))
        return 0
    lock = threading.Lock()
    print(f"{len(jobs)} runs, parallel {args.parallel}, out {out}", flush=True)
    with ThreadPoolExecutor(max_workers=args.parallel) as ex:
        for msg in ex.map(lambda j: do_run(j, args, env, agents_file, settings_file, lock), jobs):
            if msg:
                print(msg, flush=True)
    print("ALL DONE", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
