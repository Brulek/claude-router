#!/usr/bin/env python3
"""spick spend (stdlib only): what the sessions cost, from the files the dashboard mod writes.

The mod (mod/spick-dashboard, hooks/spend.ts) keeps one file per session at
~/.claude/spick-spend/<sessionId>.json: {"sessionId", "cwd", "startedAt", "rows": [...]}, one row per
turn that carried usage (the main session's and each subagent's) and one per outside CLI call (tokens 0,
costUsd null: a CLI reports no usage). Without the mod there are no files: the bash hook sees no usage.

Usage:
  spend.py [--days N] [--by lane|day|session] [--json]
    --days N   rows from the last N days (default 7)
    --by       group by lane (default), by day (UTC, from the row's time) or by session
    --json     print the groups as JSON instead of a table
Prints "spick spend: no records" when no row falls in the window. Exit 0; 2 on a bad argument.
A file that cannot be read as a record is skipped and counted on stderr.
"""
import argparse
import datetime as dt
import glob
import json
import os
import sys

FIELDS = ("inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens")


def spend_dir(home=None):
    return os.path.join(home if home is not None else os.path.expanduser("~"), ".claude", "spick-spend")


def parse_at(text):
    """a row's ISO time as an aware datetime, or None"""
    if not isinstance(text, str):
        return None
    try:
        t = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)


def load(directory):
    """(rows, skipped): every row of every file, each with its session's id and cwd; files that do not read are counted"""
    rows, skipped = [], 0
    for path in sorted(glob.glob(os.path.join(directory, "*.json"))):
        try:
            with open(path, encoding="utf-8") as f:
                doc = json.load(f)
            if not isinstance(doc, dict) or not isinstance(doc.get("rows"), list):
                raise ValueError("not a spend record")
        except (OSError, ValueError):
            skipped += 1
            continue
        sid = str(doc.get("sessionId") or os.path.splitext(os.path.basename(path))[0])
        cwd = str(doc.get("cwd") or "")
        for r in doc["rows"]:
            at = parse_at(r.get("at")) if isinstance(r, dict) else None
            if at is None:
                continue
            row = {"at": at, "session": sid, "cwd": cwd, "lane": str(r.get("lane") or "?")}
            for k in FIELDS:
                v = r.get(k)
                row[k] = v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0
            c = r.get("costUsd")
            row["costUsd"] = c if isinstance(c, (int, float)) and not isinstance(c, bool) else None
            rows.append(row)
    return rows, skipped


def within(rows, days, now):
    since = now - dt.timedelta(days=days)
    return [r for r in rows if r["at"] >= since]


def _empty(key):
    g = {"key": key, "rows": 0, **{k: 0 for k in FIELDS}, "costUsd": None, "unpriced": 0}
    return g


def _add(g, r):
    g["rows"] += 1
    for k in FIELDS:
        g[k] += r[k]
    if r["costUsd"] is None:
        g["unpriced"] += 1
    else:
        g["costUsd"] = (g["costUsd"] or 0) + r["costUsd"]


def summarize(rows, by):
    """(groups, total): one group per lane, day or session, most expensive first (then most rows, then name)"""
    groups = {}
    total = _empty("total")
    for r in rows:
        key = r["lane"] if by == "lane" else r["at"].astimezone(dt.timezone.utc).date().isoformat() if by == "day" else r["session"]
        g = groups.get(key)
        if g is None:
            g = groups[key] = _empty(key)
            if by == "session":
                g["cwd"] = r["cwd"]
        _add(g, r)
        _add(total, r)
    out = list(groups.values())
    if by == "day":
        out.sort(key=lambda g: g["key"])
    else:
        out.sort(key=lambda g: (-(g["costUsd"] or 0), -g["rows"], g["key"]))
    return out, total


def _money(v):
    return "-" if v is None else f"${v:,.2f}"


def table(groups, total, by, days, sessions):
    """the report as text: a head line, one row per group, the total, and a note on unpriced rows"""
    label = {"lane": "lane", "day": "day (UTC)", "session": "session"}[by]
    head = [label, "rows", "input", "output", "cache read", "cache write", "cost"]
    body = []
    for g in groups + [total]:
        name = g["key"]
        if by == "session" and g is not total:
            name = f"{name[:8]}  {g.get('cwd') or ''}".rstrip()
        body.append([name, f"{g['rows']:,}"] + [f"{g[k]:,}" for k in FIELDS] + [_money(g["costUsd"])])
    widths = [max(len(r[i]) for r in [head] + body) for i in range(len(head))]
    fmt = lambda r: "  ".join(c.ljust(widths[i]) if i == 0 else c.rjust(widths[i]) for i, c in enumerate(r)).rstrip()
    lines = [f"spick spend: last {days} day{'s' if days != 1 else ''}, by {by} ({sessions} session{'s' if sessions != 1 else ''}, {total['rows']:,} row{'s' if total['rows'] != 1 else ''})",
             fmt(head)] + [fmt(r) for r in body]
    if total["unpriced"]:
        lines.append(f"cost leaves out {total['unpriced']:,} unpriced row{'s' if total['unpriced'] != 1 else ''} (outside CLI calls report no usage; a model with no price)")
    return "\n".join(lines)


def main(argv=None, home=None, now=None):
    ap = argparse.ArgumentParser(prog="spend.py", description="What the sessions cost, from ~/.claude/spick-spend/.")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--by", choices=("lane", "day", "session"), default="lane")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    if a.days < 1:
        ap.error("--days must be 1 or more")
    now = now or dt.datetime.now(dt.timezone.utc)
    rows, skipped = load(spend_dir(home))
    if skipped:
        print(f"spend.py: skipped {skipped} file{'s' if skipped != 1 else ''} that are not spend records", file=sys.stderr)
    rows = within(rows, a.days, now)
    groups, total = summarize(rows, a.by)
    sessions = len({r["session"] for r in rows})
    if a.json:
        print(json.dumps({"days": a.days, "by": a.by, "sessions": sessions, "groups": groups, "total": total}, indent=2, ensure_ascii=False))
    elif not rows:
        print("spick spend: no records")
    else:
        print(table(groups, total, a.by, a.days, sessions))
    return 0


if __name__ == "__main__":
    sys.exit(main())
