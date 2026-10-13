#!/usr/bin/env bash
# claude-router quota reader. Reads only files the CLIs already write locally; no network, no third-party tools.
# Usage: quota.sh [--json]
# Output (text): one line per provider:  <name>  <windows...>  age=<how old the sample is>
# Exit code is always 0; a provider that cannot be read prints "unknown".
set -u
JSON=0; [ "${1:-}" = "--json" ] && JSON=1
PY=$(command -v python3 || command -v python || true)

claude_line='claude  unknown'
codex_line='codex   unknown'
grok_line='grok    unknown'
gemini_line='gemini  unknown'
claude_json='{"status":"unknown"}'
codex_json='{"status":"unknown"}'

if [ -n "$PY" ]; then
  # Claude: ~/.claude.json -> cachedUsageUtilization
  out=$("$PY" - <<'PY' 2>/dev/null
import json, os, time
p = os.path.expanduser("~/.claude.json")
try:
    d = json.load(open(p))
    u = d["cachedUsageUtilization"]
    util = u["utilization"]; fetched = u.get("fetchedAtMs", 0) / 1000
    fh = util.get("five_hour", {}).get("utilization"); sd = util.get("seven_day", {}).get("utilization")
    age = max(0, int(time.time() - fetched))
    def fmt(s):
        return f"{s//3600}h" if s >= 3600 else f"{s//60}m"
    print(f"TEXT:claude  5h={fh}%  7d={sd}%   age={fmt(age)}")
    print("JSON:" + json.dumps({"status": "ok", "five_hour_pct": fh, "seven_day_pct": sd, "age_seconds": age}))
except Exception as e:
    pass
PY
)
  t=$(printf '%s\n' "$out" | sed -n 's/^TEXT://p'); j=$(printf '%s\n' "$out" | sed -n 's/^JSON://p')
  [ -n "$t" ] && claude_line="$t" && claude_json="$j"

  # Codex: newest session jsonl containing rate_limits
  out=$("$PY" - <<'PY' 2>/dev/null
import json, os, glob, time, re
root = os.path.expanduser(os.environ.get("CODEX_HOME", "~/.codex")) + "/sessions"
files = sorted(glob.glob(root + "/**/*.jsonl", recursive=True), key=os.path.getmtime, reverse=True)[:30]
best = None
for f in files:
    try:
        data = open(f, errors="ignore").read()
    except Exception:
        continue
    for m in reversed(list(re.finditer(r'"rate_limits":(\{.*?\})(?=,"|\}$)', data))):
        try:
            # grow the brace match until it parses
            s = m.start(1); depth = 0
            for i in range(s, len(data)):
                if data[i] == '{': depth += 1
                elif data[i] == '}':
                    depth -= 1
                    if depth == 0:
                        rl = json.loads(data[s:i+1]); break
            best = (rl, os.path.getmtime(f)); break
        except Exception:
            continue
    if best: break
if best:
    rl, mtime = best
    age = max(0, int(time.time() - mtime))
    def fmt(s): return f"{s//3600}h" if s >= 3600 else f"{s//60}m"
    parts = []; js = {"status": "ok", "age_seconds": age}
    for key in ("primary", "secondary"):
        w = rl.get(key) or {}
        if w.get("used_percent") is not None:
            mins = w.get("window_minutes") or 0
            label = "7d" if mins >= 10000 else ("5h" if mins and mins <= 400 else f"{mins}m")
            parts.append(f"{label}={w['used_percent']:.0f}%")
            js[label + "_pct"] = w["used_percent"]
    print("TEXT:codex   " + "  ".join(parts) + f"   age={fmt(age)}")
    print("JSON:" + json.dumps(js))
PY
)
  t=$(printf '%s\n' "$out" | sed -n 's/^TEXT://p'); j=$(printf '%s\n' "$out" | sed -n 's/^JSON://p')
  [ -n "$t" ] && codex_line="$t" && codex_json="$j"
fi

if [ "$JSON" = 1 ]; then
  printf '{"claude":%s,"codex":%s,"grok":{"status":"unknown"},"gemini":{"status":"unknown"}}\n' "$claude_json" "$codex_json"
else
  printf '%s\n%s\n%s\n%s\n' "$claude_line" "$codex_line" "$grok_line" "$gemini_line"
fi
exit 0
