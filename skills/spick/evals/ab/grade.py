#!/usr/bin/env python3
"""Grade every run under an out dir: exact checks, hidden tests, rules, and one blind judge call per judged task.

    python3 grade.py results/            # writes results/grades.json and results/judge/
    python3 grade.py results/ --no-judge # skip codex; judged cells stay pass=null

The judge sees all answers of a task at once under shuffled letters, with the arm-revealing
`[Model:` and `Kept:` lines cut; the letter -> run key is written next to the judge's raw output.
"""
import argparse
import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import sys
from pathlib import Path

import common

JUDGE_SEED = 42
ANSWER_CAP = 4000  # chars of one answer shown to the judge


# ---- pure checks -----------------------------------------------------------------------------

def sha256(path):
    p = Path(path)
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None


def grade_exact_csv(actual, expected):
    """Equal after dropping a BOM, CRs and surrounding blank space."""
    if actual is None:
        return False
    norm = lambda s: s.lstrip("﻿").replace("\r", "").strip()
    return norm(actual) == norm(expected)


def grade_exact_text(answer, check):
    text = common.strip_markers(answer)
    return (all(w in text for w in check.get("must_contain", []))
            and not any(w in text for w in check.get("must_not_contain", [])))


def grade_rules(answer, check):
    """T6: length counted without whitespace on the answer minus label lines, placeholders, forbidden words."""
    text = common.strip_markers(answer)
    n = len(re.sub(r"\s", "", text))
    placeholders = all(p in text for p in check["placeholders"])
    banned = [w for w in check["forbidden"] if w in text]
    ok = check["min_chars"] <= n <= check["max_chars"] and placeholders and not banned
    return {"pass": ok, "chars": n, "placeholders": placeholders, "forbidden_found": banned}


def pinned_untouched(work, template, pinned):
    """The visible tests the agent must not edit: sha256 against the template copy."""
    return all(sha256(Path(work) / p) == sha256(Path(template) / p) for p in pinned)


def tier_match(models, ideal):
    """True when the work was done on the ideal tier. Haiku ideal: only Haiku ran. Otherwise the ideal tier ran
    and nothing above it did (Haiku, the triage layer, is always allowed)."""
    if not models:
        return None
    if ideal == "haiku":
        return all("haiku" in m for m in models)
    order = ["haiku", "sonnet", "opus"]
    tier = lambda m: next((t for t in order if t in m), None)
    tiers = {tier(m) for m in models}
    return ideal in tiers and all(t in ("haiku", ideal) for t in tiers if t)


# ---- judge ------------------------------------------------------------------------------------

def build_judge_prompt(rubric, task_prompt, answers, material="", seed=JUDGE_SEED):
    """answers: [(run_id, text)]. Returns (prompt, key) with key {letter: run_id}; order and letters are shuffled."""
    order = list(answers)
    random.Random(seed).shuffle(order)
    key = {chr(ord("A") + i): rid for i, (rid, _) in enumerate(order)}
    blocks = "\n\n".join(f"=== 回答 {chr(ord('A') + i)} ===\n{common.strip_markers(t)[:ANSWER_CAP]}"
                         for i, (_, t) in enumerate(order))
    letters = ", ".join(key)
    prompt = (f"你是独立评审。下面是同一任务的多份回答，标签为 {letters}，你不知道它们由谁生成，也不要猜测来源。\n"
              f"任务原文：{task_prompt}\n{material}\n{rubric}\n"
              f"每份回答独立评分，不要在回答之间互相比较排名。\n\n{blocks}\n\n"
              "先用几句话说明理由，最后单独一行输出（单行 JSON）：JUDGE_JSON: "
              '{"A": {"scores": {...}, "overall": n}, "B": {...}}，覆盖全部标签。')
    return prompt, key


def parse_judge(text, letters):
    """{letter: overall} from the last JUDGE_JSON line; missing or unparsable letters are absent."""
    found = None
    for m in re.finditer(r"JUDGE_JSON:\s*(\{.*)", text):
        raw = m.group(1).strip()
        try:
            found = json.loads(raw)
        except ValueError:
            # the model may wrap the line; take the longest balanced prefix
            depth = 0
            for i, ch in enumerate(raw):
                depth += (ch == "{") - (ch == "}")
                if depth == 0:
                    try:
                        found = json.loads(raw[: i + 1])
                    except ValueError:
                        pass
                    break
    if not isinstance(found, dict):
        return {}
    out = {}
    for letter in letters:
        v = found.get(letter)
        if isinstance(v, dict) and isinstance(v.get("overall"), (int, float)):
            out[letter] = v["overall"]
    return out


def template_text(task):
    if not task["template"]:
        return ""
    root = common.TASKS_DIR / task["template"]
    parts = [f"--- {p.relative_to(root)} ---\n{p.read_text(encoding='utf-8')}"
             for p in sorted(root.rglob("*")) if p.is_file()]
    return "回答所针对的材料：\n" + "\n".join(parts)


def call_codex(prompt, cwd, timeout=900):
    cmd = ["codex", "exec", "--skip-git-repo-check", "--sandbox", "read-only",
           "-c", 'model_reasoning_effort="medium"', prompt]
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=timeout)
    return r.stdout + "\n--stderr--\n" + r.stderr[-800:]


# ---- tests in the work tree --------------------------------------------------------------------

def run_pytest(work, paths, timeout=180):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PATH=f"{common.VENV / 'bin'}{os.pathsep}{os.environ.get('PATH', '')}")
    try:
        r = subprocess.run([str(common.venv_python()), "-m", "pytest", "-q", "-p", "no:cacheprovider", *paths],
                           cwd=work, env=env, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return False
    return r.returncode == 0


def grade_hidden(work, task):
    chk = task["check"]
    tmpl = common.TASKS_DIR / task["template"]
    g = {"tests_untouched": pinned_untouched(work, tmpl, chk["pinned"])}
    g["visible_pass"] = run_pytest(work, chk["visible"])
    # the hidden file is only there while it runs, so the work tree stays as the agent left it
    dest = Path(work) / chk["hidden_dest"]
    shutil.copy(common.TASKS_DIR / chk["hidden"], dest)
    try:
        g["hidden_pass"] = run_pytest(work, [chk["hidden_dest"]])
    finally:
        dest.unlink(missing_ok=True)
    g["pass"] = g["visible_pass"] and g["hidden_pass"] and g["tests_untouched"]
    return g


# ---- per-run grading ---------------------------------------------------------------------------

# delegates on these lanes bill inside the Claude run; anything else is an outside CLI whose cost is not in total_cost_usd
CLAUDE_LANES = {"coder", "deep", "planner", "explore"}


def outside_calls(turn_records):
    """Number of outside-CLI delegates in the turn records; None when there is no record to tell."""
    if not turn_records:
        return None
    return sum(1 for r in turn_records for d in (r.get("delegates") or [])
               if str(d.get("lane", "")).lower() not in CLAUDE_LANES)


def explore_ran(res):
    """The Explore override is only checkable at runtime: did an Explore agent run, and was any Haiku billed?
    (On a Haiku main session the Haiku line alone proves nothing; the agent type is what counts.)"""
    by_type = (res.get("subagent_stats") or {}).get("by_type") or {}
    ran = any(str(k).lower() == "explore" for k in by_type)
    return ran, any("haiku" in m for m in (res.get("modelUsage") or {}))


def run_metrics(rec, task):
    meta, res = rec["meta"], rec.get("result") or {}
    models = sorted((res.get("modelUsage") or {}).keys())
    answer = res.get("result") or ""
    return {
        "arm": meta["arm"], "task": meta["task"], "run": meta["run"],
        "error": bool(res.get("is_error")) or not res or meta.get("timed_out", False),
        "timed_out": meta.get("timed_out", False),
        "cost": res.get("total_cost_usd"), "wall": meta.get("wall_seconds"),
        "turns": res.get("num_turns"), "models": models,
        "subagents": (res.get("subagent_stats") or {}).get("spawned"),
        "label_line": common.has_label(answer), "kept_line": common.has_kept(answer),
        "ideal": task["ideal_tier"], "tier_match": tier_match(models, task["ideal_tier"]),
        "turn_record": rec.get("turn_records") is not None,
        "outside_calls": outside_calls(rec.get("turn_records")),
        "explore_ran": explore_ran(res)[0], "haiku_billed": explore_ran(res)[1],
        "subagent_types": (res.get("subagent_stats") or {}).get("by_type") or {},
    }


def grade_run(rdir, rec, task):
    g = run_metrics(rec, task)
    answer = (rec.get("result") or {}).get("result") or ""
    work = Path(rdir) / "work"
    kind = task["grader"]
    if g["error"]:
        g["pass"] = False
    elif kind == "exact_csv":
        f = work / task["check"]["file"]
        g["pass"] = grade_exact_csv(f.read_text(encoding="utf-8", errors="replace") if f.exists() else None,
                                    task["check"]["expected"])
    elif kind == "exact_text":
        g["pass"] = grade_exact_text(answer, task["check"])
    elif kind == "rules":
        g.update(grade_rules(answer, task["check"]))
    elif kind == "hidden_tests":
        g.update(grade_hidden(work, task))
    elif kind == "judge":
        g["pass"] = None  # filled in by the judge pass
    return g


def judge_task(out, tid, task, graded, judge_info, args):
    """One blind call over every non-error answer of the task; fills pass/judge_overall into graded."""
    jdir = Path(out) / "judge"
    jdir.mkdir(exist_ok=True)
    answers = []
    for rid, g in graded.items():
        if g["task"] == tid and not g["error"]:
            rec = json.loads((Path(out) / g["arm"] / tid / f"run-{g['run']}" / "result.json").read_text(encoding="utf-8"))
            answers.append((rid, rec["result"].get("result") or ""))
    if not answers or args.no_judge:
        return
    keyf, rawf = jdir / f"{tid}.key.json", jdir / f"{tid}.txt"
    key = json.loads(keyf.read_text()) if keyf.exists() else None
    if args.rejudge or key is None or sorted(key.values()) != sorted(r for r, _ in answers) or not rawf.exists():
        prompt, key = build_judge_prompt(task["rubric"], task["prompt"], answers, template_text(task))
        raw = call_codex(prompt, jdir)
        keyf.write_text(json.dumps(key, indent=2), encoding="utf-8")
        rawf.write_text(raw, encoding="utf-8")
    raw_text = rawf.read_text(encoding="utf-8")
    # priced separately by the report; a subscription CLI has no per-call dollar figure, so cost stays unknown
    m = re.search(r"tokens used\s*([\d,]+)", raw_text)
    judge_info[tid] = {"calls": 1, "tokens": int(m.group(1).replace(",", "")) if m else None, "cost_usd": None}
    scores = parse_judge(raw_text, key)
    need = task["check"]["pass_overall"]
    for letter, rid in key.items():
        if letter in scores:
            graded[rid]["judge_overall"] = scores[letter]
            graded[rid]["pass"] = scores[letter] >= need
    print(f"judge {tid}: {len(scores)}/{len(key)} answers scored")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out")
    ap.add_argument("--no-judge", action="store_true")
    ap.add_argument("--rejudge", action="store_true", help="call the judge again even if a cached verdict matches")
    args = ap.parse_args()
    if not common.venv_python().exists():
        sys.exit("no venv yet: run `python3 run.py --setup` first")
    tasks = common.load_tasks()
    graded, judge_info = {}, {}
    for arm, tid, n, rdir in common.run_dirs(args.out):
        rec = json.loads((rdir / "result.json").read_text(encoding="utf-8"))
        graded[f"{arm}/{tid}/run-{n}"] = grade_run(rdir, rec, tasks[tid])
    for tid in sorted({g["task"] for g in graded.values()}):
        if tasks[tid]["grader"] == "judge":
            judge_task(args.out, tid, tasks[tid], graded, judge_info, args)
    (Path(args.out) / "grades.json").write_text(json.dumps({"runs": graded, "judge": judge_info}, ensure_ascii=False, indent=2), encoding="utf-8")
    for rid, g in graded.items():
        print(f"{rid:28} pass={g['pass']} cost={g['cost']} wall={g['wall']} models={g['models']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
