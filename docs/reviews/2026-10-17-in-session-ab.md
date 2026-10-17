# In-session A/B of spick v2's routing policy (2026-10-17)

The CLI on this Mac was logged out, so the harness in `skills/spick/evals/ab` could not run `claude -p`. This run is a
stand-in built inside a live Claude Code session: each arm is a subagent, and the session's dashboard mod (v1,
installed globally) recorded every subagent's model, tokens and list-price cost. Raw data: `skills/spick/evals/ab/samples/in-session-2026-10-17/`.

## Arms and tasks

| Arm | What ran |
|---|---|
| `haiku-bare` | one Haiku 5.5 `coder`-type subagent (Read, Edit, Write, Bash, Grep, Glob; no Agent), told to do the work itself |
| `sonnet-bare` | the same with Sonnet 5.5 |
| `haiku-spick` | a Haiku 5.5 `general-purpose` subagent given the v2 checklist (rendered from `assets/checklist.txt` with the Hint for the prompt) and told it is the main session; it delegates through the Agent tool to the installed `coder` (Sonnet), `planner` and `deep` (Opus) |
| `sonnet-free` | a Sonnet 5.5 `general-purpose` subagent with no routing text; the closest stand-in for a strong main session with the full tool list |

Tasks T1-T8 are the harness's own (chore, Q&A, test fix, debug, backup plan, formal brief, script comparison, three-file
feature). Grading: T1/T2 exact, T3/T4/T8 hidden tests with the visible tests untouched, T6 length/placeholders/forbidden
words, T5/T7 blind judge (Codex gpt-6-astra, labels shuffled, key kept). One run per cell.

## Results

| Arm | Programmatic pass | T5 judge (1-5) | T7 judge (1-5) | Cost, 8 tasks (list price) | of which Opus | Wall p50 | Wall max |
|---|---|---|---|---|---|---|---|
| haiku-bare | 6/6 | 3 | 5 | $0.030 | $0.000 | 11 s | 17 s |
| sonnet-bare | 6/6 | 3 | 4 | $0.536 | $0.000 | 11 s | 19 s |
| haiku-spick | 6/6 | 4 | 5 | $1.008 | $0.721 | 40 s | 88 s |
| sonnet-free | 6/6 | 3 | 4 | $1.784 | $0.000 | 14 s | 23 s |

| Task | haiku-bare | sonnet-bare | haiku-spick (route taken) | sonnet-free |
|---|---|---|---|---|
| T1 | pass, $0.004 | pass, $0.065 | pass, $0.018 (kept) | pass, $0.328 |
| T2 | pass, $0.003 | pass, $0.053 | pass, $0.010 (kept) | pass, $0.192 |
| T3 | pass, $0.004 | pass, $0.069 | pass, $0.070 (coder Sonnet) | pass, $0.242 |
| T4 | pass, $0.004 | pass, $0.066 | pass, $0.201 (deep Opus + coder Sonnet) | pass, $0.201 |
| T5 | judge 3, $0.003 | judge 3, $0.061 | judge 4, $0.219 (planner Opus) | judge 3, $0.185 |
| T6 | pass, $0.004 | pass, $0.069 | pass, $0.115 (deep Opus) | pass, $0.201 |
| T7 | judge 5, $0.005 | judge 4, $0.086 | judge 5, $0.297 (deep Opus) | judge 4, $0.211 |
| T8 | pass, $0.004 | pass, $0.066 | pass, $0.077 (coder Sonnet) | pass, $0.223 |

Routing observed in the spick arm: T1 and T2 kept (no Hint fired, correct); T3 and T8 to `coder` without `planner`
(the v2 threshold); T4 to `deep` on the Hint's 原因/根因 then `coder`; T5 to `planner`; T6 and T7 to `deep`. Every spick
reply carried a label line; no `Kept:` line was needed. `deep` ran at high effort because the installed v1 agent file says
so; v2's medium default was not exercised.

## What the numbers say

- Quality was flat: every arm passed all six programmatic checks; the planner-written backup plan scored one point
  higher than the others, the script comparison tied between the Haiku worker and the Opus deep run.
- Against a strong main session with the full tool list (`sonnet-free`), spick was 43% cheaper at equal or better quality.
  Against a single Sonnet worker with a small tool set (`sonnet-bare`), spick cost 1.9x. Against a single Haiku worker,
  33x. The cost lever that paid was a small context (kept lookups, a small-tool-set worker); the lever that cost was
  "verdict or formal writing -> Opus" on short inputs: $0.72 of spick's $1.01 went to Opus on four tasks, and on three of
  them the cheap arms matched the quality.
- Latency: the delegating arm's median wall time was 3-4x the others'.
- The cheapest arm (`haiku-bare`) matched or beat the strong arms on seven of eight tasks. On these short tasks the
  main cost is the fixed per-request overhead of a big tool list, not the model tier. This agrees with the X reports in
  `docs/research/2026-10-17-landscape.md` (a plain Sonnet run beat the Opus-plus-Haiku stack on one bug fix).

## What this run cannot show

- n = 1 per cell: no variance, no significance; treat the table as a check, not a measurement.
- Stand-in, not the product: no bash hook, no mod gate or guard, the checklist pasted into the prompt, the installed v1
  agents and the v1 CLAUDE.md block visible to every arm (the bare arms were told the block does not apply to them).
- Costs are the mod's list-price estimate per row, including cache reads; subscription usage differs.
- One judge (Codex), and the T7 rubric handed the judge the known facts; the T5 rubric did not.
- Tasks are seconds long; a long session, a multi-turn task, or a verdict over a large codebase were not tested, and those
  are exactly where context isolation and the Haiku 100k price step would change the picture.

## What to change next (evidence to gather before changing rules)

1. Size-condition the verdict and formal-writing routes: inputs under roughly 200 lines stay with the main session or
   go to a Sonnet worker; `deep` for large inputs or after a failed attempt. This run's T4, T6 and T7 would have cost
   $0.02 instead of $0.61 at the same grade.
2. A debug task with a failing test goes to `coder` first; `deep` only after two failed checks (the escalation-on-facts rule
   already in v2's guard). The Hint's 原因/根因 should not pre-empt that.
3. Re-run with n = 3 through the real harness after `claude auth login`, with the v2 agents installed, and add two long
   tasks (a verdict over a 2,000-line module, a four-file refactor) where delegation is expected to pay.
