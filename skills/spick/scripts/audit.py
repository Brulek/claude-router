#!/usr/bin/env python3
"""spick audit (stdlib only): what the routing decisions were and what became of them, from the turn records.

The dashboard mod writes one JSON line per main turn to <config>/spick/turns/<sessionId>.jsonl (hooks/turnlog.ts;
spend.py reads the same files for cost). This report answers the questions the record exists for:

  - turns by hint kind, and what ran for them (a delegate's lane, or `self`);
  - hinted verdicts (judgement or review words): delegated to the role, kept with a Kept: line, or neither;
  - gate firings and their outcomes; a `kept` after a `sent-back` is a false positive candidate;
  - turns that edited source with no passing check after the last edit;
  - escalations on a twice-failed check, and whether a coder or deep followed;
  - cost by lane and by hint kind (outside CLI calls report no usage: counted, unpriced);
  - the longest sessions by context size (the main loop's largest prompt).

Usage:
  audit.py [--days N] [--json]
    --days N   turns from the last N days (default 7)
    --json     print the figures as JSON instead of text
Prints "spick audit: no records" when no turn falls in the window. Exit 0; 2 on a bad argument.
"""
import argparse
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import spend  # noqa: E402

VERDICT_KINDS = ("judgement", "review")
TOP_SESSIONS = 5


def _done(t):
    """how a hinted verdict ended: delegated (its role completed or still runs), kept (a Kept: line) or neither"""
    ds = t.get("delegates") or []
    live = ("completed", "running")
    deep = any(d.get("lane") == "deep" and d.get("status") in live for d in ds)
    # a review call counts from 200 characters of output (gate.ts MIN_REVIEW_CHARS); records before it lack the field
    review = any(d.get("isReview") and d.get("status") == "completed" and (spend._num(d.get("outputChars")) is None or d["outputChars"] >= 200) for d in ds)
    hint = t.get("hint") or []
    needs_deep = "judgement" in hint
    if deep or (not needs_deep and review):
        return "delegated"
    return "kept" if t.get("kept") else "neither"


def _covered(t):
    """an edit turn is covered when a check passed after its last completed edit (records before 2026-10-17 say coversTurn)"""
    checks = [c for c in t.get("checks") or [] if isinstance(c, dict)]
    if checks:
        return any(c.get("coversTurn") or (c.get("exitOk") is True and c.get("afterLastEdit") is True) for c in checks)
    c = t.get("check")
    return isinstance(c, dict) and bool(c.get("passed")) and bool(c.get("afterLastEdit"))


def _cost(v):
    return spend._num(v)


def _add_cost(bucket, key, cost):
    b = bucket.setdefault(key, {"costUsd": None, "unpriced": 0, "items": 0})
    b["items"] += 1
    if cost is None:
        b["unpriced"] += 1
    else:
        b["costUsd"] = (b["costUsd"] or 0) + cost


def figures(turns, days, now):
    """the audit's figures for the turns of the last `days` days (late-only stubs are cost, not turns)"""
    since = now - dt.timedelta(days=days)
    win = []
    for t in turns:
        at = spend.parse_at(t.get("at"))
        if at is not None and at >= since:
            win.append(t)
    real = [t for t in win if not t.get("lateOnly")]

    by_kind = {}
    for t in real:
        ran = sorted({str(d.get("lane") or "?") for d in t.get("delegates") or []}) or ["self"]
        for kind in (t.get("hint") or ["none"]):
            k = by_kind.setdefault(kind, {"turns": 0, "ran": {}})
            k["turns"] += 1
            for lane in ran:
                k["ran"][lane] = k["ran"].get(lane, 0) + 1

    verdicts = {"turns": 0, "delegated": 0, "kept": 0, "neither": 0}
    for t in real:
        if any(k in VERDICT_KINDS for k in t.get("hint") or []):
            verdicts["turns"] += 1
            verdicts[_done(t)] += 1

    gate = {"firings": 0, "delegated": 0, "kept": 0, "none": 0, "falsePositiveCandidates": 0}
    for t in real:
        events = [e for e in t.get("gateEvents") or [] if isinstance(e, dict)]
        sent = [e for e in events if e.get("outcome") == "sent-back"]
        if not sent:
            continue
        gate["firings"] += len(sent)
        after = [e.get("outcome") for e in events if e.get("outcome") in ("kept", "delegated")]
        outcome = after[-1] if after else "none"
        gate[outcome] += 1
        if outcome == "kept":
            gate["falsePositiveCandidates"] += 1

    edit_turns = [t for t in real if (t.get("edits") or {}).get("files")]
    unchecked = [{"sessionId": t.get("sessionId"), "turnId": t.get("turnId"), "files": t["edits"]["files"]} for t in edit_turns if not _covered(t)]

    esc = [t["escalation"] for t in real if isinstance(t.get("escalation"), dict)]
    escalations = {"count": len(esc), "followed": sum(1 for e in esc if e.get("followed"))}

    by_lane, by_kind_cost = {}, {}
    for t in win:
        u = t.get("usage")
        main = _cost(u.get("costUsd")) if isinstance(u, dict) else None
        if isinstance(u, dict):
            _add_cost(by_lane, "main session", main)
        turn_cost = main
        for d in t.get("delegates") or []:
            c = _cost(d.get("costUsd"))
            _add_cost(by_lane, str(d.get("lane") or "?"), c)
            if c is not None:
                turn_cost = (turn_cost or 0) + c
        kind = (t.get("hint") or ["none"])[0]
        _add_cost(by_kind_cost, kind, turn_cost)

    sessions = {}
    for t in real:
        sid = str(t.get("sessionId") or "")
        s = sessions.setdefault(sid, {"sessionId": sid, "cwd": t.get("cwd") or "", "turns": 0, "maxContext": 0})
        s["turns"] += 1
        li = spend._num((t.get("context") or {}).get("lastInput"))
        if li is not None:
            s["maxContext"] = max(s["maxContext"], li)
    longest = sorted(sessions.values(), key=lambda s: (-s["maxContext"], s["sessionId"]))[:TOP_SESSIONS]

    return {
        "days": days, "turns": len(real), "sessions": len(sessions),
        "byHint": by_kind, "verdicts": verdicts, "gate": gate,
        "edits": {"turns": len(edit_turns), "unchecked": len(unchecked), "uncheckedTurns": unchecked},
        "escalations": escalations,
        "costByLane": by_lane, "costByKind": by_kind_cost,
        "longestSessions": longest,
    }


def _money(b):
    text = "-" if b["costUsd"] is None else f"${b['costUsd']:,.2f}"
    return text + (f" (+{b['unpriced']} unpriced)" if b["unpriced"] else "")


def _share(n, total):
    return f"{n} ({round(100 * n / total)}%)" if total else str(n)


def text(f):
    """the figures as a short report, one section per question"""
    out = [f"spick audit: last {f['days']} day{'s' if f['days'] != 1 else ''}, {f['turns']} turn{'s' if f['turns'] != 1 else ''} in {f['sessions']} session{'s' if f['sessions'] != 1 else ''}"]
    out.append("by hint kind (what ran):")
    for kind, k in sorted(f["byHint"].items(), key=lambda kv: (-kv[1]["turns"], kv[0])):
        ran = ", ".join(f"{lane} {n}" for lane, n in sorted(k["ran"].items(), key=lambda kv: (-kv[1], kv[0])))
        out.append(f"  {kind}: {k['turns']} ({ran})")
    v = f["verdicts"]
    out.append(f"hinted verdicts: {v['turns']}; delegated {_share(v['delegated'], v['turns'])}, kept {_share(v['kept'], v['turns'])}, neither {_share(v['neither'], v['turns'])}")
    g = f["gate"]
    out.append(f"gate: {g['firings']} firing{'s' if g['firings'] != 1 else ''}; then delegated {g['delegated']}, kept {g['kept']}, nothing {g['none']}; false positive candidates (kept after sent-back): {g['falsePositiveCandidates']}")
    e = f["edits"]
    out.append(f"edits: {e['turns']} turn{'s' if e['turns'] != 1 else ''} edited source; {e['unchecked']} with no passing check after the last edit")
    x = f["escalations"]
    out.append(f"escalations: {x['count']}; a coder or deep followed {x['followed']}")
    out.append("cost by lane: " + ", ".join(f"{lane} {_money(b)}" for lane, b in sorted(f["costByLane"].items(), key=lambda kv: (-(kv[1]["costUsd"] or 0), kv[0]))))
    out.append("cost by hint kind: " + ", ".join(f"{kind} {_money(b)}" for kind, b in sorted(f["costByKind"].items(), key=lambda kv: (-(kv[1]["costUsd"] or 0), kv[0]))))
    out.append("longest sessions by context:")
    for s in f["longestSessions"]:
        out.append(f"  {s['sessionId'][:8]}  {s['maxContext'] // 1000}k  {s['turns']} turn{'s' if s['turns'] != 1 else ''}  {s['cwd']}".rstrip())
    return "\n".join(out)


def main(argv=None, home=None, now=None):
    ap = argparse.ArgumentParser(prog="audit.py", description="What the routing decisions were, from the turn records under <config>/spick/turns/.")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    if a.days < 1:
        ap.error("--days must be 1 or more")
    now = now or dt.datetime.now(dt.timezone.utc)
    turns, bad = spend.load_turns(spend.turns_dir(spend.config_dir(home)))
    if bad:
        print(f"audit.py: skipped {bad} turn record line{'s that do' if bad != 1 else ' that does'} not read", file=sys.stderr)
    f = figures(turns, a.days, now)
    if a.json:
        print(json.dumps(f, indent=2, ensure_ascii=False))
    elif f["turns"] == 0:
        print("spick audit: no records")
    else:
        print(text(f))
    return 0


if __name__ == "__main__":
    sys.exit(main())
