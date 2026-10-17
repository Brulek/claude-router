#!/usr/bin/env python3
"""Write REPORT-<date>.md into an out dir from its grades.json.

    python3 report.py results/
"""
import argparse
import json
import math
import sys
from collections import Counter
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


def run_floor(g):
    """A run's cost_floor from grade.py: True (part bills elsewhere), False (the figure is whole) or None (unknown: a
    spick arm without its turn record). grades.json written before the field is read by the same rule."""
    if "cost_floor" in g:
        return g["cost_floor"]
    if (g.get("outside_calls") or 0) > 0 or (g.get("unpriced_delegates") or 0) > 0:
        return True
    return None if g.get("arm") in common.SPICK_ARMS and not g.get("turn_record") else False


def cost_floor(gs):
    """The Claude-side cost is a floor when a run called an outside CLI (it bills elsewhere) or had a delegate
    whose cost is unknown."""
    return any(run_floor(g) is True for g in gs)


def floor_unknown(gs):
    """The runs whose floor is unknown: their cost may be the whole or a floor, nothing tells which."""
    return sum(1 for g in gs if run_floor(g) is None)


def cost_summary(gs):
    """(total, priced). The total is None unless every run has a priced cost: a sum over the priced ones alone
    would pass for the whole cell. priced is the number of runs that carry a cost."""
    costs = [g["cost"] for g in gs if g.get("cost") is not None]
    return (sum(costs) if len(costs) == len(gs) else None), len(costs)


def aggregate(runs):
    """{(arm, task): cell} from grades.json's runs. A cell keeps every run; nothing is dropped."""
    cells = {}
    for rid, g in runs.items():
        cells.setdefault((g["arm"], g["task"]), []).append(g)
    out = {}
    for key, gs in cells.items():
        graded = [g for g in gs if g["pass"] is not None]
        total, priced = cost_summary(gs)
        out[key] = {
            "n": len(gs), "graded": len(graded), "passed": sum(1 for g in graded if g["pass"]),
            "completed": sum(1 for g in gs if not g["error"]),
            "cost_total": total, "cost_priced": priced, "cost_coverage": priced / len(gs),
            "cost_mean": total / len(gs) if total is not None else None,
            "cost_floor": cost_floor(gs), "floor_unknown": floor_unknown(gs),
            "wall_mean": mean([g["wall"] for g in gs]),
            "models": sorted({m for g in gs for m in g["models"]}),
            "labels": sum(1 for g in gs if g["label_line"]), "kept": sum(1 for g in gs if g["kept_line"]),
            "probe": cell_probe(gs),
            "runs": gs,
        }
    return out


def arm_summary(runs, arm):
    gs = [g for g in runs.values() if g["arm"] == arm]
    graded = [g for g in gs if g["pass"] is not None]
    passed = sum(1 for g in graded if g["pass"])
    total, priced = cost_summary(gs)
    walls = [g["wall"] for g in gs if g["wall"] is not None]
    return {
        "n": len(gs), "graded": len(graded), "passed": passed,
        "completed": sum(1 for g in gs if not g["error"]),
        "cost_total": total, "cost_priced": priced, "cost_coverage": priced / len(gs) if gs else None,
        # failures are paid for too: total spend over successful deliveries
        "cost_per_success": (total / passed) if passed and total is not None else None,
        "cost_floor": cost_floor(gs), "floor_unknown": floor_unknown(gs),
        "wall_p50": percentile(walls, 50), "wall_p95": percentile(walls, 95),
        "subagent_runs": sum(1 for g in gs if g.get("subagents")),
        "explore_runs": sum(1 for g in gs if g.get("explore_ran")),
        "explore_haiku": sum(1 for g in gs if g.get("explore_haiku") is True),
        "explore_unknown": sum(1 for g in gs if g.get("explore_haiku") == "unknown"),
        "turn_records": sum(1 for g in gs if g.get("turn_record")),
    }


def probe_state(g):
    """(state, head) of the probe a run was made under: verified, accepted (a best-effort arm), invalid (the probe
    failed) or none (the run carries no probe)."""
    p = g.get("probe")
    if not isinstance(p, dict):
        return "none", None
    if not p.get("ok"):
        return "invalid", p.get("checkout_head")
    return ("accepted" if p.get("check") == "best-effort" else "verified"), p.get("checkout_head")


def cell_probe(gs):
    """A cell is verified only when every run in it carries a passing probe of the same checkout HEAD: runs resumed
    from an earlier invocation keep their own probe, so the latest _probe.json cannot vouch for them."""
    states = [probe_state(g) for g in gs]
    m = len(states)
    for state, word in (("verified", "verified"), ("accepted", "accepted, not verified")):
        heads = Counter(h for s, h in states if s == state and h)
        if heads:
            head, n = heads.most_common(1)[0]
            if n == m:
                return f"{word} at HEAD {head[:12]}"
            if state == "verified":
                return f"mixed ({n} of {m} verified at HEAD {head[:12]})"
    counts = Counter(s for s, _ in states)
    parts = [f"{counts[s]} {w}" for s, w in (("invalid", "invalid"), ("none", "without a probe"),
                                                 ("accepted", "best-effort"), ("verified", "HEAD unknown")) if counts[s]]
    return f"not verified ({', '.join(parts)})"


def fmt_cost(v, floor=False, priced=None, n=None, unknown=0):
    """A missing figure with unpriced runs reads "unknown (priced/n priced)"; with every run priced (no success to
    divide by) it stays n/a. `unknown` runs with an unknown floor add "? (k/n floor unknown)": the figure may leave
    out what bills elsewhere, and nothing says whether it does."""
    tail = f" ? ({unknown}/{n} floor unknown)" if unknown else ""
    if v is None:
        return (f"unknown ({priced}/{n} priced)" if n and priced < n else "n/a") + tail
    return f"{'>=' if floor else ''}${v:.3f}{tail}"


def fmt_s(v):
    return "n/a" if v is None else f"{v:.0f}s"


def fmt_rate(a, b):
    return f"{a}/{b}" if b else "n/a"


CAVEATS = """\
- The user's global `~/.claude/CLAUDE.md` is loaded by `claude -p` in every arm, so the bare arms still read the spick routing block. `--disallowedTools Agent` keeps `*-bare` arms from acting on it; `*-free` arms may. Read the bare arms as "no spick machinery", not "no spick text".
- The judge (Codex at medium effort; with `grade.py --judges codex,claude` also Opus through `claude -p` with no tools) scores the judged tasks blind, under shuffled letters, each answer on its own. One judge carries its own bias and noise: treat a judged pass rate as a signal, not a measurement. Two judges that agree make it more than that; two that disagree flag the cell (see the Second judge section). T6 is graded by rules only.
- n is small. With 3 runs per cell one flaky run moves a pass rate by a third; do not read differences smaller than that.
- Costs are `total_cost_usd` from Claude Code. A delegate on an outside CLI (Gemini, Grok, Codex) bills on its own subscription, so it is not in that figure; cells with such calls show `>=`, and a spick-arm run whose turn record is missing cannot be told apart from one with no outside calls, so its cost carries `?`.
- Turn records (`~/.claude/spick/turns/<sessionId>.jsonl`) are written by the mod; a headless run may have none. Their absence is not an error and leaves the turn-record column at 0.
- The mod arm (`haiku-spick`) leaves hooks on: `disableAllHooks` would disable the mod itself (measured on 2026-10-17). The `enabledPlugins` key keeps the globally installed copy out, and the mod's per-session marker silences the user's global spick hook. The start-up probe above is the check; the Explore and turn-record columns below are further runtime evidence.
- `haiku-hook` is a best-effort ablation arm: with a symlinked install the user's global hook is this checkout's hook and is not added twice; on a machine with a different global hook both would print, and a stale per-session marker could silence it.
- Global agents in `~/.claude/agents` exist in every arm; `*-free` arms can use them.
- Sessions were run with the user's real settings otherwise (permissions, MCP servers, plugins other than the mod), which adds the same fixed context to every arm.
"""

CANNOT = """\
- **General non-inferiority.** Eight small tasks show whether routing held up on these tasks, not that a routed Haiku session is as good as Opus on work of any other kind.
- **Real bills.** `total_cost_usd` is list-price arithmetic from token counts. It ignores subscription quotas, outside-CLI delegates and the user's plan; the judge's cost is not in it either.
- **Long-session cache effects.** Each run is a fresh one-prompt session. Prompt caching across a long working session, where the routing block is paid for once and reused, is not exercised; neither is context growth over many turns.
- **A spick-free baseline.** The `*-free` arms still read the user's global `~/.claude/CLAUDE.md`, which may carry the spick block. They are strong-model baselines with spick's instructions visible but no spick tooling, not models that have never seen spick.
- **Leak safety.** Nothing here tests whether a lane's declared data level is respected, or whether code or secrets would reach a lane they should not.
"""


def probe_lines(out_dir):
    """Caveat bullets from <out>/_probe.json: version, checkout head and what each arm's start-up probe showed in the
    latest invocation only (each cell's own probes are in the per-task table)."""
    path = Path(out_dir) / "_probe.json"
    if not path.exists():
        return ["- **Arm start-up probe: none recorded** (`_probe.json` is missing), so nothing here shows that the arms "
                "started as their names say."]
    info = json.loads(path.read_text(encoding="utf-8"))
    head = (info.get("checkout_head") or "unknown")[:12]
    L = [f"- Arm start-up probe of the latest invocation only; the per-task table reads each run's own "
         f"(claude `{info.get('claude_version') or 'version unknown'}`, checkout `{head}`"
         f"{', run with --allow-unverified' if info.get('allow_unverified') else ''}):"]
    for arm, p in (info.get("arms") or {}).items():
        state = "INVALID" if not p.get("ok") else ("accepted, not verified" if p.get("check") == "best-effort" else "verified")
        L.append(f"  - `{arm}`: **{state}** - {p.get('detail') or 'no detail'}")
    return L


def judge_order(judge, cells):
    """Judge names in grading order: the first one decided pass. From the judge info's `judges` map (insertion order
    is the --judges order), then any name only the runs carry."""
    names = []
    for j in judge.values():
        names += [n for n in (j.get("judges") or {"codex": j}) if n not in names]
    for c in cells.values():
        for g in c["runs"]:
            names += [n for n in (g.get("judges") or {}) if n not in names]
    return names


def judge_lines(judge, cells):
    """One line per judge. A grades.json written before the `judges` map existed is a Codex-only grading."""
    if not judge:
        return ["No judge call recorded (grading ran with `--no-judge`, or no judged task was in the matrix)."]
    per_judge = {}
    for tid, j in judge.items():
        for name, v in (j.get("judges") or {"codex": j}).items():
            per_judge.setdefault(name, {})[tid] = v
    L = []
    for name in [n for n in judge_order(judge, cells) if n in per_judge]:
        per = per_judge[name]
        toks = sum(v.get("tokens") or 0 for v in per.values())
        costs = [v.get("cost_usd") for v in per.values()]
        cost = (f"${sum(costs):.2f} by total_cost_usd" if costs and all(c is not None for c in costs)
                else "cost unknown (a subscription CLI reports no dollar figure)")
        L.append(f"- `{name}`: {sum(v.get('calls') or 0 for v in per.values())} call(s) over {', '.join(sorted(per))}; "
                 f"about {toks:,} tokens; {cost}. Kept out of every arm's cost above.")
    return L


def fmt_mean(values):
    return f"{sum(values) / len(values):.2f}" if values else "-"


def agreement_lines(judge, cells, arms, tids):
    """When two judges scored the runs: each judge's mean per cell and how many runs they put within one point of each
    other. The first judge named at grading decided pass; this shows what the second one would change."""
    names = judge_order(judge, cells)
    if len(names) < 2:
        return []
    a, b = names[0], names[1]
    L = ["## Second judge", "", f"Judges `{a}` and `{b}` scored the same answers blind, under the same letters. A run is "
         "agreed when their overall scores are within one point of each other.", "",
         f"| task | arm | {a} mean | {b} mean | scored by both | within 1 point |", "|---|---|---|---|---|---|"]
    tot_both = tot_agree = 0
    for t in tids:
        for arm in arms:
            c = cells.get((arm, t))
            js = [g["judges"] for g in (c["runs"] if c else []) if g.get("judges")]
            if not js:
                continue
            both = [j for j in js if a in j and b in j]
            agree = sum(1 for j in both if abs(j[a] - j[b]) <= 1)
            tot_both += len(both)
            tot_agree += agree
            L.append(f"| {t} | {arm} | {fmt_mean([j[a] for j in js if a in j])} | {fmt_mean([j[b] for j in js if b in j])} | "
                     f"{len(both)} | {agree} |")
    return L + ["", f"Over all judged runs: {tot_agree} of {tot_both} scored by both judges are within one point.", ""]


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
                 f"{fmt_cost(s['cost_total'], s['cost_floor'], s['cost_priced'], s['n'], s['floor_unknown'])} | "
                 f"{fmt_cost(s['cost_per_success'], s['cost_floor'], s['cost_priced'] if s['passed'] else s['n'], s['n'], s['floor_unknown'])} | "
                 f"{fmt_s(s['wall_p50'])} | {fmt_s(s['wall_p95'])} |")
    L += ["", "Quality counts graded runs only (a judged cell whose judge call failed is left out). Completion is runs that "
          "returned a result without error or timeout. Cost per successful delivery is the arm's whole spend, failures "
          "included, over its passes. A cost is `unknown (n/m priced)` when some runs carry no priced cost (a failed or "
          "unparsed run): a sum over the priced runs alone would understate it. `>=` marks a floor: an outside-CLI call or "
          "a delegate with an unknown cost bills outside the figure. `?` marks a cost with runs whose floor is unknown "
          "(`k/n floor unknown`): a spick arm's run without its turn record, whose outside calls cannot be counted.", ""]

    L += ["## Per arm and task", "",
          "Every cell is kept, including the ones where an arm loses (marked LOSES: pass rate below the best arm on that task).", "",
          "| task | arm | pass | completed | mean cost | mean wall | models | label line | Kept: line | start-up probe |",
          "|---|---|---|---|---|---|---|---|---|---|"]
    for t in tids:
        best = max((c["passed"] / c["graded"] for k, c in cells.items() if k[1] == t and c["graded"]), default=None)
        for a in arms:
            c = cells.get((a, t))
            if not c:
                continue
            loses = best is not None and c["graded"] and c["passed"] / c["graded"] < best
            L.append(f"| {t} {tasks[t]['name']} | {a} | {fmt_rate(c['passed'], c['graded'])}{' LOSES' if loses else ''} | "
                     f"{fmt_rate(c['completed'], c['n'])} | {fmt_cost(c['cost_mean'], c['cost_floor'], c['cost_priced'], c['n'], c['floor_unknown'])} | "
                     f"{fmt_s(c['wall_mean'])} | {', '.join(m.replace('claude-', '') for m in c['models']) or '-'} | "
                     f"{c['labels']}/{c['n']} | {c['kept']}/{c['n']} | {c['probe']} |")
    L += ["", "The start-up probe column reads each run's own probe (written into its result.json when it ran): a cell is "
          "verified only when every run in it passed its probe at the same checkout HEAD; runs kept from an earlier "
          "invocation carry that invocation's probe, or none.", ""]

    failed = [(rid, g) for rid, g in runs.items() if g["pass"] is False]
    if failed:
        L += ["## Failed runs", ""]
        for rid, g in sorted(failed):
            why = f"error ({g.get('error_reason') or 'unknown'})" if g["error"] else ", ".join(
                f"{k}={g[k]}" for k in ("visible_pass", "hidden_pass", "tests_untouched", "chars", "forbidden_found",
                                        "judge_overall") if k in g) or "check failed"
            L.append(f"- `{rid}`: {why}")
        L.append("")

    L += ["## Tier use and Explore", "",
          "| arm | runs that spawned a subagent | Explore ran | Explore agent on Haiku | runs with a turn record |", "|---|---|---|---|---|"]
    for a in arms:
        s = arm_summary(runs, a)
        L.append(f"| {a} | {s['subagent_runs']}/{s['n']} | {s['explore_runs']}/{s['n']} | {s['explore_haiku']}/{s['n']}"
                 f"{' (+' + str(s['explore_unknown']) + ' unknown)' if s['explore_unknown'] else ''} | {s['turn_records']}/{s['n']} |")
    L += ["", "The Explore check is the spec's runtime acceptance for the Explore override: in `haiku-spick` and the `*-free` "
          "arms, the Explore agent itself must be shown on Haiku, by `subagent_stats.by_type` or, if that names no model, "
          "by the turn record's `delegates[]`. A Haiku line in `modelUsage` is not evidence (a Haiku main session bills "
          "one anyway). \"unknown\" counts runs where Explore ran but no source names its model; they are not passes.", ""]

    L += ["## Tier match", "", "| task | ideal | " + " | ".join(arms) + " |", "|---|---|" + "---|" * len(arms)]
    for t in tids:
        row = []
        for a in arms:
            c = cells.get((a, t))
            ms = [g["tier_match"] for g in c["runs"] if g["tier_match"] is not None] if c else []
            row.append(fmt_rate(sum(ms), len(ms)))
        L.append(f"| {t} | {tasks[t]['ideal_tier']} | " + " | ".join(row) + " |")
    L.append("")

    L += ["## Judge", "", *judge_lines(judge, cells), "", *agreement_lines(judge, cells, arms, tids)]
    L += ["## Caveats", "", *probe_lines(out_dir), CAVEATS, "## What this matrix cannot show", "", CANNOT]
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
