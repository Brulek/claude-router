#!/usr/bin/env python3
"""spick spend (stdlib only): what the sessions cost, from the files the dashboard mod writes.

The mod (mod/spick-dashboard, hooks/turnlog.ts) keeps one turn record per session at
<config>/spick/turns/<sessionId>.jsonl (<config> is CLAUDE_CONFIG_DIR, else ~/.claude): one JSON line per main turn
with the main loop's usage and every delegate (subagents with usage, outside CLI calls without), and a `late: true`
line when a background agent finished after its turn's line. Each becomes a row here: the main loop's usage (a turn
with none, such as an interrupt, has no row) and one per delegate (an outside CLI call: tokens 0, costUsd null).
Sessions from before the turn record (mod 0.x) wrote <config>/spick-spend/<sessionId>.json, {"sessionId", "cwd",
"startedAt", "rows": [...]}; those are read too, also where setup moved them (<config>/spick/spick-spend/). Without
the mod there are no files: the bash hook sees no usage.

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


def config_dir(home=None, env=None):
    """CLAUDE_CONFIG_DIR, else HOME/.claude (scripts/paths.py's rule; kept here so this script stands alone). A home
    given by a test wins over the variable, so a test never reads the real config dir."""
    env = os.environ if env is None else env
    if home is None and env.get("CLAUDE_CONFIG_DIR"):
        return env["CLAUDE_CONFIG_DIR"]
    return os.path.join(home if home is not None else os.path.expanduser("~"), ".claude")


def spend_dir(home=None):
    """the legacy per-session spend files (mod 0.x)"""
    return os.path.join(config_dir(home), "spick-spend")


def legacy_dirs(config):
    return [os.path.join(config, "spick-spend"), os.path.join(config, "spick", "spick-spend")]


def turns_dir(config):
    return os.path.join(config, "spick", "turns")


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def load_turns(directory):
    """(turns, skipped): every main turn of every *.jsonl file, late lines merged into their turn by turnId and
    delegate id (the late copy wins); lines that are not JSON objects are counted. A late line whose turn is missing
    becomes a turn of its own with only that delegate."""
    turns, late, skipped = {}, [], 0
    for path in sorted(glob.glob(os.path.join(directory, "*.jsonl"))):
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
        except OSError:
            skipped += 1
            continue
        for raw in text.splitlines():
            if not raw.strip():
                continue
            try:
                line = json.loads(raw)
            except ValueError:
                skipped += 1
                continue
            if not isinstance(line, dict) or not isinstance(line.get("turnId"), str):
                skipped += 1
                continue
            key = (str(line.get("sessionId") or os.path.basename(path).split(".")[0]), line["turnId"])
            if line.get("late"):
                late.append((key, line))
            else:
                line["delegates"] = [d for d in line.get("delegates") or [] if isinstance(d, dict)]
                turns[key] = line
    for key, line in late:
        d = line.get("delegate")
        if not isinstance(d, dict):
            continue
        t = turns.get(key)
        if t is None:
            t = turns[key] = {"sessionId": key[0], "turnId": key[1], "at": line.get("at"), "delegates": [], "lateOnly": True}
        t["delegates"] = [x for x in t["delegates"] if x.get("id") != d.get("id")] + [d]
    return list(turns.values()), skipped


def rows_of_turns(turns):
    """one row for the main loop's usage of each turn, one per delegate"""
    rows = []
    for t in turns:
        at = parse_at(t.get("at"))
        if at is None:
            continue
        base = {"at": at, "session": str(t.get("sessionId") or ""), "cwd": str(t.get("cwd") or "")}
        u = t.get("usage")
        if isinstance(u, dict):
            rows.append({**base, "lane": "main session", **_tokens(u), "costUsd": _num(u.get("costUsd"))})
        for d in t.get("delegates") or []:
            du = d.get("usage") if isinstance(d.get("usage"), dict) else {}
            rows.append({**base, "lane": str(d.get("lane") or "?"), **_tokens(du), "costUsd": _num(d.get("costUsd"))})
    return rows


def _tokens(u):
    pairs = zip(FIELDS, ("input", "output", "cacheRead", "cacheWrite"))
    return {k: _num(u.get(src)) or 0 for k, src in pairs}


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

    def fmt(r):
        return "  ".join(c.ljust(widths[i]) if i == 0 else c.rjust(widths[i]) for i, c in enumerate(r)).rstrip()
    lines = [f"spick spend: last {days} day{'s' if days != 1 else ''}, by {by} ({sessions} session{'s' if sessions != 1 else ''}, {total['rows']:,} row{'s' if total['rows'] != 1 else ''})",
             fmt(head)] + [fmt(r) for r in body]
    if total["unpriced"]:
        lines.append(f"cost leaves out {total['unpriced']:,} unpriced row{'s' if total['unpriced'] != 1 else ''} (outside CLI calls report no usage; a model with no price)")
    return "\n".join(lines)


def main(argv=None, home=None, now=None):
    ap = argparse.ArgumentParser(prog="spend.py", description="What the sessions cost, from the turn records under <config>/spick/turns/.")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--by", choices=("lane", "day", "session"), default="lane")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    if a.days < 1:
        ap.error("--days must be 1 or more")
    now = now or dt.datetime.now(dt.timezone.utc)
    config = config_dir(home)
    rows, skipped = [], 0
    for d in legacy_dirs(config):
        r, n = load(d)
        rows += r
        skipped += n
    if skipped:
        print(f"spend.py: skipped {skipped} file{'s' if skipped != 1 else ''} that are not spend records", file=sys.stderr)
    turns, bad_lines = load_turns(turns_dir(config))
    if bad_lines:
        print(f"spend.py: skipped {bad_lines} turn record line{'s that do' if bad_lines != 1 else ' that does'} not read", file=sys.stderr)
    rows += rows_of_turns(turns)
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
