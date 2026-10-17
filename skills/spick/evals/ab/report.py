#!/usr/bin/env python3
"""Write REPORT-<date>.md into an out dir from its grades.json.

    python3 report.py results/
"""
import argparse
import json
import math
import sys
from datetime import date
from pathlib import Path

import common


def percentile(values, p):
    """Nearest-rank percentile; None for an empty list."""
    if not values:
        return None
    v = sorted(values)
    return v[max(0, math.ceil(p / 100 * len(v)) - 1)]


def mean(values):
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def aggregate(runs):
    """{(arm, task): cell} from grades.json's runs. A cell keeps every run; nothing is dropped."""
    cells = {}
    for rid, g in runs.items():
        cells.setdefault((g["arm"], g["task"]), []).append(g)
    out = {}
    for key, gs in cells.items():
        graded = [g for g in gs if g["pass"] is not None]
        costs = [g["cost"] for g in gs if g["cost"] is not None]
        out[key] = {
            "n": len(gs), "graded": len(graded), "passed": sum(1 for g in graded if g["pass"]),
            "completed": sum(1 for g in gs if not g["error"]),
            "cost_mean": mean(costs), "cost_sum": sum(costs),
            # an outside CLI call bills elsewhere, so the Claude-side cost is a floor, not the cost
            "cost_floor": any((g.get("outside_calls") or 0) > 0 for g in gs),
            "wall_mean": mean([g["wall"] for g in gs]),
            "models": sorted({m for g in gs for m in g["models"]}),
            "labels": sum(1 for g in gs if g["label_line"]), "kept": sum(1 for g in gs if g["kept_line"]),
            "runs": gs,
        }
    return out


def arm_summary(runs, arm):
    gs = [g for g in runs.values() if g["arm"] == arm]
    graded = [g for g in gs if g["pass"] is not None]
    passed = sum(1 for g in graded if g["pass"])
    costs = [g["cost"] for g in gs if g["cost"] is not None]
    walls = [g["wall"] for g in gs if g["wall"] is not None]
    return {
        "n": len(gs), "graded": len(graded), "passed": passed,
        "completed": sum(1 for g in gs if not g["error"]),
        "cost_total": sum(costs),
        # failures are paid for too: total spend over successful deliveries
        "cost_per_success": (sum(costs) / passed) if passed else None,
        "cost_floor": any((g.get("outside_calls") or 0) > 0 for g in gs),
        "wall_p50": percentile(walls, 50), "wall_p95": percentile(walls, 95),
        "subagent_runs": sum(1 for g in gs if g.get("subagents")),
        "explore_runs": sum(1 for g in gs if g.get("explore_ran")),
        "explore_haiku": sum(1 for g in gs if g.get("explore_ran") and g.get("haiku_billed")),
        "turn_records": sum(1 for g in gs if g.get("turn_record")),
    }


def fmt_cost(v, floor=False):
    return "n/a" if v is None else f"{'>=' if floor else ''}${v:.3f}"


def fmt_s(v):
    return "n/a" if v is None else f"{v:.0f}s"


def fmt_rate(a, b):
    return f"{a}/{b}" if b else "n/a"


CAVEATS = """\
- The user's global `~/.claude/CLAUDE.md` is loaded by `claude -p` in every arm, so the bare arms still read the spick routing block. `--disallowedTools Agent` keeps `*-bare` arms from acting on it; `*-free` arms may. Read the bare arms as "no spick machinery", not "no spick text".
- One judge (Codex, medium effort) scores T5 and T7, blind and with shuffled letters, but it is a single judge: its verdicts carry its own bias and noise. Treat a judged pass rate as a signal, not a measurement. T6 is graded by rules only.
- n is small. With 3 runs per cell one flaky run moves a pass rate by a third; do not read differences smaller than that.
- Costs are `total_cost_usd` from Claude Code. A delegate on an outside CLI (Gemini, Grok, Codex) bills on its own subscription, so it is not in that figure; cells with such calls show `>=`, and an arm whose turn records are missing cannot be told apart from one with no outside calls.
- Turn records (`~/.claude/spick/turns/<sessionId>.jsonl`) are written by the mod; a headless run may have none. Their absence is not an error and leaves the turn-record column at 0.
- The mod arm relies on `disableAllHooks: true` leaving the mod's own prompt hook alone and on `--plugin-dir` taking precedence over the disabled global copy. Neither was verifiable offline; the Explore and turn-record columns below are the runtime evidence.
- The global marker `~/.claude/spick/mod-active/<sessionId>` or the v1 `~/.claude/.spick-mod-active` file may silence the hook of this checkout in `haiku-hook`, and the user's global v1 hook may print as well. `haiku-hook` is a best-effort ablation arm.
- Global agents in `~/.claude/agents` exist in every arm; `*-free` arms can use them.
- Sessions were run with the user's real settings otherwise (permissions, MCP servers, plugins other than the mod), which adds the same fixed context to every arm.
"""

CANNOT = """\
- **General non-inferiority.** Eight small tasks show whether routing held up on these tasks, not that a routed Haiku session is as good as Opus on work of any other kind.
- **Real bills.** `total_cost_usd` is list-price arithmetic from token counts. It ignores subscription quotas, outside-CLI delegates and the user's plan; the judge's cost is not in it either.
- **Long-session cache effects.** Each run is a fresh one-prompt session. Prompt caching across a long working session, where the routing block is paid for once and reused, is not exercised; neither is context growth over many turns.
- **Leak safety.** Nothing here tests whether a lane's declared data level is respected, or whether code or secrets would reach a lane they should not.
"""


def render(out_dir, today):
    data = json.loads((Path(out_dir) / "grades.json").read_text(encoding="utf-8"))
    runs, judge = data["runs"], data.get("judge", {})
    cells = aggregate(runs)
    tasks = common.load_tasks()
    arms = [a for a in common.ARMS if any(k[0] == a for k in cells)]
    tids = [t for t in tasks if any(k[1] == t for k in cells)]
    L = [f"# spick A/B report - {today}", "", f"Out dir: `{Path(out_dir).resolve().name}`; {len(runs)} runs, "
         f"arms: {', '.join(arms)}; tasks: {', '.join(tids)}.", ""]

    L += ["## Per arm", "",
          "| arm | quality (pass) | completion | cost total | cost per successful delivery | wall p50 | wall p95 |",
          "|---|---|---|---|---|---|---|"]
    for a in arms:
        s = arm_summary(runs, a)
        L.append(f"| {a} | {fmt_rate(s['passed'], s['graded'])} | {fmt_rate(s['completed'], s['n'])} | "
                 f"{fmt_cost(s['cost_total'], s['cost_floor'])} | {fmt_cost(s['cost_per_success'], s['cost_floor'])} | "
                 f"{fmt_s(s['wall_p50'])} | {fmt_s(s['wall_p95'])} |")
    L += ["", "Quality counts graded runs only (a judged cell whose judge call failed is left out). Completion is runs that "
          "returned a result without error or timeout. Cost per successful delivery is the arm's whole spend, failures "
          "included, over its passes.", ""]

    L += ["## Per arm and task", "",
          "Every cell is kept, including the ones where an arm loses (marked LOSES: pass rate below the best arm on that task).", "",
          "| task | arm | pass | completed | mean cost | mean wall | models | label line | Kept: line |",
          "|---|---|---|---|---|---|---|---|---|"]
    for t in tids:
        best = max((c["passed"] / c["graded"] for k, c in cells.items() if k[1] == t and c["graded"]), default=None)
        for a in arms:
            c = cells.get((a, t))
            if not c:
                continue
            loses = best is not None and c["graded"] and c["passed"] / c["graded"] < best
            L.append(f"| {t} {tasks[t]['name']} | {a} | {fmt_rate(c['passed'], c['graded'])}{' LOSES' if loses else ''} | "
                     f"{fmt_rate(c['completed'], c['n'])} | {fmt_cost(c['cost_mean'], c['cost_floor'])} | "
                     f"{fmt_s(c['wall_mean'])} | {', '.join(m.replace('claude-', '') for m in c['models']) or '-'} | "
                     f"{c['labels']}/{c['n']} | {c['kept']}/{c['n']} |")
    L.append("")

    failed = [(rid, g) for rid, g in runs.items() if g["pass"] is False]
    if failed:
        L += ["## Failed runs", ""]
        for rid, g in sorted(failed):
            why = "error/timeout" if g["error"] else ", ".join(
                f"{k}={g[k]}" for k in ("visible_pass", "hidden_pass", "tests_untouched", "chars", "forbidden_found",
                                        "judge_overall") if k in g) or "check failed"
            L.append(f"- `{rid}`: {why}")
        L.append("")

    L += ["## Tier use and Explore", "",
          "| arm | runs that spawned a subagent | Explore ran | Explore with Haiku billed | runs with a turn record |", "|---|---|---|---|---|"]
    for a in arms:
        s = arm_summary(runs, a)
        L.append(f"| {a} | {s['subagent_runs']}/{s['n']} | {s['explore_runs']}/{s['n']} | {s['explore_haiku']}/{s['n']} | {s['turn_records']}/{s['n']} |")
    L += ["", "The Explore check is the spec's runtime acceptance for the Explore override: in `haiku-spick` and the `*-free` "
          "arms, `subagent_stats.by_type` must show Explore and `modelUsage` a Haiku line. On a Haiku main session the "
          "Haiku line alone proves nothing, so read the Explore column with it.", ""]

    L += ["## Tier match", "", "| task | ideal | " + " | ".join(arms) + " |", "|---|---|" + "---|" * len(arms)]
    for t in tids:
        row = []
        for a in arms:
            c = cells.get((a, t))
            ms = [g["tier_match"] for g in c["runs"] if g["tier_match"] is not None] if c else []
            row.append(fmt_rate(sum(ms), len(ms)))
        L.append(f"| {t} | {tasks[t]['ideal_tier']} | " + " | ".join(row) + " |")
    L.append("")

    L += ["## Judge", ""]
    if judge:
        toks = sum(j["tokens"] or 0 for j in judge.values())
        L.append(f"{sum(j['calls'] for j in judge.values())} Codex call(s) over {', '.join(sorted(judge))}; about {toks:,} tokens; "
                 "cost unknown (a subscription CLI reports no dollar figure). It is kept out of every arm's cost above.")
    else:
        L.append("No judge call recorded (grading ran with `--no-judge`, or no judged task was in the matrix).")
    L += ["", "## Caveats", "", CAVEATS, "## What this matrix cannot show", "", CANNOT]
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out")
    ap.add_argument("--date", default=date.today().isoformat())
    args = ap.parse_args()
    if not (Path(args.out) / "grades.json").exists():
        sys.exit("no grades.json: run grade.py first")
    path = Path(args.out) / f"REPORT-{args.date}.md"
    path.write_text(render(args.out, args.date), encoding="utf-8")
    print("wrote", path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
