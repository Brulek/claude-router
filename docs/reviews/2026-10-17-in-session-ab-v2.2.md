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

## Addendum: a second judge, and a harder bug (round 4, 2026-10-17)

**Second judge.** The round-2 judge packets for T5, T7 and T9 were scored again, blind, by Opus 5.5 (`deep`, medium)
with the same shuffled labels. Raw outputs: `samples/in-session-2026-10-17-r2/judge2/`.

| Task | Arm | n | Codex judge | Opus judge |
|---|---|---|---|---|
| T5 | haiku-spick (planner) | 1 | 4.0 | 5.0 |
| T5 | haiku-bare | 2 | 3.5 | 3.5 |
| T7 | haiku-spick (kept, Haiku) | 3 | 4.3 | 5.0 |
| T7 | haiku-bare | 2 | 4.0 | 3.5 |
| T9 | haiku-spick (deep) | 3 | 3.3 | 4.3 |
| T9 | sonnet-free | 1 | 3.0 | 4.0 |
| T9 | sonnet-bare | 3 | 3.0 | 3.7 |
| T9 | haiku-bare | 3 | 3.0 | 3.0 |

Over the 18 answers both judges scored, every pair is within one point (6 identical; mean absolute difference 0.67;
Opus scores 0.44 higher on average). The ordering is the same under both judges: the spick arm is first or tied first
on every judged task, with Opus drawing the larger gap. The conclusions of rounds 1-3 do not depend on which judge is used.

**A harder bug, T10.** A width-aware text wrapper (East Asian wide characters count two cells, combining marks none)
with two failing visible tests and four hidden tests, built to give the v2.2 fallback a chance to fire. It did not:
the Haiku coder's fix passed all four hidden tests in 3 of 3 spick runs ($0.018-0.020 each, 39-46 s), and the lone
Haiku worker passed in 2 of 2 ($0.006-0.007). Across T3, T4 and T10 the Haiku-first rule has now been tried 11 times
and never needed the Sonnet fallback; the fallback path is covered by the mod's unit tests (the escalation line on a
second failed check), not by data. A bug set where Haiku actually fails is the missing piece of evidence, and it
would have to be found, not designed to fail.

## Where the evidence stops

What three rounds, two judges and 70-odd runs can say: on short, checkable tasks, spick v2.2 matches a lone Sonnet
worker on cost ($0.53 vs $0.54 for eight tasks), beats a full-tool-list Sonnet main session by 70%, and delivers
equal or better quality under both judges; on a long verdict the Opus route is the best reviewer at 2x a Sonnet
worker's price; a lone Haiku worker with six tools remains 18x cheaper than spick on the short tasks and passed every
hidden test it was given (28 of 28 runs), which is the strongest single finding of the exercise.

What they cannot say: anything about the hook-and-mod product in a live session (the stand-in has no gate, guard
or hook), about multi-turn sessions, caches or contexts past 100k tokens, about real subscription bills, or about
statistical significance at n of 1-3. The harness in `skills/spick/evals/ab` measures the product itself and runs the
moment the CLI is logged in.
