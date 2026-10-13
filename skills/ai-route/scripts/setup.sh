#!/usr/bin/env bash
# ai-route setup: detect CLIs, install agents + CLAUDE.md block, write config.
# Usage:
#   setup.sh --check
#   setup.sh --install [--lanes gemini,grok,codex] [--model haiku|sonnet|opus] [--effort low|medium|high] [--force]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$HERE")"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CONFIG="$CLAUDE_DIR/ai-route.json"
PY=$(command -v python3 || command -v python || true)

have() { command -v "$1" >/dev/null 2>&1; }
ver() { "$@" 2>/dev/null | head -1 | tr -d '\r'; }

check() {
  printf '%-8s %-10s %-10s %s\n' tool installed logged_in version
  # claude
  if have claude; then printf '%-8s %-10s %-10s %s\n' claude yes '?' "$(ver claude --version)"; else printf '%-8s %-10s %-10s %s\n' claude no - -; fi
  # codex
  if have codex; then
    li=no; codex login status >/dev/null 2>&1 && li=yes
    printf '%-8s %-10s %-10s %s\n' codex yes "$li" "$(ver codex --version)"
  else printf '%-8s %-10s %-10s %s\n' codex no - -; fi
  # grok
  if have grok; then
    li=yes; grok models 2>&1 | grep -qi "not authenticated" && li=no
    printf '%-8s %-10s %-10s %s\n' grok yes "$li" "$(ver grok --version)"
  else printf '%-8s %-10s %-10s %s\n' grok no - -; fi
  # agy
  if have agy; then
    li=no; agy models 2>/dev/null | grep -q "gemini" && li=yes
    printf '%-8s %-10s %-10s %s\n' agy yes "$li" "$(ver agy --version || echo antigravity)"
  else printf '%-8s %-10s %-10s %s\n' agy no - -; fi
  for t in node python3; do
    if have "$t"; then printf '%-8s %-10s %-10s %s\n' "$t" yes - "$(ver "$t" --version)"; else printf '%-8s %-10s %-10s %s\n' "$t" no - -; fi
  done
  echo
  echo "plugins:"
  ls "$CLAUDE_DIR/plugins/cache" 2>/dev/null | grep -E "codex-image|grok" | sed 's/^/  /' || echo "  (none relevant)"
  echo
  [ -f "$CONFIG" ] && echo "config: $CONFIG (present)" || echo "config: $CONFIG (missing - run --install)"
}

install() {
  local lanes="" model="" effort="" force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --lanes) lanes="$2"; shift 2;;
      --model) model="$2"; shift 2;;
      --effort) effort="$2"; shift 2;;
      --force) force=1; shift;;
      *) shift;;
    esac
  done
  if [ -z "$lanes" ]; then
    l=(); have agy && l+=(gemini); have grok && l+=(grok); have codex && l+=(codex)
    lanes=$(IFS=,; echo "${l[*]:-}")
  fi
  mkdir -p "$CLAUDE_DIR/agents"

  echo "== agents =="
  for f in "$SKILL_DIR"/assets/agents/*.md; do
    dst="$CLAUDE_DIR/agents/$(basename "$f")"
    if [ -e "$dst" ] && [ "$force" = 0 ]; then echo "  keep   $dst (exists; --force to overwrite)"; else cp "$f" "$dst"; echo "  wrote  $dst"; fi
  done

  echo "== CLAUDE.md block =="
  local md="$CLAUDE_DIR/CLAUDE.md" snippet="$SKILL_DIR/assets/claude-md-snippet.md"
  touch "$md"
  if [ -n "$PY" ]; then
    "$PY" - "$md" "$snippet" <<'PY'
import sys, re
md, snippet = sys.argv[1], sys.argv[2]
start, end = "<!-- ai-route:start -->", "<!-- ai-route:end -->"
block = start + "\n" + open(snippet).read().rstrip() + "\n" + end
cur = open(md).read()
if start in cur and end in cur:
    cur = re.sub(re.escape(start) + r".*?" + re.escape(end), lambda m: block, cur, flags=re.S)
    action = "replaced"
else:
    cur = cur.rstrip() + ("\n\n" if cur.strip() else "") + block + "\n"
    action = "appended"
open(md, "w").write(cur)
print(f"  {action} block in {md}")
PY
  else
    echo "  python not found; append $snippet to $md by hand"
  fi

  echo "== config =="
  if [ -n "$PY" ]; then
    "$PY" - "$CONFIG" "$lanes" "$model" "$effort" <<'PY'
import sys, json, os, datetime
cfg, lanes, model, effort = sys.argv[1:5]
d = {
  "version": 1,
  "installed_at": datetime.date.today().isoformat(),
  "lanes": {k: (k in lanes.split(",")) for k in ("gemini", "grok", "codex")},
  "main_session": {"model": model or "haiku", "effort": effort or "medium"},
  "quota": {"tight_percent": 80, "prefer_weekly_window": True},
  "review_triggers": {"files": 3, "lines": 150},
}
json.dump(d, open(cfg, "w"), indent=2, ensure_ascii=False)
print(f"  wrote  {cfg}")
PY
  fi

  if [ -n "$model$effort" ] && [ -n "$PY" ]; then
    echo "== settings.json =="
    "$PY" - "$CLAUDE_DIR/settings.json" "$model" "$effort" <<'PY'
import sys, json, os
p, model, effort = sys.argv[1:4]
d = json.load(open(p)) if os.path.exists(p) else {}
if model: d["model"] = model
if effort: d["effortLevel"] = effort
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False); open(p, "a").write("\n")
print(f"  model={d.get('model')} effortLevel={d.get('effortLevel')} -> {p}")
PY
  fi
  echo
  echo "done. New sessions pick this up; the current one does not."
  echo "Desktop app users: pick the main model once in the composer's model menu (the app remembers its own choice)."
}

case "${1:-}" in
  --check) check;;
  --install) shift; install "$@";;
  *) echo "usage: setup.sh --check | --install [--lanes a,b] [--model m] [--effort e] [--force]"; exit 2;;
esac
