#!/usr/bin/env bash
# spick: UserPromptSubmit hook. Prints a 3-question triage checklist that Claude Code adds to the prompt context.
# Small models follow a checklist they see every turn far better than a rule they read once at session start.
# Line 2 routes by the shape of the deliverable, most expensive lane first and the main session last: a small model
# stops at the first bucket that fits, so the cheap bucket must come last. After it, triage_hint.py reads the prompt
# (the hook's stdin JSON) and adds one Hint line naming the keywords it found and the default route they imply.
# When the spick-dashboard mod is loaded it injects the checklist itself (built from its switches) and
# writes ~/.claude/.spick-mod-active at session start; a marker younger than 24 hours silences this copy.
# A stale marker (mod uninstalled) expires on its own. `find -mmin` works on both macOS and Linux.
# The quota cache (~/.claude/spick-quota.json) is refreshed from here in the background, never awaited;
# the last line printed below is a one-line summary of that cache (plain facts, no rules).
# The mod builds the same text from checklist.ts; test_triage_hint.py runs this hook and fails when the two drift.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
py=$(command -v python3 || command -v python || true)
marker="${HOME}/.claude/.spick-mod-active"
# the prompt arrives as JSON on stdin; a run from a terminal has none
input=""
[ -t 0 ] || input=$(cat 2>/dev/null || true)
if [ -f "$marker" ] && [ -n "$(find "$marker" -mmin -1440 2>/dev/null)" ]; then
  [ -n "$py" ] && "$py" "$here/quota.py" --touch >/dev/null 2>&1   # the mod prints the checklist; keep its cache warm
  exit 0
fi
cat <<'TXT'
[spick triage - answer all three before the first tool call]
1. Plan mode? 3+ files, irreversible/wide action, ambiguous ask, greenfield build, or user asked for a plan -> call EnterPlanMode now, then dispatch planner inside it (no such tool in headless mode: plan inline and stop before editing).
2. Lane? Route by the shape of the deliverable, top to bottom, first match wins; you are the last line, not the first:
   - a verdict: compare, evaluate, find gaps, diagnose why, review a codebase or a design, recommend, formal writing, or you cannot tell how hard it is -> Agent(deep). You never write a verdict yourself; read files only to brief it.
   - a plan or a design, or a change that needs a decision the user did not make (layout, API, algorithm, data shape, which file) -> Agent(planner); the change then goes to Agent(coder) with the plan.
   - changed code beyond a one-liner with nothing left to decide -> Agent(coder). You never edit source yourself.
TXT
# The lane bullet depends on whether the user declared a lane_registry; the other lines are the same either way.
cfg="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/spick.json"
registry=0
[ -f "$cfg" ] && grep -q '"lane_registry"' "$cfg" 2>/dev/null && registry=1
if [ "$registry" = 1 ]; then
  echo "   - a task an outside lane is tagged for -> pick from the Lanes line by its tags; never send anything above a lane's data: level."
else
  echo "   - web lookup -> Gemini (agy); X data -> Grok."
fi
cat <<'TXT'
   - a plain lookup, nothing else: the answer is already in a file here, a command's output or your own knowledge (Q&A, find/read, summarise, tidy, run a script) -> you.
   A prompt that mixes kinds is split by kind: you fetch, a lane searches, deep judges, coder edits. Pick an effort for every delegate. The Agent tool's own "when in doubt, don't spawn" is written for a model doing its own work; you are the triage layer, so when in doubt, spawn deep. A brief carries no design of your own: once it starts saying how (use X, then Y), stop and dispatch planner.
TXT
# the Hint line: keywords found in the prompt and the default route they imply; nothing when none matched
[ -n "$py" ] && [ -n "$input" ] && printf '%s' "$input" | "$py" "$here/triage_hint.py" --stdin-json 2>/dev/null
cat <<'TXT'
3. Goal-shaped? machine-checkable finish (tests green, build ok, exit 0) that needs several edit-run cycles -> hand the user one `/goal <check command>; stop after 10 attempts` line; you cannot start it yourself.
Reply starts with the deliverable; end with the label line: no delegate -> `[Model: Haiku 5.5 | Effort: medium]`; with delegates -> `[Model: Haiku 5.5 (medium) → coder Sonnet 5.5 (high) | Review: Codex <model> (medium)]` — every participant, reviewer included, carries its own model and effort. Never write `→ none` or `→ 无`.
TXT
[ "$registry" = 1 ] && [ -n "$py" ] && "$py" "$here/lanes.py" --line 2>/dev/null
[ -n "$py" ] && "$py" "$here/quota.py" --line 2>/dev/null
exit 0
