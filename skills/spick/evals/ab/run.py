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


def arm_settings(cfg):
    """Settings JSON per arm: hooks off or the checkout's hook; the global mod is disabled in every arm."""
    s = {"enabledPlugins": {common.GLOBAL_MOD_KEY: False}}
    if cfg["hooks_off"]:
        s["disableAllHooks"] = True
    if cfg["hook"]:
        hook = common.SKILL / "scripts" / "triage-hook.sh"
        s["hooks"] = {"UserPromptSubmit": [{"hooks": [{"type": "command", "command": f"bash '{hook}'"}]}]}
    return s


def build_cmd(arm, prompt, agents_file, settings_file, binary="claude"):
    cfg = common.ARMS[arm]
    cmd = [binary, "-p", prompt, "--output-format", "json", "--permission-mode", "acceptEdits",
           "--model", cfg["model"], "--settings", str(settings_file)]
    if cfg["agents"]:
        cmd += ["--agents", str(agents_file)]
    if cfg["mod"]:
        cmd += ["--plugin-dir", str(common.MOD_DIR)]
    if not cfg["agent_tool"]:
        cmd += ["--disallowedTools", "Agent"]
    allow = ALLOW + (["Agent"] if cfg["agent_tool"] else [])
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


PROBE_PROMPT = "Reply with exactly OK."
PROBE_SETTLE = 3.0  # seconds the mod gets to write its turn record after claude exits


def checkout_head():
    r = subprocess.run(["git", "-C", str(common.MOD_DIR), "rev-parse", "HEAD"], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def claude_version(binary):
    try:
        r = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout.strip() or None


def probe_arm(arm, args, env, agents_file, settings_dir, settle=None):
    """One cheap call per arm, then check from the turn-record directory that the arm started as configured.
    haiku-spick: the checkout's mod ran (a schemaVersion 2 record appeared; the global copy is disabled, so it cannot
    have written one). *-bare and *-free arms: no record file for the session (the global mod stayed disabled).
    haiku-hook: accepted, a bash hook leaves nothing the harness can read."""
    cfg = common.ARMS[arm]
    settle = PROBE_SETTLE if settle is None else settle
    work = Path(args.out) / "_probe" / arm / "work"
    work.mkdir(parents=True, exist_ok=True)
    cmd = build_cmd(arm, PROBE_PROMPT, agents_file, settings_dir / f"{arm}.json", args.claude_bin)
    out, err, code, timed_out = run_claude(cmd, work, env, args.probe_timeout)
    p = {"arm": arm, "ok": False, "check": None, "detail": "", "session_id": None, "exit_code": code,
         "timed_out": timed_out, "record_seen": None, "schema_version": None}
    try:
        res = json.loads(out)
    except ValueError:
        res = None
    if timed_out or code != 0 or not isinstance(res, dict) or res.get("is_error") or not res.get("session_id"):
        p["detail"] = (f"the probe call failed (exit {code}{', timeout' if timed_out else ''}"
                       f"{'' if isinstance(res, dict) else ', no JSON result'}): {err.strip()[-200:]}")
        return p
    sid = p["session_id"] = res["session_id"]
    path = common.turn_record_path(sid)
    deadline = time.time() + settle
    while True:  # the mod writes at turn end, possibly just after claude exits
        recs = common.find_turn_records(sid) or []
        versions = {r.get("schemaVersion") for r in recs}
        done = 2 in versions if cfg["mod"] else cfg["hook"] or path.exists()
        if done or time.time() >= deadline:
            break
        time.sleep(0.2)
    p["record_seen"] = path.exists()
    p["schema_version"] = 2 if 2 in versions else (sorted(versions, key=str)[0] if versions else None)
    if cfg["mod"]:
        p["check"] = "record"
        p["ok"] = 2 in versions
        p["detail"] = ("the checkout's mod wrote a schemaVersion 2 turn record" if p["ok"] else
                       f"no schemaVersion 2 turn record for session {sid}: the checkout's mod did not run "
                       "(--plugin-dir not honoured, or the mod does not write records in headless runs)")
    elif cfg["hook"]:
        p["check"], p["ok"] = "best-effort", True
        p["detail"] = "accepted unverified: a bash hook leaves no trace the harness can read"
    else:
        p["check"] = "no-record"
        p["ok"] = not p["record_seen"]
        p["detail"] = ("no turn record for the session: the global mod stayed disabled" if p["ok"] else
                       f"{path} exists: the global mod ran although it should be disabled")
    return p


def probe_all(arms, args, env, agents_file, settings_dir, settle=None):
    """Probe each distinct arm once, write <out>/_probe.json (this invocation's probe: a later one overwrites it),
    return its content: when, claude --version, the checkout HEAD, and {arm: result} under "arms"."""
    results = {a: probe_arm(a, args, env, agents_file, settings_dir, settle) for a in dict.fromkeys(arms)}
    info = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "claude_version": claude_version(args.claude_bin),
            "checkout_head": checkout_head(), "allow_unverified": bool(args.allow_unverified), "arms": results}
    (Path(args.out) / "_probe.json").write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    return info


def probe_stamp(info, arm):
    """What a run's result.json keeps of the probe its invocation made for its arm (meta.probe). _probe.json holds
    the latest invocation only, and a resumed matrix skips runs that have a result.json, so each run must carry the
    probe it was made under, or the latest probe would vouch for runs made before it."""
    p = (info.get("arms") or {}).get(arm) or {}
    return {"ok": bool(p.get("ok")), "check": p.get("check"), "detail": p.get("detail"), "at": info.get("at"),
            "claude_version": info.get("claude_version"), "checkout_head": info.get("checkout_head")}


def do_run(job, args, env, agents_file, settings_dir, lock, probe=None):
    """One run; `probe` is this invocation's probe of the arm (probe_stamp), written into its result.json."""
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
    cmd = build_cmd(arm, task["prompt"], agents_file, settings_dir / f"{arm}.json", args.claude_bin)
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
                 "cmd": cmd[:2] + ["<prompt>"] + cmd[3:], "probe": probe},
        "result": result,
        # the mod writes <state>/turns/<sessionId>.jsonl at turn end; headless runs may have none
        "turn_records": common.find_turn_records(session) if arm in common.SPICK_ARMS else None,
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
    ap.add_argument("--arms", default=",".join(common.DEFAULT_ARMS), help="comma list; known: " + ", ".join(common.ARMS))
    ap.add_argument("--tasks", default=",".join(common.load_tasks()))
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--parallel", type=int, default=2)
    ap.add_argument("--out", default="results")
    ap.add_argument("--timeout", type=int, default=900, help="seconds per run (default 15 minutes)")
    ap.add_argument("--force", action="store_true", help="redo runs that already have a result.json")
    ap.add_argument("--claude-bin", default="claude", help="the claude executable (a stub for pipeline tests)")
    ap.add_argument("--dry-run", action="store_true", help="print the commands and exit")
    ap.add_argument("--allow-unverified", action="store_true",
                    help="go on although an arm's start-up probe failed (the arm is marked invalid in _probe.json and the report)")
    ap.add_argument("--probe-timeout", type=int, default=180, help="seconds for each arm's start-up probe call")
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
    agents_file = arms_dir / "spick-agents.json"
    agents_file.write_text(render_agents(), encoding="utf-8")
    for arm, cfg in common.ARMS.items():
        (arms_dir / f"{arm}.json").write_text(json.dumps(arm_settings(cfg), indent=2), encoding="utf-8")

    env = {k: v for k, v in os.environ.items() if k not in SESSION_VARS}
    env["PATH"] = f"{common.VENV / 'bin'}{os.pathsep}{env.get('PATH', '')}"  # same pytest for agent and grader

    # runs outermost so a partial matrix still has every cell once
    jobs = [(a, t, n) for n in range(1, args.runs + 1) for t in tids for a in arms]
    if args.dry_run:
        for arm, tid, n in jobs:
            print(arm, tid, n, build_cmd(arm, tasks[tid]["prompt"], agents_file, arms_dir / f"{arm}.json", args.claude_bin))
        return 0
    info = probe_all(arms, args, env, agents_file, arms_dir)
    probes = info["arms"]
    stamps = {a: probe_stamp(info, a) for a in probes}
    for a, p in probes.items():
        print(f"probe {a:12} {'ok' if p['ok'] else 'FAILED'} ({p['check'] or 'call'}): {p['detail']}", flush=True)
    bad = [a for a, p in probes.items() if not p["ok"]]
    if bad and not args.allow_unverified:
        sys.exit(f"start-up probe failed for {', '.join(bad)}: these arms did not start as configured, so their results "
                 f"would not mean what the arm name says. See {out / '_probe.json'}; fix the setup or rerun with "
                 "--allow-unverified (the arms are then marked invalid in the report).")
    lock = threading.Lock()
    print(f"{len(jobs)} runs, parallel {args.parallel}, out {out}", flush=True)
    with ThreadPoolExecutor(max_workers=args.parallel) as ex:
        for msg in ex.map(lambda j: do_run(j, args, env, agents_file, arms_dir, lock, stamps[j[0]]), jobs):
            if msg:
                print(msg, flush=True)
    print("ALL DONE", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
