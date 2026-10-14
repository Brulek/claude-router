#!/usr/bin/env bash
# spick setup: detect CLIs, install agents + CLAUDE.md block, write config.
# Usage:
#   setup.sh --check
#   setup.sh --install [--lanes gemini,grok,codex] [--model haiku|sonnet|opus] [--effort low|medium|high] [--force]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$HERE")"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CONFIG="$CLAUDE_DIR/spick.json"
PY=$(command -v python3 || command -v python || true)

have() { command -v "$1" >/dev/null 2>&1; }

# Python helpers prepended to every heredoc run through py().
# atomic_write: write to a tmp file next to the real file, then os.replace it. A symlinked
# CLAUDE.md or settings.json stays a link (the link's target is replaced) and the file mode is kept.
# note: fill one field of this run's backup manifest.
PYLIB='
import json, os, shutil
def atomic_write(path, text):
    real = os.path.realpath(path)
    tmp = real + ".spick-tmp"
    try:
        with open(tmp, "w") as f:
            f.write(text)
        if os.path.exists(real):
            shutil.copymode(real, tmp)
        os.replace(tmp, real)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
def note(man, key, value):
    if not man or not os.path.exists(man):
        return
    with open(man) as f:
        m = json.load(f)
    m[key] = value
    atomic_write(man, json.dumps(m, indent=2, ensure_ascii=False) + "\n")
'
py() { { printf '%s\n' "$PYLIB"; cat; } | "$PY" - "$@"; }

# backup <action>: copy CLAUDE.md, settings.json and spick.json (those that exist) into
# $CLAUDE_DIR/spick-backup/<YYYYmmdd-HHMMSS>/ and start manifest.json there. Sets BACKUP_DIR and
# MANIFEST. Runs before anything is written; exits if the copy fails. Old backups are never pruned.
BACKUP_DIR="" MANIFEST=""
backup() {
  local base="$CLAUDE_DIR/spick-backup" stamp n=1 f
  stamp=$(date +%Y%m%d-%H%M%S)
  BACKUP_DIR="$base/$stamp"
  while [ -e "$BACKUP_DIR" ]; do n=$((n+1)); BACKUP_DIR="$base/$stamp-$n"; done
  mkdir -p "$BACKUP_DIR" || { echo "  backup failed: cannot create $BACKUP_DIR; nothing written" >&2; exit 1; }
  for f in CLAUDE.md settings.json spick.json; do
    if [ -f "$CLAUDE_DIR/$f" ]; then
      cp -p "$CLAUDE_DIR/$f" "$BACKUP_DIR/$f" || { echo "  backup failed: $CLAUDE_DIR/$f; nothing written" >&2; exit 1; }
    fi
  done
  if [ -n "$PY" ]; then
    MANIFEST="$BACKUP_DIR/manifest.json"
    py "$MANIFEST" "$1" "$CLAUDE_DIR/settings.json" <<'PY'
import sys, datetime
man, action, settings = sys.argv[1:4]
try:
    s = json.load(open(settings))
except Exception:
    s = {}
if not isinstance(s, dict): s = {}
m = {
  "at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
  "action": action,
  "agents_written": [],
  "claude_md_block": False,
  "hook_added": False,
  "settings": {k: {"before": s.get(k), "after": None} for k in ("model", "effortLevel")},
}
atomic_write(man, json.dumps(m, indent=2, ensure_ascii=False) + "\n")
PY
    echo "  backup $BACKUP_DIR"
  else
    echo "  backup $BACKUP_DIR (no manifest: python not found)"
  fi
}
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
  backup install
  mkdir -p "$CLAUDE_DIR/agents"

  echo "== agents =="
  local written=()
  for f in "$SKILL_DIR"/assets/agents/*.md; do
    dst="$CLAUDE_DIR/agents/$(basename "$f")"
    if [ -e "$dst" ] && [ "$force" = 0 ]; then echo "  keep   $dst (exists; --force to overwrite)"; else cp "$f" "$dst"; echo "  wrote  $dst"; written+=("$dst"); fi
  done
  if [ -n "$PY" ]; then
    py "$MANIFEST" ${written[@]+"${written[@]}"} <<'PY'
import sys
note(sys.argv[1], "agents_written", sys.argv[2:])
PY
  fi

  echo "== CLAUDE.md block =="
  local md="$CLAUDE_DIR/CLAUDE.md" snippet="$SKILL_DIR/assets/claude-md-snippet.md"
  touch "$md"
  if [ -n "$PY" ]; then
    py "$md" "$snippet" "$MANIFEST" <<'PY'
import sys, re
md, snippet, man = sys.argv[1:4]
start, end = "<!-- spick:start -->", "<!-- spick:end -->"
block = start + "\n" + open(snippet).read().rstrip() + "\n" + end
cur = open(md).read()
if start in cur and end in cur:
    cur = re.sub(re.escape(start) + r".*?" + re.escape(end), lambda m: block, cur, flags=re.S)
    action = "replaced"
else:
    cur = cur.rstrip() + ("\n\n" if cur.strip() else "") + block + "\n"
    action = "appended"
atomic_write(md, cur)
note(man, "claude_md_block", True)
print(f"  {action} block in {md}")
PY
  else
    echo "  python not found; append $snippet to $md by hand"
  fi

  echo "== config =="
  if [ -n "$PY" ]; then
    py "$CONFIG" "$lanes" "$model" "$effort" <<'PY'
import sys, datetime
cfg, lanes, model, effort = sys.argv[1:5]
old = {}
if os.path.exists(cfg):
    try:
        old = json.load(open(cfg))
        if not isinstance(old, dict): old = {}
    except Exception:
        old = {}
    shutil.copy2(cfg, cfg + ".bak")
    print(f"  backup {cfg}.bak")
owned = {
  "version": 1,
  "installed_at": datetime.date.today().isoformat(),
  "lanes": {k: (k in lanes.split(",")) for k in ("gemini", "grok", "codex")},
  "main_session": {"model": model or "haiku", "effort": effort or "medium"},
  "review_triggers": {"files": 3, "lines": 150},
}
# keep every key setup does not own (subscriptions etc.); drop retired quota threshold block
d = {k: v for k, v in old.items() if k not in owned and k != "quota"}
d.update(owned)
atomic_write(cfg, json.dumps(d, indent=2, ensure_ascii=False))
print(f"  wrote  {cfg}")
PY
  fi

  echo "== triage hook (UserPromptSubmit) =="
  if [ -n "$PY" ]; then
    py "$CLAUDE_DIR/settings.json" "$MANIFEST" <<'PY2'
import sys
p, man = sys.argv[1:3]
d = json.load(open(p)) if os.path.exists(p) else {}
cmd = 'bash "$HOME/.claude/skills/spick/scripts/triage-hook.sh"'
hooks = d.setdefault("hooks", {}); lst = hooks.setdefault("UserPromptSubmit", [])
present = any("spick/scripts/triage-hook.sh" in h.get("command", "") for e in lst for h in e.get("hooks", []))
if not present:
    lst.append({"hooks": [{"type": "command", "command": cmd}]})
    atomic_write(p, json.dumps(d, indent=2, ensure_ascii=False) + "\n")
    note(man, "hook_added", True)
    print(f"  added  UserPromptSubmit hook -> {p}")
else:
    print(f"  keep   hook already present in {p}")
PY2
  fi

  if [ -n "$model$effort" ] && [ -n "$PY" ]; then
    echo "== settings.json =="
    py "$CLAUDE_DIR/settings.json" "$model" "$effort" <<'PY'
import sys
p, model, effort = sys.argv[1:4]
d = json.load(open(p)) if os.path.exists(p) else {}
if model: d["model"] = model
if effort: d["effortLevel"] = effort
atomic_write(p, json.dumps(d, indent=2, ensure_ascii=False) + "\n")
print(f"  model={d.get('model')} effortLevel={d.get('effortLevel')} -> {p}")
PY
  fi
  if [ -n "$PY" ]; then
    py "$MANIFEST" "$CLAUDE_DIR/settings.json" <<'PY'
import sys
man, p = sys.argv[1:3]
try:
    d = json.load(open(p))
except Exception:
    d = {}
if not isinstance(d, dict): d = {}
if man and os.path.exists(man):
    with open(man) as f:
        s = json.load(f)["settings"]
    for k in ("model", "effortLevel"):
        s[k]["after"] = d.get(k)
    note(man, "settings", s)
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
