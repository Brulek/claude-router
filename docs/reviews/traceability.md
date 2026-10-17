# Traceability: review findings to spec, commits and tests

Columns: finding (source and number), spec section, where it landed (commit or branch), the regression test, or the
reason it was deferred. Filled by the integrator at merge; "round 1" means branch `claude/review-round-1-b8e17b`.

Sources: F = `2026-10-16-fable-review.md`; A = `2026-10-16-codex-astra-review.md` (①-⑧ are its correctness defects,
P1/P2 its architecture items); S = `2026-10-17-codex-astra-spec-review.md` (its eight suggestions).

| Finding | Spec | Landed in | Test / deferral |
|---|---|---|---|
| F1 snippet read by subagents | §3 (agents), round 1 | round 1 `2c29ca0` | test_setup.py snippet first line |
| F2 four copies of the rules | §2 | S1 | test_rules.py `--check` |
| F3 machine facts in shipped text | round 1 | round 1 `5d0e2e3` | checklist.test.ts |
| F4 config-dir paths | §8 | round 1 `de3c234`, S1 paths.py, S2 paths.ts | test_setup.py, paths tests |
| F5 stale evaluation evidence | §10 | S3 harness, integrator's run | REPORT in evals/ab |
| F6 keyword false positives, gate scope | §4, §5 | round 1 `871e1c8` (gate on verdicts), S1 hint v2 | hint corpus |
| F7 SKILL.md length | §9 | round 1 `f66b007` | test_rules.py budget |
| F8 subscriptions hand-written | round 1 | round 1 `c5a6bdf` | test_set_subscription.py |
| F9 check detector gaps | round 1, §5 | round 1 `a0c3247`, S2 truthfulness | guard.test.ts |
| F10 Fable price | round 1 | round 1 `28b6556` | format.test.ts |
| F11 CI gaps, plan file | round 1 | round 1 `0797ccc` | ci.yml |
| F12 deep effort | round 1 | round 1 `7c1206b` | hint tests |
| F13 search fallback | round 1 | round 1 `bd89de4` | evals.json eval 0 |
| F14 strong-model sessions | round 1 | round 1 `9eb8346` | checklist.test.ts |
| A① guard blind in a worktree, Dockerfile | §5 | S2 | format.test.ts |
| A② check counted before it ran; `echo pytest` | §5, §13 | S2 | guard.test.ts, register.test.ts |
| A③ empty lane list reverts to defaults | §5 | S1 | quotaline.test.ts, checklist.test.ts |
| A④ API answer truncated silently | §7 | S1 | test_invoke.py |
| A⑤ quota read time shown as sample time | §7 | S2 | quota.test.ts |
| A⑥ global marker silences other sessions | §8 | S1 hook, S2 marker | hook test |
| A⑦ setup reports done after a failure | §7 | S1 | test_setup.py |
| A⑧ quoted `-m "model"` parsed as "0" | §7 | S2 | format.test.ts |
| A P1 quality judgement stays with the small model | §3 (Evidence block, verification against the artifact), §10 | S1 agents/SKILL | measured by the A/B, not fixed by code |
| A P1 gate passes on "a call happened" | §5, §13 | S2 | register.test.ts |
| A P1 data level not a boundary | §5, §13 | S1 invoke.py | test_invoke.py |
| A P2 policy in several sources, config split | §2, §8 | S1, S2 | test_rules.py |
| A P2 no executable cost standard | §3 (planner threshold, not-dispatching default), §6 audit | S1, S2 | audit.py over real logs |
| S1 eval arms must load the mod under test | §13 | S3 | run.py |
| S2 record schema: gate history, per-lane cost, concurrency | §13 | S2 | turnlog tests |
| S3 role completion, check binding | §13 | S2 | register.test.ts |
| S4 data level as declared constraint | §13 | S1 | test_invoke.py |
| S5 ownership overlaps | §11 as briefed | integrator | merge without conflicts |
| S6 fair baselines, ablation, full cost | §13 | S3 | REPORT |
| S7 permission boundaries stated honestly | §13 | S1, S2 README | docs |
| S8 integration scenarios, this table | §12, §13 | integrator | this file |

Deferred, with reasons: a shared `~/.claude/spick/` directory for state is done, but `spick.json` stays where it is
(users know it); Bash writes are not counted by the edit cap (no cheap detection); a semantic classifier (text would
leave the machine); mid-session model switching (claude-router's job).
