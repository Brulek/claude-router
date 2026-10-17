# Changelog

User-visible changes. The skill (`skills/spick`) and the dashboard mod (`mod/spick-dashboard`) share one version
number from 1.0.0 on (`skills/spick/assets/VERSION`, the mod's `plugin.json`).

## 1.0.0 - 2026-10-17

Version 1.0.0 gathers review round 1 (2026-10-16) and v2 (design: `docs/superpowers/specs/2026-10-17-spick-v2-design.md`).
After updating, run `spick setup` once: the hook says so (`spick: skill 1.0.0 installed ..., run spick setup`) until you do.

### Routing policy

- One source for the policy: `skills/spick/assets/rules.json` holds the routing order, the effort defaults, the Hint
  keywords, negations and phrases, the checklist text and the overhead budget. `scripts/render_rules.py` renders the
  hook's checklist (`assets/checklist.txt`), the mod's checklist and hint text, and the tables in `SKILL.md` and the
  CLAUDE.md block; `--check` fails on drift. The hook, the mod, the skill and the block now list the kinds in one
  order: outside lanes, verdict, decision, code, review, the main session last.
- Small work is not dispatched: a lookup or a one-file edit with a clear goal stays in the main session, and a
  verdict whose answer is a fact on disk may be kept with a `Kept:` line. When the difficulty is unclear, `deep`
  still takes it.
- The planner threshold is narrow: architecture, a public interface, a data format or a cross-module trade-off.
  Local layout, naming and which file to touch are `coder`'s own calls.
- The brief is a handoff packet: goal, workspace state, verified findings, failed approaches, remaining work, the
  user's hard constraints verbatim, done-when checks. Never the main session's own trail.
- Delegates (`coder`, `planner`, `deep`) end with an `Evidence` block of at most 15 lines (checks run, files changed,
  limits); longer logs go to a file the block names. The main session strips openers and closers only and keeps the
  Evidence block and any stated limitation.
- Escalation on facts: the same check failing twice in a turn goes to `coder` at high effort, or to `deep` when the
  cause is unknown.
- A headless session whose prompt already says to proceed ("do it", "直接做") runs without the plan stop.
- `deep` defaults to medium effort; the effort table says when to raise it (round 1).
- With no search lane, a search goes to a Sonnet `general-purpose` agent with WebSearch, not to `deep`; judging the
  findings stays `deep`'s (round 1).
- The CLAUDE.md routing block applies to the main conversation only; each agent file says to ignore it (round 1).
- Shipped text names no machine-specific Codex model: `Review: Codex <model> (medium)` (round 1).
- `SKILL.md` stays under 2,000 words; reference sections live in `references/` (round 1). The CLAUDE.md block stays
  under 30 lines and 450 words, the checklist under 14 lines and 320 words (`test_rules.py`).

### Hint line

- Fenced code blocks, URLs and path-like tokens (`src/review.py`, `~/x`, `./y`) are blanked before matching, so
  keywords read out of a path or pasted code no longer fire. A URL still counts as a web sign.
- A keyword right after a negation (不要, 别, 不用, 无需, don't, do not, no need to, without; within six characters)
  does not fire. A negation inside a keyword (不要 in 要不要) is not one.
- `scripts/testdata/hint_corpus.json`: 50 labelled prompts, Chinese and English, passed by both `triage_hint.py` and
  the mod's `hint.ts`.

### Subagents

- New `Explore` subagent on Haiku (effort low; tools Read, Grep, Glob, Bash), installed by setup unless
  `--no-explore`. The Claude Code docs say a user-level `Explore` overrides the built-in one, which runs on the main
  session's model. Read-only is the tool list, not a permission.

### Outside lanes (`scripts/invoke.py`)

- The data level fails closed: a call above the lane's declared `data` exits 6 and sends nothing. Without
  `--contains` the prompt counts as `code`; under a `text` or `public` declaration, code-looking content in the prompt
  or the system file is refused too. `--override-data "<reason>"` sends anyway and prints the reason; it is for the
  user's explicit say-so only. Every prompt call is logged to `<config>/spick/invoke.jsonl` (lane, model, declared
  and sent level, override reason, exit code, tokens, seconds; never the key) and `/spick audit` lists the period's
  overrides. This is a declared limit, not sensitive-data detection.
- An answer cut off at the token limit (`finish_reason=length`, `stop_reason=max_tokens`) exits 7 with the partial
  text on stdout and `INCOMPLETE` on stderr.
- An answer in several text blocks is returned whole, not only its first block.
- `scripts/set_subscription.py` records the plan per built-in provider (what the Quota line shows); onboarding asks
  for plans (round 1).

### Setup, state and the hook

- State moves to `~/.claude/spick/` (`$CLAUDE_CONFIG_DIR/spick/` when set): `quota.json`, `quota.lock`,
  `turns/<sessionId>.jsonl`, `mod-active/<sessionId>`, `backup/`. `spick.json` stays beside `settings.json`.
  `scripts/paths.py` is the one resolver; setup moves `spick-quota.json`, `spick-spend/`, `spick-gate.jsonl` and
  `spick-backup/` there once.
- The hook stays silent only for the session whose mod marker (`mod-active/<session_id>`) is under 24 hours old, so
  a second session without the mod still gets the checklist; older markers are deleted.
- The hook prints `spick: skill X installed Y, run spick setup` when the installed version differs from the skill's.
- Setup validates `settings.json` and `spick.json` before writing anything, checks every step, exits 1 naming what
  it already changed when a step fails, and prints `done` only when every step passed. Install and uninstall need
  python3.
- `spick.json` records `efforts` (the delegates' default efforts, read by the mod) and, as the last step of a run
  that passed, `installed_version` with `installed`: which agents were written or kept, whether the hook was added,
  updated or kept, whether the block was replaced or appended. The summary lists kept agent files with the `--force`
  hint. A spick hook pointing at another checkout is updated to this one.
- The skill reads `<config>/spick.json` (`$CLAUDE_CONFIG_DIR`, else `~/.claude`), not a fixed `~/.claude/spick.json`.
- `--uninstall --purge` removes `spick.json` and the whole state directory, backups included.
- A registry with every lane switched off is no longer read as "no registry": the quota cache carries
  `registry: true|false` and the enabled `lanes`, and the checklist says no outside lane may be called and the label
  reads `Review: skipped`. With the cache missing or unreadable the mod reads the same from `spick.json`, by
  `lanes.py`'s rule; only without `spick.json` does it fall back to the built-in lanes.
- Setup writes the hook's absolute path, so a skill outside `~/.claude` or a `CLAUDE_CONFIG_DIR` still runs (round 1).
- Setup backs up `CLAUDE.md`, `settings.json` and `spick.json` before every write; uninstall removes only what the
  install wrote (0.x, kept).

### Dashboard mod

- The turn record: one JSON line per main turn in `~/.claude/spick/turns/<sessionId>.jsonl` (who ran, usage, gate,
  checks) replaces the spend files and the gate log; `/spick spend` and the new `/spick audit` read it. Delegates a
  subagent started are recorded with `parent`; a call silent for 30 minutes reads `timed-out` and, if it ends after
  all, adds a `late` line with its usage.
- The guard's edit cap is one source file per turn, judged relative to the session cwd (a worktree under
  `.claude/worktrees/` counts); a tool-level soft bound, Bash writes are not caught.
- The gate asks for the role the hint names (judgement: `deep`; review: the review lane or `deep`); one send-back per
  turn carries every reason. A review call counts only as the line's one `codex exec` or review-lane command (a diff
  piped into it allowed), with no error and at least 200 characters of output; a `deep` call counts when its
  subagent ended without failure, or, with no such event before the call returned, on its own non-empty result.
- A check counts only when the line is one simple command whose command word is the runner (one leading `cd x &&`
  and redirections allowed; a pipe, `;`, `&&` or `||` disqualifies it, since only the line's status is reported), it
  passed, and it started after the last completed source edit with no edit in flight or finishing while it ran. The
  record's `afterLastEdit` says the latter; the command is kept, as the mod cannot see what a check exercises.
- The same check failing twice adds an escalation line to the turn.
- The band shows the main loop's prompt size and warns a Haiku session past 80k tokens.
- An Agent call of `coder`, `planner` or `deep` without an effort gets the default from `spick.json`.
- Quoted CLI flags (`-m "model"`) name the model; the quota pane shows each provider's sample age.
- Round 1: the gate fires on verdicts only and logs each firing; the guard knows builds and test scripts and reads
  `guard.check_commands`; Fable 5.1 is priced in `/spick spend`; a non-Haiku session is told `/spick force` exists.

### Evaluation

- `skills/spick/evals/ab/`: an A/B harness that runs tasks T1-T8 across arms (Haiku with spick, bare Haiku, Sonnet,
  Opus) and reports pass rate, cost and time per arm, losing cells kept.

### CI

- shellcheck and ruff steps; a weekly run on the latest Claude Code (round 1).

### 1.0.0, routing policy v2.1 (2026-10-17, after the in-session A/B)

- A verdict over small material (a few files, under ~200 lines, a short text) stays with the main session, with a `Kept:` line; `deep` takes large material, money/law/interface stakes, a second failure, or a task the main session cannot size. The A/B of 2026-10-17 showed the old "every verdict to Opus" rule bought no measured quality on short tasks at 10-30x the cost.
- A bug with a failing test goes to `coder` first; `deep` only after two failed checks (the guard's escalation line).
- The Hint phrase for judgement words now says to size the material instead of starting from `deep`.
