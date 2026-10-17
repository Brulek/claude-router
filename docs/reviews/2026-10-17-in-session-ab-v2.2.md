# In-session A/B, round 3: routing policy v2.2 (2026-10-17)

Round 2 left spick v2.1 at $0.61 on the eight short tasks against $0.54 for a lone Sonnet worker and $0.03 for a lone
Haiku worker, with the three `coder` tasks (T3, T4, T8) costing $0.06-0.08 each on Sonnet while the Haiku worker had
passed their hidden tests in every run. v2.2 (commit cefc7a3) sends a bug with a failing test to a Haiku `coder` first
and lets the test, not the model, decide escalation: only a failed check sends it to the Sonnet `coder` at high effort.
This round runs the three affected tasks three times each on the spick arm. Same stand-in method and attribution as
round 2; raw data in `skills/spick/evals/ab/samples/in-session-2026-10-17-r3/`.

| Task | v2.0 (n=1) | v2.1 (n=1-3) | v2.2 (n=3) | v2.2 route | v2.2 hidden tests |
|---|---|---|---|---|---|
| T3 code-fix (median) | $0.070, coder Sonnet | $0.078, coder Sonnet | $0.020 (0.020-0.020) | coder Haiku, 3/3 | 3/3 pass |
| T4 debug-lru | $0.201, deep Opus + coder Sonnet | $0.055, kept once, coder Sonnet twice | $0.021 (0.020-0.022) | coder Haiku, 3/3 (two with a `Kept:` diagnosis) | 3/3 pass |
| T8 three-file feature | $0.077, coder Sonnet | $0.075, coder Sonnet | $0.089 (0.079-0.094) | coder Sonnet, 3/3 (not a failing-test bug: unchanged by design) | 3/3 pass |

No escalation was needed: the Haiku coder's fix passed the visible and hidden tests in all six T3/T4 runs, so the
Sonnet fallback never ran. Wall time stayed at 26-37 s per run.

## The short-task total after three rounds

Summing per-task means for T1-T8 (T3/T4/T8 from this round, the rest from round 2 for v2.2):

| Arm | Cost, T1-T8 | Quality |
|---|---|---|
| haiku-bare, lone Haiku worker | $0.030 | all programmatic checks pass; judged plan 3.0-3.5, judged verdict 4.0-5.0 |
| sonnet-bare, lone Sonnet worker | $0.536 | all pass; judged 3.0 / 4.0 |
| sonnet-free, Sonnet main session with the full tool list | $1.784 | all pass; judged 3.0 / 4.0 |
| haiku-spick v2.0 | $1.008 | all pass; judged 4.0 / 5.0 |
| haiku-spick v2.1 | $0.607 | all pass; judged 4.0 / 4.3 |
| haiku-spick v2.2 | $0.527 | all pass; T5 4.0 (planner), T7 4.3 |

What remains of spick's cost is the planner on T5 ($0.34, the one place it buys a measured point of quality) and the
main session's own fixed cost of about $0.015 per task, which is the tool prompt of a full-tool-list session, not the
model (see the README FAQ entry added with this round). Without the planner call spick v2.2 would sit at $0.19 for the
eight tasks; without the tool-list overhead, under $0.10.

## Where this leaves the claim

- Against a strong main session with a full tool list, spick v2.2 is 70% cheaper on short tasks ($0.53 vs $1.78) at
  equal or better quality, and on the long verdict (round 2) it is 31% more expensive for a slightly better review.
- Against a lone Sonnet worker it is now at parity ($0.53 vs $0.54) with a one-point edge on the judged plan.
- Against a lone Haiku worker it is 18x, almost all of it the planner call and the main session's tool prompt. A lone
  Haiku worker passed every programmatic check in 23 of 23 runs across the three rounds; on these tasks, the thing
  worth paying for is not the router but a small context and a test to check against.

## Caveats

The same as rounds 1 and 2: a stand-in, not the hook-and-mod product; n of 1-3 per cell; one judge; list-price
estimates; tasks of seconds to minutes. The v2.2 fallback path (Sonnet after a failed Haiku check) was never exercised
because no Haiku fix failed; a harder bug set is needed to measure it.
