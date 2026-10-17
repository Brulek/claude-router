# Traceability: review findings to spec, commits and tests

Columns: finding (source and number), spec section, where it landed (commit or branch), the regression test, or the
reason it was deferred. Filled at merge on 2026-10-17 (commit hashes on branch spick-v2); "round 1" means branch `claude/review-round-1-b8e17b`.

Sources: F = `2026-10-16-fable-review.md`; A = `2026-10-16-codex-astra-review.md` (①-⑧ are its correctness defects,
P1/P2 its architecture items); S = `2026-10-17-codex-astra-spec-review.md` (its eight suggestions).

| Finding | Spec | Landed in | Test / deferral |
|---|---|---|---|
| F1 snippet read by subagents | §3 (agents), round 1 | round 1 `2c29ca0` | test_setup.py snippet first line |
| F2 four copies of the rules | §2 | 8600aa0 | test_rules.py `--check` |
| F3 machine facts in shipped text | round 1 | round 1 `5d0e2e3` | checklist.test.ts |
| F4 config-dir paths | §8 | round 1 `de3c234`, 25eb429 (paths.py), b7e6a8a (paths.ts) | test_setup.py, paths tests |
| F5 stale evaluation evidence | §10 | c1fd57b..4eeda2b (harness); the A/B run waits for a CLI login | REPORT in evals/ab |
| F6 keyword false positives, gate scope | §4, §5 | round 1 `871e1c8` (gate on verdicts), c0ad9fc (hint v2) | hint corpus |
| F7 SKILL.md length | §9 | round 1 `f66b007` | test_rules.py budget |
| F8 subscriptions hand-written | round 1 | round 1 `c5a6bdf` | test_set_subscription.py |
| F9 check detector gaps | round 1, §5 | round 1 `a0c3247`, d17b30a (truthfulness) | guard.test.ts |
| F10 Fable price | round 1 | round 1 `28b6556` | format.test.ts |
| F11 CI gaps, plan file | round 1 | round 1 `0797ccc` | ci.yml |
| F12 deep effort | round 1 | round 1 `7c1206b` | hint tests |
| F13 search fallback | round 1 | round 1 `bd89de4` | evals.json eval 0 |
| F14 strong-model sessions | round 1 | round 1 `9eb8346` | checklist.test.ts |
| A① guard blind in a worktree, Dockerfile | §5 | 750e84b | format.test.ts |
| A② check counted before it ran; `echo pytest` | §5, §13 | d17b30a | guard.test.ts, register.test.ts |
| A③ empty lane list reverts to defaults | §5 | 7a6fae2, 41a870a | quotaline.test.ts, checklist.test.ts |
| A④ API answer truncated silently | §7 | 320a498 | test_invoke.py |
| A⑤ quota read time shown as sample time | §7 | 921262f | quota.test.ts |
| A⑥ global marker silences other sessions | §8 | 25eb429 (hook), b7e6a8a (marker) | hook test |
| A⑦ setup reports done after a failure | §7 | 494ce56 | test_setup.py |
| A⑧ quoted `-m "model"` parsed as "0" | §7 | 921262f | format.test.ts |
| A P1 quality judgement stays with the small model | §3 (Evidence block, verification against the artifact), §10 | 8600aa0 (agents, SKILL) | measured by the A/B, not fixed by code |
| A P1 gate passes on "a call happened" | §5, §13 | 0bcf7ff | register.test.ts |
| A P1 data level not a boundary | §5, §13 | 320a498 | test_invoke.py |
| A P2 policy in several sources, config split | §2, §8 | 8600aa0, 25eb429, b7e6a8a | test_rules.py |
| A P2 no executable cost standard | §3 (planner threshold, not-dispatching default), §6 audit | 8600aa0, bf23a80 | audit.py over real logs |
| S1 eval arms must load the mod under test | §13 | 67e9f65, 9c79f58 | run.py |
| S2 record schema: gate history, per-lane cost, concurrency | §13 | bf23a80 | turnlog tests |
| S3 role completion, check binding | §13 | 0bcf7ff, d17b30a | register.test.ts |
| S4 data level as declared constraint | §13 | 320a498 | test_invoke.py |
| S5 ownership overlaps | §11 as briefed | merges 7501822, d1f86fa, 4dae055 (no conflicts); 41a870a | merge without conflicts |
| S6 fair baselines, ablation, full cost | §13 | 67e9f65, e357e1c | REPORT |
| S7 permission boundaries stated honestly | §13 | 310d842, 921262f (READMEs) | docs |
| S8 integration scenarios, this table | §12, §13 | this file; the A/B run | this file |

Deferred, with reasons: a shared `~/.claude/spick/` directory for state is done, but `spick.json` stays where it is
(users know it); Bash writes are not counted by the edit cap (no cheap detection); a semantic classifier (text would
leave the machine); mid-session model switching (claude-router's job).

## Round 3: the re-review of the integrated branch (2026-10-17-codex-astra-rereview.md)

| Finding | Where it lands | Test |
|---|---|---|
| N1 a compound command, an in-flight edit or a check outside the edits' scope passes as a check | 993e468 (single-command rule, edits counted when completed, `afterLastEdit`); the scope limit stays documented | guard.test.ts, register.test.ts |
| N2 a tool return can fake a completed review or deep | d3c4c5d (single-command review calls with 200+ chars of output; foreground completion by `turn.complete`, else `confirmedBy: tool.result`) | register.test.ts |
| N3 nested delegates and post-timeout completions missing from the record | 7cb234a | turnlog/register tests, test_spend.py, test_audit.py |
| N4 a cold quota cache reverts disabled lanes to the defaults | 2cde1a4 (spick.json is the authority when the cache is cold) | register.test.ts |
| N5 the A/B cannot prove it measured the checkout's mod | c786f30 (probe per arm, `_probe.json`), f537ad9 (README) | test_run.py |
| N6 exit failures counted as passes, unknown cost as zero, Explore unbound | 90b20be, 3ba160e, 0fca132 | test_grade.py, test_report.py |
| N7 quoted `--lane` parsed as "0" | 002e28e | format.test.ts |
| N8 version stamped without checking what the install kept; `~/.claude/spick.json` hard-coded in SKILL | 3f3cea9 | test_setup.py |
| A P1 data level: override without audit | f69c4ac (`<state>/invoke.jsonl`, audit.py) | test_invoke.py |

## Round 4: the scoped check of round 3 (2026-10-17-codex-astra-round3-check.md)

| Finding | Landed in | Test |
|---|---|---|
| Redirection parsing swallowed `||true` / `;true` after a check | 3d68b15 (operators rejected before redirections are stripped) | guard.test.ts |
| Built-in `lanes` booleans without a registry read as "no registry" and re-enabled every lane | 47d63f2 (`lanes.py --variant`; quota.py, the hook and quotaline.ts share the rule) | test_lanes.py, test_quota.py, hook test, quotaline/checklist tests |
| 200-character floor rejected short review reports | 91a93d6 (`isReport`: a non-empty line, 20+ chars, not a usage text) | gate.test.ts, register.test.ts, test_audit.py |
| `_probe.json` overwritten on resumed runs | b3f240c (`meta.probe` per run; cells read verified/mixed/not verified) | test_run.py, test_report.py |
| Missing delegate record read as "no outside calls" | 8e19a96 (`cost_floor: null`, `?` in the report) | test_grade.py, test_report.py |

## Round 5: the first real harness run (2026-10-17-real-harness-ab.md)

What the run itself found, each with its commit and regression test.

| Finding | Landed in | Test |
|---|---|---|
| `disableAllHooks` in the spick arm's settings disabled the mod itself (probe failed: no record, no marker) | 5155f1b (hooks stay on; the mod's per-session marker silences the user's global hook; the hook arm does not add this checkout's hook twice) | test_run.py `Arms`, README measurement |
| A subagent's own `turn.start` reset the main turn's state (delegates [], hint [], gate blind to a running deep) | 43a4fc3 (`if (e.agentId) return next(e)`) | register.test.ts "a subagent's own turn.start does not reset the main turn" |
| The Claude judge's relative `--settings` path resolved against its cwd; a failed verdict was reused from cache; T9 had no pass threshold | 679a64b | test_grade.py `JudgeTask`, `TaskFiles` |
| Work trees inside the checkout carried its git status and recent commit titles into every session; T9 answers quoted the commit that fixed the defect they had to find | d376412 (`run.py` refuses an out dir inside a work tree; default `~/spick-ab/results`; K5 in T9's key) | test_run.py `OutDir` |
| The Opus judge with no built-in tools loaded every MCP tool schema ($2.73 a call) | fdce704 (`--strict-mcp-config` with an empty config: $0.05) | smoke-tested, not unit-tested (a live call) |

Open after round 5, by design or pending a live run: the foreground-agent completion fallback on the tool result (`confirmedBy`) until the engine's event order is observed live; the check's scope (which files a test exercises) is not known to the mod; the edit cap does not see Bash writes; `--override-data` needs only a non-empty reason (logged); kept (user-modified) agent files are listed, not blocked, on upgrade; the A/B matrix and the Explore override wait for a CLI login on this machine.
