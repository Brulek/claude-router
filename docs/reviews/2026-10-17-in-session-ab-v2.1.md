# In-session A/B, round 2: routing policy v2.1 against v2.0 and the baselines (2026-10-17)

Round 1 (`2026-10-17-in-session-ab.md`) showed that v2.0's "every verdict and every formal text to Opus" rule was
spick's cost driver on short tasks and bought no measured quality. v2.1 (commit da380fb) routes a verdict by the size
of its material (small -> the main session with a `Kept:` line, large or high-stakes -> `deep`) and sends a bug with a
failing test to `coder` first. This round measures that change, with repeats on the tasks it touches and one new long
task, T9: a verdict over ~2,450 lines of the pre-fix mod (six TypeScript modules), judged against a reference key of
four known defects.

Same stand-in method as round 1 (subagents in a live session, the session's dashboard mod pricing every subagent row
at list price, Codex gpt-6-astra as the blind judge, labels shuffled). Nested delegates are attributed from the top
agent's transcript, so parallel runs are exact. Raw data: `skills/spick/evals/ab/samples/in-session-2026-10-17-r2/`.

## Per task, arm and rule set: quality, cost (USD, list price), wall time

| Task | Arm | Rules | n | Quality | Cost mean (range) | Wall s mean | Route taken (v2.1) |
|---|---|---|---|---|---|---|---|
| T1 | haiku-bare | v2.0 | 1 | pass 1/1 | 0.004 | 11 |  |
| T1 | sonnet-bare | v2.0 | 1 | pass 1/1 | 0.065 | 9 |  |
| T1 | sonnet-free | v2.0 | 1 | pass 1/1 | 0.328 | 13 |  |
| T1 | haiku-spick | v2.0 | 1 | pass 1/1 | 0.018 | 18 |  |
| T1 | haiku-spick | v2.1 | 1 | pass 1/1 | 0.017 | 18 | [Model: Haiku 5.5 | Effort: medium] |
| T2 | haiku-bare | v2.0 | 1 | pass 1/1 | 0.003 | 5 |  |
| T2 | sonnet-bare | v2.0 | 1 | pass 1/1 | 0.053 | 5 |  |
| T2 | sonnet-free | v2.0 | 1 | pass 1/1 | 0.192 | 7 |  |
| T2 | haiku-spick | v2.0 | 1 | pass 1/1 | 0.010 | 9 |  |
| T2 | haiku-spick | v2.1 | 1 | pass 1/1 | 0.013 | 8 | [Model: Haiku 5.5 | Effort: medium] |
| T3 | haiku-bare | v2.0 | 1 | pass 1/1 | 0.004 | 13 |  |
| T3 | sonnet-bare | v2.0 | 1 | pass 1/1 | 0.069 | 11 |  |
| T3 | sonnet-free | v2.0 | 1 | pass 1/1 | 0.242 | 18 |  |
| T3 | haiku-spick | v2.0 | 1 | pass 1/1 | 0.070 | 28 |  |
| T3 | haiku-spick | v2.1 | 1 | pass 1/1 | 0.078 | 34 | [Model: Haiku 5.5 (medium) → coder Sonnet 5.5 (high)] +Kept |
| T4 | haiku-bare | v2.0 | 1 | pass 1/1 | 0.004 | 11 |  |
| T4 | haiku-bare | v2.1 | 2 | pass 2/2 | 0.004 (0.004-0.004) | 12 |  |
| T4 | sonnet-bare | v2.0 | 1 | pass 1/1 | 0.066 | 10 |  |
| T4 | sonnet-free | v2.0 | 1 | pass 1/1 | 0.201 | 13 |  |
| T4 | haiku-spick | v2.0 | 1 | pass 1/1 | 0.201 | 47 |  |
| T4 | haiku-spick | v2.1 | 3 | pass 3/3 | 0.055 (0.018-0.073) | 27 | [Model: Haiku 5.5 (medium) → coder Sonnet 5.5 (high)]; [Model: Haiku 5.5 (medium) → coder Sonnet 5.5 (medium)] +Kept; [Model: Haiku 5.5 | Effort: medium] +Kept |
| T5 | haiku-bare | v2.0 | 1 | judge 3.0 | 0.003 | 11 |  |
| T5 | haiku-bare | v2.1 | 2 | judge 3.5 (n=2) | 0.004 (0.004-0.004) | 15 |  |
| T5 | sonnet-bare | v2.0 | 1 | judge 3.0 | 0.061 | 13 |  |
| T5 | sonnet-free | v2.0 | 1 | judge 3.0 | 0.185 | 23 |  |
| T5 | haiku-spick | v2.0 | 1 | judge 4.0 | 0.219 | 61 |  |
| T5 | haiku-spick | v2.1 | 1 | judge 4.0 | 0.338 | 99 | [Model: Haiku 5.5 (medium) → planner Opus (high)] |
| T6 | haiku-bare | v2.0 | 1 | pass 1/1 | 0.004 | 12 |  |
| T6 | haiku-bare | v2.1 | 2 | pass 2/2 | 0.003 (0.003-0.003) | 10 |  |
| T6 | sonnet-bare | v2.0 | 1 | pass 1/1 | 0.069 | 12 |  |
| T6 | sonnet-free | v2.0 | 1 | pass 1/1 | 0.201 | 14 |  |
| T6 | haiku-spick | v2.0 | 1 | pass 1/1 | 0.115 | 27 |  |
| T6 | haiku-spick | v2.1 | 3 | pass 3/3 | 0.014 (0.014-0.014) | 16 | [Model: Haiku 5.5 | Effort: medium] +Kept |
| T7 | haiku-bare | v2.0 | 1 | judge 5.0 | 0.005 | 17 |  |
| T7 | haiku-bare | v2.1 | 2 | judge 4.0 (n=2) | 0.004 (0.004-0.004) | 14 |  |
| T7 | sonnet-bare | v2.0 | 1 | judge 4.0 | 0.086 | 19 |  |
| T7 | sonnet-free | v2.0 | 1 | judge 4.0 | 0.211 | 18 |  |
| T7 | haiku-spick | v2.0 | 1 | judge 5.0 | 0.297 | 88 |  |
| T7 | haiku-spick | v2.1 | 3 | judge 4.3 (n=3) | 0.018 (0.017-0.018) | 27 | [Model: Haiku 5.5 | Effort: medium] +Kept |
| T8 | haiku-bare | v2.0 | 1 | pass 1/1 | 0.004 | 11 |  |
| T8 | sonnet-bare | v2.0 | 1 | pass 1/1 | 0.066 | 10 |  |
| T8 | sonnet-free | v2.0 | 1 | pass 1/1 | 0.223 | 13 |  |
| T8 | haiku-spick | v2.0 | 1 | pass 1/1 | 0.077 | 40 |  |
| T8 | haiku-spick | v2.1 | 1 | pass 1/1 | 0.075 | 33 | [Model: Haiku 5.5 (medium) → coder Sonnet 5.5 (high)] |
| T9 | haiku-bare | v2.1 | 3 | judge 3.0 (n=3) | 0.020 (0.017-0.023) | 102 |  |
| T9 | sonnet-bare | v2.1 | 3 | judge 3.0 (n=3) | 0.321 (0.275-0.388) | 105 |  |
| T9 | sonnet-free | v2.1 | 1 | judge 3.0 | 0.502 | 103 |  |
| T9 | haiku-spick | v2.1 | 3 | judge 3.3 (n=3) | 0.657 (0.590-0.695) | 185 | [Model: Haiku 5.5 (medium) → deep Opus (high)]; no label |

## Eight short tasks T1-T8, cost per arm (sum over tasks of per-task mean cost)

| Arm | Rules | Cost T1-T8 | of which Opus-routed tasks |
|---|---|---|---|
| haiku-bare | v2.0 | $0.030 | |
| sonnet-bare | v2.0 | $0.536 | |
| sonnet-free | v2.0 | $1.784 | |
| haiku-spick | v2.0 | $1.008 | |
| haiku-spick | v2.1 | $0.607 | |

T9 judge detail (overall mean; recall of the four known defects out of 4): haiku-spick 3.33 / 2.53 (n=3),
sonnet-free 3.0 / 2.3 (n=1), sonnet-bare 3.0 / 2.1 (n=3), haiku-bare 3.0 / 2.0 (n=3).

## What changed with v2.1

- The size rule did what it was written to do: all three T6 and all three T7 repeats stayed with the Haiku main session
  with a `Kept:` line; T4 went to `coder` twice and was kept once (a one-file fix); T9 went to `deep` all three times.
- spick's cost on the eight short tasks fell from $1.01 to $0.61 (-40%) with quality unchanged: every programmatic check
  still passes (T4 3/3, T6 3/3), the T7 verdict scored 4.3 (n=3) against 4.0 (n=2) for the Haiku worker in the same judge
  packet, and the planner's backup plan kept its one-point edge (4.0 vs 3.5).
- On the long verdict (T9) the Opus `deep` route scored highest (3.33, recall 2.53 of 4) but every arm found only two to
  three of the four known defects; the edge cost $0.66 per run against $0.32 for a Sonnet worker and $0.02 for a Haiku
  worker. Delegation to Opus paid a little on this task, at 2x the Sonnet price.

## What the numbers say now

- Against the realistic strong baseline (a Sonnet main session with the full tool list, `sonnet-free`), spick v2.1 is
  66% cheaper on the short tasks ($0.61 vs $1.78); on T9 it is 31% more expensive ($0.66 vs $0.50) for a slightly
  better review. Against a single Sonnet worker with a small tool set it is 13% more expensive on
  the short tasks and 2x on T9; against a single Haiku worker it is 20x and 33x.
- What is left of spick's cost on short tasks: the planner on T5 ($0.34), the coder on T3/T4/T8 ($0.07 each), and the
  main session's own fixed cost per run (about $0.015 for a general-purpose Haiku agent against $0.004 for a Haiku worker
  with six tools). The last item is the tool list, not the model: the small-context principle applies to the main
  session itself.
- "Cheaper without losing quality" therefore holds against a strong main session with a full tool list, and does not
  hold against a lone small-tool-set worker on tasks that take seconds. Where it pays is where a strong model would
  otherwise read everything itself.

## Caveats

- Stand-in, not the product: no bash hook, mod gate or guard in the loop; the checklist pasted into the prompt; v1 agent
  files installed (`deep` at high effort, not v2's medium default); the user's v1 CLAUDE.md block visible to all arms.
- n = 1 for most cells (3 for T4, T6, T7, T9 on the spick arm; 2-3 for the Haiku worker on T4-T7, T9); no significance.
- One judge (Codex) per packet; the T7 and T9 rubrics handed the judge reference facts; round-1 and round-2 judgements of
  the same task are different packets and are not pooled.
- Costs are list-price estimates from the mod's table including cache reads; subscription usage differs.
- Tasks of seconds to three minutes; no multi-turn session, no 100k+ context, no cache-lifetime effects.

## Next

1. Run the real harness (`skills/spick/evals/ab`) after `claude auth login`, with v2 agents installed, n = 3.
2. Cut the main session's own fixed cost: a smaller tool list for the triage session (the Explore-style restriction),
   measured the same way.
3. Keep T9-class tasks in the matrix: they are where `deep` earns its price, and where the four-defect recall ceiling
   (every arm missed at least one) says the reviewers, not the router, are the limit.
