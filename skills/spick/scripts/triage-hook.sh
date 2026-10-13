#!/usr/bin/env bash
# spick: UserPromptSubmit hook. Prints a 3-question triage checklist that Claude Code adds to the prompt context.
# Small models follow a checklist they see every turn far better than a rule they read once at session start.
cat <<'TXT'
[spick triage - answer all three before the first tool call]
1. Plan mode? 3+ files, irreversible/wide action, ambiguous ask, greenfield build, or user asked for a plan -> call EnterPlanMode now, then dispatch planner inside it (no such tool in headless mode: plan inline and stop before editing).
2. Lane? chores -> you; code change beyond a one-liner -> Agent(coder), never edit source yourself; plan/design -> Agent(planner); hard/decision/formal writing -> Agent(deep); web lookup -> Gemini (agy); X data -> Grok. Pick an effort for every delegate.
3. Goal-shaped? machine-checkable finish (tests green, build ok, exit 0) that needs several edit-run cycles -> hand the user one `/goal <check command>; stop after 10 attempts` line; you cannot start it yourself.
Reply starts with the deliverable; end with the label line: no delegate -> `[Model: Haiku 5.5 | Effort: medium]`; with delegates -> `[Model: Haiku 5.5 (medium) → coder Sonnet 5.5 (high) | Review: Codex gpt-6-astra (medium)]` — every participant, reviewer included, carries its own model and effort. Never write `→ none` or `→ 无`.
TXT
