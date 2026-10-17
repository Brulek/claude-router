#!/usr/bin/env bash
# spick: UserPromptSubmit hook. Prints a 3-question triage checklist that Claude Code adds to the prompt context.
# Small models follow a checklist they see every turn far better than a rule they read once at session start.
# Line 2 routes by the shape of the deliverable, the main session last: a small model stops at the first bucket that
# fits, so the cheap bucket must come last. After it, triage_hint.py reads the prompt (the hook's stdin JSON) and
# adds one Hint line naming the keywords it found and the default route they imply.
# When the spick-dashboard mod is loaded it injects the checklist itself (built from its switches) and keeps a marker
# <state>/mod-active/<session_id> fresh; this hook reads session_id from its stdin JSON and stays silent only while that
# session's marker is younger than 24 hours, so a second session without the mod still gets the checklist. Markers
# older than 24 hours (sessions long gone, mod uninstalled) are deleted here. `find -mmin` works on macOS and Linux.
# <state> is paths.py's rule, inline so the checklist prints without python: $CLAUDE_CONFIG_DIR/spick, default ~/.claude/spick.
# The quota cache (<state>/quota.json) is refreshed from here in the background, never awaited;
# the last line printed below is a one-line summary of that cache (plain facts, no rules).
# The mod builds the same text from checklist.ts; test_triage_hint.py runs this hook and fails when the two drift.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
py=$(command -v python3 || command -v python || true)
claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
state="$claude_dir/spick"
# the prompt arrives as JSON on stdin; a run from a terminal has none
input=""
[ -t 0 ] || input=$(cat 2>/dev/null || true)
# session_id without python (a UUID in practice); made a safe file name the way paths.ts safeName does
sid=""
re='"session_id"[[:space:]]*:[[:space:]]*"([^"]*)"'
[[ $input =~ $re ]] && sid="${BASH_REMATCH[1]}"
sid="${sid//[^A-Za-z0-9._-]/_}"
if [[ $sid == .* ]]; then sid="_${sid#"${sid%%[!.]*}"}"; fi
[ -d "$state/mod-active" ] && find "$state/mod-active" -type f -mmin +1440 -delete 2>/dev/null
if [ -n "$sid" ] && [ -f "$state/mod-active/$sid" ] && [ -n "$(find "$state/mod-active/$sid" -mmin -1440 2>/dev/null)" ]; then
  [ -n "$py" ] && "$py" "$here/quota.py" --touch >/dev/null 2>&1   # the mod prints the checklist; keep its cache warm
  exit 0
fi
# one line when the skill on disk is newer (or older) than what setup installed: agents and the CLAUDE.md block are stale
cfg="$claude_dir/spick.json"
skill_version=$(head -1 "$here/../assets/VERSION" 2>/dev/null | tr -d '[:space:]')
if [ -f "$cfg" ] && [ -n "$skill_version" ]; then
  installed=$(sed -n 's/.*"installed_version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$cfg" 2>/dev/null | head -1)
  [ "$installed" = "$skill_version" ] || echo "spick: skill $skill_version installed ${installed:-none}, run spick setup"
fi
# The checklist is assets/checklist.txt, rendered from assets/rules.json by render_rules.py (the mod's checklist.ts
# carries the same lines). A line tagged {builtin}, {registry} or {none} prints only in that lane variant; {hint} is
# where the Hint line goes. The variant is lanes.py's (--variant, the rule quota.py and the mod share): builtin when
# spick.json has no lane_registry and no built-in switched off; registry when some lanes are enabled; none when
# nothing is (then no outside CLI may be called). A built-in switched off must not get the builtin wording, which
# names all three.
variant=builtin
lanes_line=""
if [ -f "$cfg" ]; then
  out=""
  [ -n "$py" ] && out=$("$py" "$here/lanes.py" --variant 2>/dev/null)
  { IFS= read -r v; IFS= read -r lanes_line; } <<< "$out"
  case "$v" in
    builtin|registry|none) variant=$v ;;
    # no python, or lanes.py failed: a declared registry still gets the registry wording, without its Lanes line
    *) lanes_line=""; grep -q '"lane_registry"' "$cfg" 2>/dev/null && variant=registry ;;
  esac
fi
# the Hint line: keywords found in the prompt and the default route they imply; nothing when none matched
hint=""
[ -n "$py" ] && [ -n "$input" ] && hint=$(printf '%s' "$input" | "$py" "$here/triage_hint.py" --stdin-json 2>/dev/null)
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    "{hint}") [ -n "$hint" ] && printf '%s\n' "$hint" ;;
    "{"*"}"*)
      tags="${line%%\}*}"; tags="${tags#\{}"
      case ",$tags," in *",$variant,"*) printf '%s\n' "${line#*\}}" ;; esac ;;
    *) printf '%s\n' "$line" ;;
  esac
done < "$here/../assets/checklist.txt"
[ -n "$lanes_line" ] && printf '%s\n' "$lanes_line"
[ -n "$py" ] && "$py" "$here/quota.py" --line 2>/dev/null
exit 0
