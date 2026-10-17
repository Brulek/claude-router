# The first real A/B run: `skills/spick/evals/ab` against `claude` 2.1.302 (2026-10-17)

Four in-session stand-in rounds (`2026-10-17-in-session-ab*.md`) had to replace the harness while this machine's CLI
was logged out. After the login the harness ran for real: 7 arms x 10 tasks x 3 runs = 210 `claude -p` sessions, two
blind judges, every start-up probe verified. This note records what the run found in the harness and the mod before
any number could be trusted, then the numbers, then what they change.

Raw data: `skills/spick/evals/ab/results/full/` on this machine (gitignored; `REPORT-2026-10-17.md`, `grades.json`,
`judge/`, one `result.json` per run with its turn record), with the contaminated T9 cells kept aside in
`results/full-t9-contaminated/` and the clean T9 run in `~/spick-ab/t9-clean/`. The report, grades and judge files
are copied to `skills/spick/evals/ab/samples/real-2026-10-17/`.

## 1. Five things the real run found before the numbers meant anything

**The spick arm's probe failed.** The harness asks each arm one cheap question before the matrix and checks, from the
turn-record directory, that the arm started as its name says. `haiku-spick` failed: no schemaVersion 2 record.
Measured one flag at a time (`scratchpad/probe/`, five `claude -p` calls per variant): `disableAllHooks: true`, put
there to keep the user's global hook out, disables the mod's own handlers as well (no record, no per-session marker);
the `enabledPlugins` key alone does not; `--plugin-dir` is honoured next to it. The arm now leaves hooks on, and the
mod's per-session marker is what silences the user's global spick hook (transcripts show one checklist copy and no
hook nudge line). Commit 5155f1b; `README.md` of the harness records the measurement. Also found there: the marketplace
`spick` is installed from the checkout directory itself, so the "global" mod is this same code, and the
`enabledPlugins` key is the only thing that keeps it out of a run.

**The second judge cost $2.73 per call.** `grade.py --judges codex,claude` adds an Opus judge through `claude -p`
(fdce704). Its first call, two one-line answers, cost $2.73: with no built-in tools there is no ToolSearch to defer
them, so every MCP tool schema of this machine's connectors went into the prompt. With `--strict-mcp-config` and an
empty MCP config the same call costs $0.05 and gives the same scores. The arms were not changed: they keep the user's
real settings, as the design says, and pay the same fixed context in every arm (about 61k tokens at the first turn of a
Haiku session here, `context.lastInput` in the turn record).

**The mod wiped its own record whenever a subagent started.** The first spick runs that delegated came back with
`delegates: []` and `hint: []` although the result's `subagent_stats` showed a planner, a coder or deep, and the T5
prompt carries design words the hook hints on. The engine reports a subagent loop's turns with its `agentId`, and the
mod's `turn.start` handler reset the whole per-turn state without looking at it: a background planner's own first turn
emptied the main turn's delegate list, hints, gate events, edits and turn id. One guard line fixes it (43a4fc3), a
regression test drives the exact sequence (Agent call in the background, the subagent's `turn.start`, the main
`turn.complete`, the subagent's `turn.complete`), and the spick arm was rerun under the fixed mod before grading. The
mod's suite had never fired a subagent `turn.start`, which is why 273 passing tests did not see it. The same bug let the
gate send back a turn whose deep delegate was still running, since it saw no delegate at all. Three checklist tests
that still quoted pre-v2.1 wording were updated in the same commit.

The rerun confirms the fix in the real engine: every delegating run now records its delegate with lane, model, effort
and status, a background agent adds a late line with its usage, and the hints survive (`design` on T5, `review` on T9,
`judgement` on T4 and T7, `code` on T3, T8 and T10).

**The work trees sat inside the checkout, and the checkout's git log named a T9 answer.** Claude Code adds the
repository's git status and recent commit titles to a session started inside a work tree. The out dir was
`results/` under the harness, so every one of the 210 sessions carried that block; for nine tasks it is a few hundred
tokens of noise paid equally by every arm, but T9 asks for a review of this checkout's own mod, and from 16:07 on the
first line of the block read "43a4fc3 mod: a subagent's own turn.start no longer resets the main turn's state". From
then on most T9 answers led with that defect and several quoted the hash. `run.py` now refuses an out dir inside a
git work tree (default `~/spick-ab/results`, d376412); a probe session in the new place carries no git block at all
(checked in its transcript). T9 was rerun there for all seven arms, and because the wiped `turn.start` is a real
defect of the reviewed snapshot, the key lists it as K5, weighted like K1 and K2; a clean answer must find it unaided.

**The judges were not hermetic either.** The T9 rubric pointed at `tasks/T9/key.md` by path. The Codex judge, with
read-only access and the judge directory inside the checkout as its cwd, read the real key; the Claude judge, with no
tools, could not, and wrote that it inferred the five defects "from recent commits" (the same git block, since its cwd
was inside the checkout too), four of its five guesses being wrong. Its T9 scores in the first grading were scores
against an invented key. `grade.py` now inlines a task's key file into the rubric and runs both judges in a fresh
temp directory outside any repository (09feabc); all three judged tasks were rejudged that way, and only those
verdicts are reported below.

## 2. Setup

| arm | model | spick | Agent tool | probe |
|---|---|---|---|---|
| `haiku-spick` | Haiku | checkout mod via `--plugin-dir`, v2 agents, hooks on | yes | record, verified at 43a4fc3 (rerun) |
| `haiku-hook` | Haiku | bash hook only (the user's global hook is this checkout's file), v2 agents | yes | best effort |
| `haiku-bare`, `sonnet-bare`, `opus-bare` | one model | none; `--disallowedTools Agent` | no | no-record, verified |
| `sonnet-free`, `opus-free` | one model | none; the global CLAUDE.md block visible, global agents present | yes | no-record, verified |

Tasks T1-T10 as in `tasks/tasks.json` (two chores, four bugs with hidden tests of which T8 spans three files and T10
is width-aware wrapping, a 600-character design, a formal brief graded by rules, a two-script verdict with a planted
trap, and a 2,450-line review of the mod itself with a key of four known defects). Three runs per cell, `--parallel 3`,
15-minute timeout, no timeouts or unparsed results in 240 runs (210 plus the 30-run rerun). `claude` 2.1.302, Max
plan; costs are Claude Code's `total_cost_usd` (list price), judges excluded.

Judges: Codex `gpt-6-astra` at medium effort (`codex exec`, read-only) and Opus 5.5 through `claude -p` with no
tools; both see every answer of a task under the same shuffled letters, label and `Kept:` lines cut; Codex decides
pass, the Opus scores are reported next to it.

## 3. Cost and time

Mean `total_cost_usd` per run, three runs per cell; the last row is the arm's spend over all 30 runs.

| task | haiku-bare | haiku-hook | haiku-spick | sonnet-bare | sonnet-free | opus-bare | opus-free |
|---|---|---|---|---|---|---|---|
| T1 chore-count | 0.013 | 0.013 | 0.015 | 0.203 | 0.222 | 0.361 | 0.420 |
| T2 chore-qa | 0.006 | 0.007 | 0.007 | 0.108 | 0.126 | 0.217 | 0.246 |
| T3 code-fix | 0.011 | 0.017 | 0.016 | 0.194 | 0.236 | 0.391 | 0.427 |
| T4 debug-lru | 0.011 | 0.012 | 0.014 | 0.169 | 0.185 | 0.381 | 0.410 |
| T5 plan-backup | 0.007 | 0.171 | 0.172 | 0.125 | 0.355 | 0.255 | 0.269 |
| T6 formal-brief | 0.007 | 0.036 | 0.040 | 0.117 | 0.325 | 0.250 | 0.268 |
| T7 verdict-compare | 0.011 | 0.011 | 0.014 | 0.158 | 0.323 | 0.348 | 0.439 |
| T8 multi-file | 0.012 | 0.076 | 0.073 | 0.224 | 0.309 | 0.421 | 0.481 |
| T9 long review | 0.069 | 0.734 | 0.740 | 0.489 | 1.099 | 0.993 | 0.973 |
| T10 wrap bug | 0.015 | 0.018 | 0.021 | 0.190 | 0.268 | 0.412 | 0.435 |
| **30 runs** | **0.49** | **3.29** | **3.33** | **5.93** | **10.34** | **12.09** | **13.10** |

Read with the fixed context in mind: T2 is one turn with no tool call, so its cost is close to the price of opening a
session on this machine for each model (Haiku $0.006, Sonnet $0.11, Opus $0.22). Everything an arm does is on top of
that floor, and the floor is the same for the spick arm and the bare Haiku arm.

- spick against the strong baselines: -44% on `sonnet-bare`, -68% on `sonnet-free`, -72% on `opus-bare`, -75% on
  `opus-free`.
- spick against the lone Haiku worker: 6.8x. Two cells make the difference: T9 ($0.74 a run, 67% of spick's whole
  spend; the late lines show $0.61-0.88 of it is the Opus `deep` review itself) and T5 ($0.17, the Opus planner). On
  the other eight tasks spick costs $0.025 a run against haiku-bare's $0.011.
- `haiku-hook` (the bash hook alone, no mod) spends $3.29 to spick's $3.33 at the same delegation pattern: the mod's
  enforcement (guard, gate, records) adds no measurable cost.
- Wall time: spick's mean is 52 s a run against 27 s for `sonnet-bare` and 31 s for `haiku-bare`; a delegated task
  takes 44-74 s where the bare arms take 20-30 s, and T9 takes 208 s (the Opus review itself, 171-255 s) against 106 s
  for a bare Sonnet or Haiku and 119-124 s for bare or free Opus.

## 4. What the spick arm did, from its turn records

| task | hint | what happened in 3 runs | cost a run |
|---|---|---|---|
| T1, T2 | none | main session, no delegate | 0.015, 0.007 |
| T3 one-file bug | code | main session edited `stats.py` itself 3/3 (one file, inside the guard's cap); no coder | 0.016 |
| T4 one-file bug | judgement, code | main session edited `lru.py` 3/3; `Kept:` line 2/3 (gate: kept) | 0.014 |
| T5 design | design | Opus planner 3/3 (effort medium, high, high), in the background | 0.172 |
| T6 formal brief | none | kept with a `Kept:` line 2/3; Opus deep 1/3 ($0.105 against $0.008) | 0.040 |
| T7 two-script verdict | judgement | kept 3/3 with a `Kept:` line naming the size (61 lines) | 0.014 |
| T8 three-file feature | code | Sonnet coder 3/3 (high, medium, medium); a Haiku general-purpose helper 1/3 | 0.073 |
| T9 2,450-line review | review | Opus deep at high 3/3 | 0.740 |
| T10 wrap bug | code | main session fixed it 2/3; Haiku coder 1/3 (plus a Haiku helper) | 0.021 |

No gate send-back, no escalation line, no second failure. The judgement hint on T4 and T7 ended as `Kept:` lines, as
the v2.1 size rule says for small material. The v2.2 rule for a failing-test bug (a Haiku coder first) was followed
once in nine chances (T10 run-3); the Haiku main session took the one-file bugs itself the other eight times, under the
guard's one-file cap. Delegates run in the background by default, so a delegating run is two or three main turns in
the record (the Agent call, then the turn the result's task notification starts); the label line is printed at the end
of the first.

## 5. Quality

Pass is the hidden tests or the exact check on T1-T4, T8 and T10, the rules on T6, and a Codex overall of 4 or more on
T5, T7 and T9. Three runs per cell; the Opus judge's scores sit next to Codex's below.

| task | haiku-bare | haiku-hook | haiku-spick | sonnet-bare | sonnet-free | opus-bare | opus-free |
|---|---|---|---|---|---|---|---|
| T1-T4, T8, T10: six tasks with tests or exact checks | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| T6 formal brief (rules) | 3/3 | 3/3 | 3/3 | 2/3 | 2/3 | 2/3 | 1/3 |
| T5 design (judged) | 0/3 | 2/3 | 2/3 | 1/3 | 2/3 | 0/3 | 2/3 |
| T7 two-script verdict (judged) | 0/3 | 2/3 | 0/3 | 1/3 | 3/3 | 3/3 | 3/3 |
| T9 2,450-line review (judged) | 0/3 | 0/3 | 1/3 | 0/3 | 1/3 | 0/3 | 0/3 |
| **all 30** | **21** | **25** | **24** | **22** | **26** | **23** | **24** |

Judge means, Codex / Opus, three runs per cell:

| task | haiku-bare | haiku-hook | haiku-spick | sonnet-bare | sonnet-free | opus-bare | opus-free |
|---|---|---|---|---|---|---|---|
| T5 | 3.00 / 3.33 | 3.67 / 4.33 | 3.67 / 4.00 | 3.33 / 3.33 | 3.67 / 4.33 | 3.00 / 3.33 | 3.67 / 4.00 |
| T7 | 3.00 / 3.67 | 3.67 / 3.67 | 3.00 / 3.67 | 3.33 / 4.00 | 4.00 / 4.67 | 4.00 / 5.00 | 4.00 / 5.00 |
| T9 | 2.33 / 2.33 | 3.00 / 3.00 | 3.33 / 3.33 | 2.67 / 3.00 | 3.33 / 3.33 | 3.00 / 3.00 | 3.00 / 3.00 |

The two judges put all 63 judged answers within one point of each other (Opus runs 0.36 higher on average). Before
the hermetic fix it was 53 of 63, with every miss on T9.

- **The six programmatic tasks do not separate the arms**: 126 passes of 126. They separate cost only. spick's own
  one-file fixes (T3, T4, T10) passed 9 of 9 hidden-test runs, its Sonnet coder on T8 3 of 3; the lone Haiku passed
  all of them as well.
- **T6**: Haiku keeps a 150-250 character brief inside the limit; Sonnet and Opus overshoot in 4 of 12 runs (254-327
  characters). spick 3 of 3, one of them through deep.
- **T5**: the planner route is the best cell (3.67 / 4.00), level with the free arms, which also hand the design to
  Opus, and above bare Opus (3.00 / 3.33), at $0.17 a run against $0.27-0.36.
- **T7**: the kept verdict scores a steady 3 under Codex and 3.67 under Opus; an Opus verdict (the free arms, bare
  Opus) scores 4 and 4.67-5.00. Every arm found the planted trap; the point is lost on fairness to the weaker script
  and on length. The point costs $0.30: $0.014 a run kept, $0.32-0.44 delegated or on bare Opus.
- **T9**: the deep route is the best cell together with free Sonnet's deep route (3.33 / 3.33, one pass each), above
  bare and free Opus (3.00) and well above bare Sonnet (2.67 / 3.00) and bare Haiku (2.33), at $0.74 a run against
  $0.97-1.10 for the Opus arms. No arm found K2 or K4. K5, the wiped `turn.start`, was found unaided by the deep route
  in 2 of 3 spick runs and 3 of 3 hook runs, by free Opus in 2 of 3, bare Sonnet in 1 of 3, bare Opus and bare Haiku
  in none.
- **Totals**: spick 24 of 30, level with free Opus, one above bare Opus, two above bare Sonnet, three above bare
  Haiku; two below free Sonnet and one below the hook-only arm, and every one of those deficits is T7.

## 6. What this changes

**The thesis holds, with one named exception.** On these ten tasks a Haiku session under spick matches the Opus
baselines on quality (24 of 30 against 23 and 24) at a quarter of their cost, and beats bare Sonnet (22) at 44% less.
Against a lone Haiku worker it costs 6.8x, all of it in the two cells where it buys Opus (T5, T9), and in both it is
the best or joint-best arm. The exception is the small verdict: the v2.1 size rule keeps T7 on Haiku, which scores one
point below an Opus verdict under both judges, for $0.30 a verdict less. The rule stands and the trade is recorded
here for the owner; a `/spick` switch that sends small verdicts to deep for a session would make it a choice rather
than a policy.

**Routing policy v2.3, one change that codifies what passed.** The v2.2 rule "a bug with a failing test goes to a
Haiku coder first" was followed once in nine chances; the Haiku main session fixed the one-file bugs itself, under
the guard's one-file cap, and passed 9 of 9. The rule now says so: a one-file bug with a failing test stays in the
main session and the test is the check; code beyond one file goes to the coder, a failing-test bug there to a Haiku
coder first. Nothing is rerun for it: it describes the behaviour the matrix measured.

**What it leaves open.**

- The multi-file code route (T8) went to a Sonnet coder 3 of 3 at $0.073; a lone Haiku passed the same hidden tests
  3 of 3 at $0.012. Whether a Haiku coder with the test as its check does as well inside spick is the next cheap
  experiment (nine runs). Done the same day: section 7.
- Delegates run in the background by default, so a delegated task spans two or three main turns in a headless
  session and the guard's and gate's per-turn facts are split across them. The records are right since 43a4fc3; the
  shape still deserves a design note.
- n is 3: one run moves a judged cell by a third of a step, and the pass threshold of 4 on T9 leaves most cells at
  0 of 3; read the means there.
- The Explore-on-Haiku override is still unexercised: no task made any arm spawn an Explore agent (0 of 210).
- The fixed context on this machine (about 61k tokens a session) compresses every ratio; the harness keeps the
  user's real settings by design, and a lean-context ablation is a separate run.
- Nothing here tests leak safety, long sessions, or tasks outside these ten.

**What the day cost.** The matrix as reported is $48.6 at list price (sum of the seven arm totals); with the first
spick pass, the contaminated T9 cells and the judge calls that were thrown away, about $80. The Max plan's 7-day
meter went from 9% to 34%.

## 7. T8 follow-up: a Haiku coder first for checked multi-file code (policy v2.4)

The first open question above, run the same day. The coder bullet now reads: code beyond one file with tests goes to
`Agent(coder, model haiku)` first, the test is the check, a failed check sends it to `Agent(coder)` at high, and code
without a check keeps the Sonnet coder (`rules.json`, rendered into the checklist, the mod, `SKILL.md` and the CLAUDE.md
block; budgets unchanged). The `haiku-spick` arm was rerun under that text on the four hidden-test tasks: 12 runs,
`--parallel 3`, `claude` 2.1.302, out dir `~/spick-ab/t8-haiku`, probe verified (record at 669fdba with the v2.4 text
in the working tree). Hidden tests grade every cell; no judge. The report, grades and probe are copied to
`skills/spick/evals/ab/samples/t8-haiku-2026-10-17/`. "Before" is the spick arm of the full matrix above (v2.3 text,
section 4); costs are mean `total_cost_usd` a run, wall is the mean.

| task | before: pass, cost, wall | after: pass, cost, wall | what the turn records show after |
|---|---|---|---|
| T8 three-file feature | 3/3, $0.073, 44 s | 3/3, $0.022, 45 s | Haiku coder at medium 3/3; no second coder, no Sonnet, no failed check |
| T3 one-file bug | 3/3, $0.016, 32 s | 3/3, $0.016, 30 s | main session 3/3, as before |
| T4 one-file bug | 3/3, $0.014, 27 s | 3/3, $0.050, 36 s | main session 2/3; Opus `deep` at medium 1/3 ($0.121: judgement hint, gate `delegated`) |
| T10 wrap bug | 3/3, $0.021, 39 s | 3/3, $0.021, 47 s | main session 3/3 (the matrix had a Haiku coder 1/3) |

- **T8 holds at 30% of the cost.** 3 of 3 hidden-test passes with a Haiku coder, $0.022 a run against $0.073 with
  the Sonnet coder; the fallback to Sonnet at high never fired, since no run had a failed check. A lone Haiku did the
  same work for $0.012, so the remaining $0.010 is the handoff itself (the brief, the coder's own context, the relay),
  not the model. The rule is kept: policy v2.4.
- **The one-file cells did not move**, except that one T4 run went to `deep` for the root-cause explanation the prompt
  asks for (the `judgement` hint on "root cause"; the matrix kept all three with `Kept:` lines in two). That is the
  v2.1 size rule's variance at n=3, not the coder bullet, which does not apply to a one-file bug; the run passed and
  cost $0.12.
- **Limits.** n=3 per cell; one task is multi-file, and its three files are 38 lines in all. The arm reads this
  machine's global `~/.claude/CLAUDE.md`, whose routing block predates the Haiku coder, and the skill directory it can
  load is a symlink to the main checkout, so the checklist from the mod is what carried the new rule; both held in the
  matrix as well. A failed check, and so the Sonnet escalation, was never exercised; nothing here says what happens on
  a multi-file task a Haiku coder gets wrong.

