# spick A/B harness

Runs the same eight small tasks through `claude -p` under different configurations and compares quality, completion, cost and wall time. Python standard library only; the one dependency, pytest, lives in a private venv the harness creates.

## Tasks

`tasks/tasks.json` lists them; each has a template folder (the starting work tree), a grader kind and an ideal tier.

| id | task | grader | ideal |
|---|---|---|---|
| T1 | chore-count: count lines of `.txt` files into a CSV | exact CSV | haiku |
| T2 | chore-qa: weekday of a date | exact text | haiku |
| T3 | code-fix: `median` of an even list | hidden tests | sonnet |
| T4 | debug-lru: LRU `put` does not refresh recency | hidden tests | opus |
| T5 | plan-backup: a backup design, 600 characters | blind judge | opus |
| T6 | formal-brief: a formal paragraph with placeholders | rules (length, placeholders, forbidden words) | opus |
| T7 | verdict-compare: which of two shell scripts handles errors better | blind judge | opus |
| T8 | multi-file feature: tags across three modules | hidden tests | sonnet |

T1-T6 come from the older `mode-compare` workspace. T7 has a planted trap (`set -e` plus `((removed++))` in the script that looks stricter); T8's prompt says to implement without asking, because the skill's plan-mode rule would otherwise stop a headless session on a multi-file task. Hidden tests live under `tasks/Tn/hidden/` and are copied into the work tree only while grading, so the agent never sees them; the visible tests must be byte-identical to the template (sha256) or the run fails.

## Arms

| arm | model | hooks | mod | spick agents | Agent tool |
|---|---|---|---|---|---|
| `haiku-spick` | haiku | on (the mod's marker silences the user's spick hook) | checkout's `mod/spick-dashboard` via `--plugin-dir` | yes | yes |
| `haiku-bare` | haiku | off | off | no | no |
| `sonnet-bare` | sonnet | off | off | no | no |
| `opus-bare` | opus | off | off | no | no |
| `haiku-hook` (ablation) | haiku | checkout's `triage-hook.sh` | off | yes | yes |
| `sonnet-free`, `opus-free` | sonnet / opus | off | off | no | yes |

The default matrix is the first four. `*-bare` arms are single-model baselines; `*-free` arms are the fair strong baselines, a big model that may delegate but has no spick. Flags per arm (see `run.py` `build_cmd` and `arm_settings`):

- every arm: `--output-format json --permission-mode acceptEdits --model <alias>` and `--settings` with `{"enabledPlugins": {"spick-dashboard@spick": false}}`, which turns off the globally installed mod (the key is `GLOBAL_MOD_KEY` in `common.py`, taken from `~/.claude/plugins/installed_plugins.json`);
- hooks off (bare and free arms): `"disableAllHooks": true` in that settings file, which keeps the user's global hook out;
- `haiku-spick`: `--plugin-dir <checkout>/mod/spick-dashboard` and `--agents` rendered from `skills/spick/assets/agents/*.md`; the mod injects the checklist itself, so no bash hook is added. Hooks stay on in this arm: `disableAllHooks` disables the mod's own handlers as well (measured on 2026-10-17 with `claude` 2.1.302: no turn record, no marker), and the mod's per-session marker (`~/.claude/spick/mod-active/<sessionId>`) is what silences the user's global spick hook;
- `haiku-hook`: hooks stay on and `--settings` adds the hook of this checkout, unless the user's global settings already run that very file (a symlinked install, `~/.claude/skills/spick -> <checkout>`), in which case it is not added a second time; the probe line says which;
- bare arms: `--disallowedTools Agent`; arms with the Agent tool add `Agent` to `--allowedTools`.

The allowed-tools list is the old runner's: Read, Edit, Write, Glob, Grep and Bash for python3, pytest, ls, cat, wc, head, echo, date, sort, shasum.

## Run it

From `skills/spick/evals/ab/`:

```
python3 run.py --setup                      # creates .venv with pytest (gitignored)
python3 run.py --arms haiku-spick,haiku-bare,sonnet-bare,opus-bare --runs 3 --parallel 2 --out ~/spick-ab/full
python3 grade.py ~/spick-ab/full                   # hidden tests, rules, and one blind judge call (Codex) per judged task
python3 grade.py ~/spick-ab/full --judges codex,claude   # add a second judge, Opus through `claude -p` with no tools; the first named decides pass
python3 report.py ~/spick-ab/full                  # writes <out>/REPORT-<date>.md
```

The out dir must sit outside any git work tree (the default is `~/spick-ab/results`; `run.py` refuses one inside a repository unless `--allow-in-repo` is given): a session started inside a repository reads its git status and recent commit titles, and on 2026-10-17 the T9 answers quoted the commit that had fixed the very defect they were asked to find. Add `haiku-hook,sonnet-free,opus-free` to `--arms` for the full seven-arm matrix. Useful flags: `--tasks T1,T2`, `--timeout 900` (seconds per run), `--force` (redo finished runs; without it a rerun skips cells that have a `result.json`), `--dry-run` (print commands only), `--claude-bin` (a stub for pipeline tests), `--allow-unverified` and `--probe-timeout 180` (see the next section). `grade.py` takes `--judges` (default `codex`), `--no-judge` and `--rejudge`. Unit tests, from the repo root: `python3 -m unittest discover -s skills/spick/evals/ab -p 'test_*.py'`.

The full default matrix is 8 tasks x 4 arms x 3 runs = 96 runs, and the Opus arm and the judge are the expensive parts. Run `--tasks T1,T2` first to see the shape.

## Start-up probe

Before the matrix, `run.py` makes one call per selected arm with the prompt `Reply with exactly OK.` and checks from the turn-record directory that the arm started as configured. It reads the session id from the result JSON and looks for `~/.claude/spick/turns/<session_id>.jsonl`:

| arm | expected | what it proves |
|---|---|---|
| `haiku-spick` | a record with `schemaVersion: 2` appears | the checkout's mod ran (the global copy is disabled, so it cannot have written a v2 record) |
| `*-bare`, `*-free` | no record file for the session | the global mod stayed disabled |
| `haiku-hook` | accepted, best effort | a bash hook leaves no trace the harness can read, so only "the call worked" is checked |

A failed probe (the call itself failed, or the record is missing or unexpected) marks the arm invalid and stops the run with a message, because its results would not mean what the arm name says. `--allow-unverified` goes on anyway; the arm then stays invalid in the files below. The probe results, `claude --version` and the checkout's `git rev-parse HEAD` go to `<out>/_probe.json`, which holds the latest invocation's probe only, and `report.py` shows them under Caveats, with the arm marked INVALID, "verified" or "accepted, not verified". Each run also keeps the probe it was made under in its own `result.json` (`meta.probe`: the outcome, `claude --version`, the HEAD), because a resumed run skips cells that already have a `result.json`: the per-task table marks a cell verified only when every run in it passed its probe at the same HEAD, and reads "mixed (n of m verified at HEAD x)" otherwise. Without a `_probe.json` the report says no probe was recorded. The mod writes its record at turn end, so the probe waits a few seconds after `claude` exits before it decides. A pipeline-test stub passed with `--claude-bin` fails the `haiku-spick` probe unless it writes a v2 record; use `--allow-unverified` with such stubs.

## How runs are scored

- **Errors are never passes.** A run is an error, with `error_reason` recorded in `grades.json`, when `claude` exited non-zero, the result JSON has `is_error: true`, the run timed out, or no result JSON could be parsed. Such a run fails whatever its answer text says and is left out of the judge's answers.
- **Unknown cost.** A cell's (or arm's) `cost_total` and `cost_per_success` are `null` when some of its runs carry no priced `total_cost_usd`, with `cost_coverage` = priced runs / runs; the report prints `unknown (n/m priced)`. A sum over the priced runs alone is never shown as the total. A run with any outside-CLI delegate (Gemini, Grok, Codex) or any delegate in its turn record without a `costUsd` keeps `cost_floor: true`, and the report prints the number with `>=`. A spick-arm run (haiku-spick, haiku-hook) without its turn record has `cost_floor: null`: its delegates cannot be counted, so a missing record is not read as zero calls. The report prints such a cost with `? (k/n floor unknown)`, counting those runs, in every cell and arm row that has one.
- **Explore on Haiku.** `explore_haiku` is `true` only when the result's `subagent_stats.by_type` names an Explore-type agent whose model is Haiku; when that names no model (or the key is absent) the turn record's `delegates[]` is used. `false` means Explore did not run or ran on another model (a Haiku main session plus a Sonnet Explore agent is `false`; a Haiku line in `modelUsage` is not evidence). `"unknown"` means no source names the agent's model; the report counts those separately and does not count them as passes.

## What a run leaves

`<out>/<arm>/<task>/run-<n>/` holds `work/` (the tree as the agent left it) and `result.json`: the `claude -p` JSON (`result`, `total_cost_usd`, `modelUsage`, `num_turns`, `subagent_stats`), wall time, exit code, timeout flag, the start-up probe of its invocation (`meta.probe`), and for spick arms the lines of `~/.claude/spick/turns/<sessionId>.jsonl` if the mod wrote them. The out dir also holds `_probe.json` and `_probe/<arm>/work/` (the probe calls). `grade.py` adds `grades.json` and `judge/` (raw judge output and the letter-to-run key); `report.py` adds the report. `samples/` in this folder is a one-run example of that shape.

The judge sees every answer of a task at once under shuffled letters, with the `[Model:` label line and any `Kept:` line cut, so it cannot tell the arms apart. The key stays in `judge/<task>.key.json`; raw verdicts are `judge/<task>.txt` (Codex) and `judge/<task>.claude.txt`. With two judges both see the same letters; the first judge named in `--judges` decides pass, and the report's Second judge section shows each judge's mean per cell and how many runs the two score within one point of each other.

## Limits

- `claude -p` loads the user's global `~/.claude/CLAUDE.md`, so bare arms still read the spick routing block; `--disallowedTools Agent` stops them acting on it. `*-free` arms may act on it. The global `~/.claude/agents` are present in every arm.
- The harness never edits `~/.claude`. Running `claude` still writes its own session files there.
- `haiku-hook` is a best-effort arm: a stale per-session marker (`~/.claude/spick/mod-active/<sessionId>`, kept a day) could silence the hook, and on a machine whose global hook is a different spick copy both hooks print. With a symlinked install the global hook is this checkout's file and the harness does not add it twice.
- Measured on 2026-10-17 (`claude` 2.1.302): `disableAllHooks: true` disables the mod (no turn record, no marker), the `enabledPlugins` key alone does not, and `--plugin-dir` is honoured next to it; `haiku-spick` therefore leaves hooks on. The marketplace `spick` is installed from the checkout directory itself, so the "global" mod is this same code: the `enabledPlugins` key is what keeps it out of a run, and the probe's record check means something only because of it. The probe passed against a real `claude` for the first time on that date.
- The `*-free` arms still read the user's global `~/.claude/CLAUDE.md`, which may carry the spick routing block. They are strong-model baselines with spick's instructions visible but no spick tooling (no mod, no hook, no spick agents); read them as "big model that may delegate on its own", not as "a model that has never heard of spick".
- Costs are Claude Code's `total_cost_usd`. Outside-CLI delegates (Gemini, Grok, Codex) are not in it; the report marks such cells `>=`. The judge is priced separately and its cost stays unknown.
- One judge by default (a second one, Opus through `claude -p`, with `--judges codex,claude`), small n, no cross-session cache effects, no leak testing. The report ends with "What this matrix cannot show".
- Each run has a 15-minute timeout; the whole process group is killed on expiry.
- Git context: a work tree inside a repository gives every session that repository's status and recent commits (Claude Code adds them to the context). The first full run on 2026-10-17 had its out dir inside this checkout; T9, whose material is this checkout's own mod, was contaminated from the commit that fixed the turn.start defect onward and was rerun outside the repository. The other tasks only paid the same few hundred tokens in every arm.
