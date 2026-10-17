#!/usr/bin/env bash
# spick setup: detect CLIs, install agents + CLAUDE.md block, write config.
# Usage:
#   setup.sh --check
#   setup.sh --install [--lanes gemini,grok,codex] [--model haiku|sonnet|opus] [--effort low|medium|high] [--force]
#   setup.sh --uninstall [--purge] [--force]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$HERE")"
# paths.py's rule, inline: the config dir is CLAUDE_CONFIG_DIR (unset or empty: ~/.claude), state lives in <config>/spick
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CONFIG="$CLAUDE_DIR/spick.json"
STATE_DIR="$CLAUDE_DIR/spick"
VERSION=$(head -1 "$SKILL_DIR/assets/VERSION" 2>/dev/null | tr -d '[:space:]')
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
# $STATE_DIR/backup/<YYYYmmdd-HHMMSS>/ and start manifest.json there. Sets BACKUP_DIR and
# MANIFEST. Runs before anything is written; exits if the copy fails. Old backups are never pruned.
BACKUP_DIR="" MANIFEST=""
backup() {
  local base="$STATE_DIR/backup" stamp n=1 f
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

# migrate: move the round-1 state files (spick-quota.json, spick-spend/, spick-gate.jsonl, spick-backup/) into
# $STATE_DIR and drop the old single mod marker. A no-op once they are gone, so every run may call it.
migrate() {
  [ -n "$PY" ] || return 0
  local out
  out=$("$PY" "$HERE/paths.py" --migrate)
  local rc=$?
  if [ -n "$out" ]; then echo "== state files (round 1 -> $STATE_DIR) =="; echo "$out"; fi
  return $rc
}

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
  local found=0 p
  for p in "$CLAUDE_DIR"/plugins/cache/*codex-image* "$CLAUDE_DIR"/plugins/cache/*grok*; do
    if [ -e "$p" ]; then echo "  $(basename "$p")"; found=1; fi
  done
  [ "$found" = 1 ] || echo "  (none relevant)"
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
  migrate
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
    py "$CONFIG" "$lanes" "$model" "$effort" "$VERSION" <<'PY'
import sys, datetime
cfg, lanes, model, effort, version = sys.argv[1:6]
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
  "installed_version": version or None,
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
    # the hook next to this script, by absolute path: a skill installed outside ~/.claude (or a CLAUDE_CONFIG_DIR) still runs
    py "$CLAUDE_DIR/settings.json" "$MANIFEST" "$HERE/triage-hook.sh" <<'PY2'
import sys
p, man, hook = sys.argv[1:4]
d = json.load(open(p)) if os.path.exists(p) else {}
cmd = 'bash "%s"' % hook
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

# uninstall: remove only what --install wrote; anything changed since is kept. No snapshot is
# restored (backup/ is for rolling back by hand; only --purge removes it, with the rest of the state dir).
uninstall() {
  local purge=0 force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --purge) purge=1; shift;;
      --force) force=1; shift;;
      *) shift;;
    esac
  done
  migrate
  backup uninstall

  echo "== CLAUDE.md block =="
  local md="$CLAUDE_DIR/CLAUDE.md"
  if [ ! -f "$md" ]; then
    echo "  none   $md does not exist"
  elif [ -n "$PY" ]; then
    py "$md" <<'PY'
import sys, re
md = sys.argv[1]
start, end = "<!-- spick:start -->", "<!-- spick:end -->"
cur = open(md).read()
m = re.search(re.escape(start) + r".*?" + re.escape(end), cur, flags=re.S)
if not m:
    print(f"  none   no spick block in {md}")
    sys.exit(0)
pre = cur[:m.start()].rstrip("\n")
post = cur[m.end():]
if post.startswith("\n"):
    post = post[1:]
if pre and post.strip():
    out = pre + "\n" + post
elif pre:
    out = pre + "\n"
else:
    out = post.lstrip("\n") if post.strip() else ""
if out:
    atomic_write(md, out)
    print(f"  removed block from {md}")
elif os.path.islink(md):
    atomic_write(md, "")
    print(f"  removed block from {md} (now empty; the symlink and its target are kept)")
else:
    os.unlink(md)
    print(f"  removed {md} (only the block was in it)")
PY
  else
    echo "  python not found; delete the spick:start..spick:end block from $md by hand"
  fi

  echo "== settings.json =="
  if [ ! -f "$CLAUDE_DIR/settings.json" ]; then
    echo "  none   $CLAUDE_DIR/settings.json does not exist"
  elif [ -n "$PY" ]; then
    py "$CLAUDE_DIR/settings.json" "$STATE_DIR/backup" "$BACKUP_DIR" "$MANIFEST" <<'PY'
import sys, re
p, base, this_run, man = sys.argv[1:5]
try:
    d = json.load(open(p))
    if not isinstance(d, dict): raise ValueError("not an object")
except Exception as e:
    print(f"  skip   {p} is not valid JSON ({e}); fix it by hand")
    sys.exit(0)
changed = False

# 1. the triage hook
hooks = d.get("hooks")
lst = hooks.get("UserPromptSubmit") if isinstance(hooks, dict) else None
removed = 0
if isinstance(lst, list):
    keep = []
    for e in lst:
        hs = e.get("hooks") if isinstance(e, dict) else None
        if isinstance(hs, list):
            rest = [h for h in hs if not (isinstance(h, dict) and "spick/scripts/triage-hook.sh" in str(h.get("command", "")))]
            removed += len(hs) - len(rest)
            if not rest and hs:
                continue
            if len(rest) != len(hs):
                e = dict(e, hooks=rest)
        keep.append(e)
    if removed:
        changed = True
        if keep:
            hooks["UserPromptSubmit"] = keep
        else:
            del hooks["UserPromptSubmit"]
            if not hooks:
                del d["hooks"]
print(f"  removed UserPromptSubmit hook" if removed else "  none   no spick hook")

# 2. model / effortLevel: undo only what the installs since the last uninstall set and nobody changed.
# Walk those install manifests newest first; while an install found the value the previous one left,
# keep going back, so a re-install does not hide the value from before spick.
def key(name):
    m = re.match(r"^(\d{8}-\d{6})(?:-(\d+))?$", name)
    return (m.group(1), int(m.group(2) or 1)) if m else None
runs = []
if os.path.isdir(base):
    for name in os.listdir(base):
        k = key(name)
        path = os.path.join(base, name)
        if k is None or os.path.realpath(path) == os.path.realpath(this_run):
            continue
        try:
            mf = json.load(open(os.path.join(path, "manifest.json")))
        except Exception:
            continue
        if isinstance(mf, dict):
            runs.append((k, mf))
runs.sort(key=lambda r: r[0])
installs = []
for _, mf in runs:
    if mf.get("action") == "uninstall":
        installs = []
    elif mf.get("action") == "install":
        installs.append(mf)
for k in ("model", "effortLevel"):
    seq = [mf.get("settings", {}).get(k) for mf in installs]
    seq = [s for s in seq if isinstance(s, dict) and "before" in s and "after" in s]
    cur = d.get(k)
    if not seq:
        print(f"  keep   {k}={cur} (no install record since the last uninstall)")
        continue
    after = seq[-1]["after"]
    before = seq[-1]["before"]
    for prev in reversed(seq[:-1]):
        if prev["after"] != before:
            break
        before = prev["before"]
    if cur != after:
        print(f"  keep   {k}={cur} (changed since install)")
    elif before == after:
        print(f"  keep   {k}={cur} (install did not change it)")
    else:
        if before is None:
            d.pop(k, None)
        else:
            d[k] = before
        changed = True
        print(f"  restored {k}={before}")
if changed:
    atomic_write(p, json.dumps(d, indent=2, ensure_ascii=False) + "\n")
if man and os.path.exists(man):
    with open(man) as f:
        s = json.load(f)["settings"]
    for k in ("model", "effortLevel"):
        s[k]["after"] = d.get(k)
    note(man, "settings", s)
PY
  else
    echo "  python not found; remove the triage-hook.sh entry from $CLAUDE_DIR/settings.json by hand"
  fi

  echo "== agents =="
  local f dst
  for f in "$SKILL_DIR"/assets/agents/*.md; do
    dst="$CLAUDE_DIR/agents/$(basename "$f")"
    if [ ! -e "$dst" ] && [ ! -L "$dst" ]; then
      echo "  none   $dst"
    elif cmp -s "$f" "$dst"; then
      rm -f "$dst" && echo "  removed $dst"
    elif [ "$force" = 1 ]; then
      rm -f "$dst" && echo "  removed $dst (changed since install; --force)"
    else
      echo "  keep   $dst (changed since install; --force to remove)"
    fi
  done

  echo "== state files =="
  local p
  # the mod's session markers and the quota cache are rebuilt on their own; records and backups are kept
  for p in "$STATE_DIR/mod-active" "$STATE_DIR/quota.json" "$STATE_DIR/quota.lock"; do
    if [ -e "$p" ]; then rm -rf "$p" && echo "  removed $p"; fi
  done
  if [ "$purge" = 1 ]; then
    for p in "$CONFIG" "$STATE_DIR"; do
      if [ -e "$p" ]; then rm -rf "$p" && echo "  removed $p (--purge)"; fi
    done
  else
    [ -e "$CONFIG" ] && echo "  keep   $CONFIG (--purge to remove)"
    [ -e "$STATE_DIR" ] && echo "  keep   $STATE_DIR (turn records, backups; --purge to remove)"
  fi
  echo
  echo "done. Two things this script does not do:"
  echo "  claude plugin uninstall spick-dashboard"
  echo "  rm -rf ~/.claude/skills/spick"
}

case "${1:-}" in
  --check) check;;
  --install) shift; install "$@";;
  --uninstall) shift; uninstall "$@";;
  *) echo "usage: setup.sh --check | --install [--lanes a,b] [--model m] [--effort e] [--force] | --uninstall [--purge] [--force]"; exit 2;;
esac
