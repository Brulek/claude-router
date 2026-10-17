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
| `haiku-spick` | haiku | off | checkout's `mod/spick-dashboard` via `--plugin-dir` | yes | yes |
| `haiku-bare` | haiku | off | off | no | no |
| `sonnet-bare` | sonnet | off | off | no | no |
| `opus-bare` | opus | off | off | no | no |
| `haiku-hook` (ablation) | haiku | checkout's `triage-hook.sh` | off | yes | yes |
| `sonnet-free`, `opus-free` | sonnet / opus | off | off | no | yes |

The default matrix is the first four. `*-bare` arms are single-model baselines; `*-free` arms are the fair strong baselines, a big model that may delegate but has no spick. Flags per arm (see `run.py` `build_cmd` and `arm_settings`):

- every arm: `--output-format json --permission-mode acceptEdits --model <alias>` and `--settings` with `{"enabledPlugins": {"spick-dashboard@spick": false}}`, which turns off the globally installed mod (the key is `GLOBAL_MOD_KEY` in `common.py`, taken from `~/.claude/plugins/installed_plugins.json`);
- hooks off: `"disableAllHooks": true` in that settings file, which keeps the user's global v1 hook out;
- `haiku-spick`: `--plugin-dir <checkout>/mod/spick-dashboard` and `--agents` rendered from `skills/spick/assets/agents/*.md`; the mod injects the checklist itself, so no bash hook;
- `haiku-hook`: hooks stay on and `--settings` adds the hook of this checkout;
- bare arms: `--disallowedTools Agent`; arms with the Agent tool add `Agent` to `--allowedTools`.

The allowed-tools list is the old runner's: Read, Edit, Write, Glob, Grep and Bash for python3, pytest, ls, cat, wc, head, echo, date, sort, shasum.

## Run it

From `skills/spick/evals/ab/`:

```
python3 run.py --setup                      # creates .venv with pytest (gitignored)
python3 run.py --arms haiku-spick,haiku-bare,sonnet-bare,opus-bare --runs 3 --parallel 2 --out results/
python3 grade.py results/                   # hidden tests, rules, and one Codex judge call per judged task
python3 report.py results/                  # writes results/REPORT-<date>.md
```

Add `haiku-hook,sonnet-free,opus-free` to `--arms` for the full seven-arm matrix. Useful flags: `--tasks T1,T2`, `--timeout 900` (seconds per run), `--force` (redo finished runs; without it a rerun skips cells that have a `result.json`), `--dry-run` (print commands only), `--claude-bin` (a stub for pipeline tests). `grade.py` takes `--no-judge` and `--rejudge`. Unit tests, from the repo root: `python3 -m unittest discover -s skills/spick/evals/ab -p 'test_*.py'`.

The full default matrix is 8 tasks x 4 arms x 3 runs = 96 runs, and the Opus arm and the judge are the expensive parts. Run `--tasks T1,T2` first to see the shape.

## What a run leaves

`<out>/<arm>/<task>/run-<n>/` holds `work/` (the tree as the agent left it) and `result.json`: the `claude -p` JSON (`result`, `total_cost_usd`, `modelUsage`, `num_turns`, `subagent_stats`), wall time, exit code, timeout flag, and for spick arms the lines of `~/.claude/spick/turns/<sessionId>.jsonl` if the mod wrote them (absent is normal in headless runs). `grade.py` adds `grades.json` and `judge/` (raw judge output and the letter-to-run key); `report.py` adds the report. `samples/` in this folder is a one-run example of that shape.

The judge sees every answer of a task at once under shuffled letters, with the `[Model:` label line and any `Kept:` line cut, so it cannot tell the arms apart. The key stays in `judge/<task>.key.json`.

## Limits

- `claude -p` loads the user's global `~/.claude/CLAUDE.md`, so bare arms still read the spick routing block; `--disallowedTools Agent` stops them acting on it. `*-free` arms may act on it. The global `~/.claude/agents` are present in every arm.
- The harness never edits `~/.claude`. Running `claude` still writes its own session files there.
- Known limit on this machine: a global marker file (`~/.claude/.spick-mod-active`, or `~/.claude/spick/mod-active/<sessionId>` in v2) can silence the hook of this checkout, and the user's global v1 hook may print in `haiku-hook` as well. `haiku-hook` is therefore a best-effort arm. The v1 hook of this checkout was not worked around.
- `haiku-spick` assumes `disableAllHooks: true` leaves the mod's own prompt hook alone and that `--plugin-dir` is not undone by the disabled global key. This could not be confirmed offline; check the Explore and turn-record columns of the report after the first real run.
- Costs are Claude Code's `total_cost_usd`. Outside-CLI delegates (Gemini, Grok, Codex) are not in it; the report marks such cells `>=`. The judge is priced separately and its cost stays unknown.
- One judge, small n, no cross-session cache effects, no leak testing. The report ends with "What this matrix cannot show".
- Each run has a 15-minute timeout; the whole process group is killed on expiry.
