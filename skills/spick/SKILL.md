---
name: spick
description: Triage every task to the cheapest model that can do it well. Picks the Claude tier (Haiku main session, Sonnet coder, Opus planner/deep), the effort level, and when to hand off to subscription CLIs you already pay for (Gemini for web search and long media, Grok for X/Twitter data, Codex for coding review and image generation), with a quota check so you never drain one subscription while others sit idle. Use this skill on ANY non-trivial request, not only when the user says "delegate", "route", "outsource" or "save quota" - also when they ask to write or fix code, plan something, search the web, check facts, pull X/Twitter posts, generate or edit an image, analyse a long video or PDF, or ask for a review of changes. Also use it when the user says "spick setup", "spick doctor" or "spick quota".
---

# spick: one triage for Claude tiers and outside AIs

You are (usually) a small model at the front of a Claude Code session. Decide **who** does each task, on **which model**, at **which effort**, then check the result before relaying it.

Two layers: the subagents pinned in `~/.claude/agents/` (`coder` Sonnet, `planner` and `deep` Opus, `Explore` Haiku), and outside lanes - CLIs the user already pays for (Gemini `agy`, Grok `grok`, Codex `codex`) plus any `lane_registry` lane (`references/providers.md`).

Commands and the file list: `references/commands.md`. Router mod, adding an outside AI, lane failures: `references/operations.md`.

## Step 0 - is this machine set up?

Once per session: `test -f <config>/spick.json` (`<config>` is `$CLAUDE_CONFIG_DIR`, else `~/.claude`). Missing means a first run: stop routing and follow `references/onboarding.md` (also on `spick setup`; `spick doctor` re-runs detection). Else read it; never use a disabled lane. A checklist line `spick: skill X installed Y, run spick setup` means the install is stale: tell the user once.

## Step 1 - pick the lane

**Route by the shape of the deliverable, top to bottom, first match wins**: a small model cannot tell hard from easy, but it can tell a verdict from a lookup. Generated from `assets/rules.json`, like the checklist:

<!-- rules:start (generated from assets/rules.json by scripts/render_rules.py) -->
| # | Task needs | Who | Else |
|---|---|---|---|
| 1 | X / Twitter data | the lane tagged `x-data` (default Grok) | tell the user; never fake it with web search |
| 2 | image generation or editing | the lane tagged `image` (default Codex codex-image, then Gemini) | tell the user |
| 3 | long video/audio, documents far beyond ~200 pages | the lane tagged `long-context` (default Gemini) | `deep` (documents only) |
| 4 | live web, fact check, versions, prices | the lane tagged `search` (default Gemini agy) | `Agent(general-purpose, model sonnet, effort medium)` with WebSearch; judging the findings stays deep's |
| 5 | compare, evaluate, find gaps, diagnose why, review a codebase or a design, recommend, formal writing | `deep` | keep it, with a `Kept:` line, when the material is small (a few files, under ~200 lines, a short text): say so in the line |
| 6 | a change that needs an architecture, public interface, data-format or cross-module decision the user did not make | `planner` then `coder` | - |
| 7 | changed code beyond one file where the goal is clear (with tests: Haiku coder first, Sonnet at high after a failed check; without: Sonnet coder); layout, naming and file choice are the coder's | `coder` | - |
| 8 | independent review of a diff | the lane tagged `review` (default Codex) | `deep` |
| 9 | the answer is already in a file here, a command's output or your own knowledge; a one-file edit or fix | you | - |

| Delegate | Default | Other levels |
|---|---|---|
| `coder` | medium | low: one-file mechanical edit, config, comments; high: multi-file, debugging, unexplained failures, performance |
| `planner` | high | medium: three steps or fewer; xhigh: architecture, wide blast radius, real trade-offs |
| `deep` | medium | medium: ordinary verdicts: a diagnosis within one file, a comparison of two small things, a review of a small diff; high: hard problems, multi-file debugging, first drafts of formal writing; xhigh: key decisions, final drafts, money or law; max: only when the user says "extremely important" |
<!-- rules:end -->

**Not dispatching is the default for small work.** Delegation costs a handoff: brief, cold context, relay. A one-file edit, a lookup, a tidy-up: do it yourself. A verdict over small material (a few files, under ~200 lines) is yours with a `Kept:` line; large material or high stakes go to `deep`; multi-file code with tests goes to a Haiku `coder` first (`model: haiku`), Sonnet at high after a failed check. Reading files on the way does not make a verdict a lookup; unsure: `deep`.

**The planner threshold is narrow.** `planner` is for a decision the user did not make about architecture, a public interface, a data format or a cross-module trade-off. Local layout, naming and which file to touch are `coder`'s calls; send it the goal, not a design.

**The Hint line** names prompt keywords and the route they imply (words in paths, URLs, code blocks or after a negation do not count). Follow it, or keep the task with a `Kept:` line; with the mod, a hinted verdict kept without that line is sent back once at stop time.

**Outside lanes.** Among lanes tagged for the task: one whose `data:` is below what the task sends (`public` < `text` < `code`) is out; `scripts/invoke.py` refuses it (exit 6) unless you pass `--override-data "<reason>"`, only on the user's say-so; every call and override is logged (`/spick audit` lists them) - a declared limit, not a detector. Prefer matching tags, then Quota and notes; a `web-only` lane gets a paste-ready prompt. A failed or over-quota lane: choose again. "Extremely important", or beyond Opus: `deep`, then suggest switching the session to Fable.

A mixed prompt is split by kind: a lane searches, `coder` codes with the result in its brief, `deep` judges.

## Step 1b - plan mode or goal mode?

**Plan mode** (`EnterPlanMode`) is an approval gate: `planner` writes the plan, you put it in the plan file and call `ExitPlanMode`; after approval `coder` executes it. Enter it for 3+ files or several modules, an irreversible or wide action (review triggers 1-3), an ambiguous ask, a new build, or 方案 / 规划 / 怎么做 / "how should we". Not for one-file fixes, chores or questions. Headless (no `EnterPlanMode`): plan inline, state your assumptions and stop before editing - unless the prompt already says to proceed ("do it", "直接做"), then execute without the stop.

**Goal mode** you cannot enter. When the finish is machine-checkable (tests green, build ok, exit 0) and needs several edit-run cycles, or to execute an approved plan, hand the user one line in a code block:

```
/goal <the check command and its expected result>; stop after 10 attempts or if the same error repeats 3 times
```

Name the command; keep the stop guard. Waiting on CI or a deploy is `/loop`, not a goal.

## Step 2 - pick the effort

You cannot change your own session's effort; pick one for every delegate (Agent `effort`) from the table above. When torn, go higher: a redo costs more than a notch. Outside CLIs take their own flag; the level per task is in `references/providers.md`.

**Escalate on facts, not on doubt.** When the same check (test, build, lint) fails twice in a turn, stop retrying: send it to `coder` at high effort, or to `deep` when the cause is unknown, with the failing output in the brief. Your own confidence is not a signal.

## Step 3 - Codex review

After `coder` finishes, send the diff to the review lane (default Codex) if **any** trigger holds; otherwise write `Review: skipped`.

- `high` effort: 1. money, auth, keys, data deletion, anything that sends messages; 2. anything unattended (cron, startup scripts, pipelines, trading); 3. a public interface or data format others depend on.
- `medium` effort: 4. more than 3 files or ~150+ lines; 5. never exercised (no test covers it, nobody ran it), or tests fixed over several rounds; 6. `coder` hedges (`UNSURE:`, "please verify").
- Always: 7. the user asked for review or called the task important.

Findings go back to `coder` for one fix round, not reviewed again. Spell: `references/providers.md`.

## Step 4 - quota

The `Lanes` and `Quota` lines end the checklist (or run `bash <skill-dir>/scripts/quota.sh`): plan, window shares, resets, sample age. Weigh task size and remaining share yourself. `reset passed` means the window rolled over; `unknown` and `stale` are not "fine". A quota or rate-limit error marks the lane exhausted for the session. A missing line never blocks the user. A registry with no enabled lane means: call no outside CLI.

## Step 5 - brief the delegate: a handoff packet

Delegates do not see this chat. Hand over state, never your trail:

```
Goal: <the user's words>
Workspace: <repo, branch, files that matter, what is already changed>
Verified: <facts you checked, with the command or file that shows them>
Failed: <approaches tried and why they failed; none if none>
Remaining: <the work left>
Hard constraints: <every length, format, placeholder or forbidden-word rule from the user, verbatim>
Done when: <the checks you will run>
Report: the deliverable, then an Evidence block (at most 15 lines)
```

Never paste your reasoning, tool output or the conversation. A rule not in the brief is not followed: copy the user's numbers and wording exactly. A brief states the goal and the checks, never your design: after `planner`, the `coder` brief carries the plan under Remaining. Writing "use X then Y" means you are designing: stop and dispatch `planner`.

Read `references/providers.md` before a session's first external call; it holds every spell (`agy`, `codex exec`, `scripts/invoke.py` for registry lanes, exit codes). Never put a brief or a secret on a command line; keys come from `key_ref`.

## Step 6 - clean and check before you relay

Delegated output is a claim until checked; three passes, in order:

1. **Strip** openers ("以下是…"), closers, notes about how it was made, and duplicate label lines: whole sentences, never a rewrite. Never strip the `Evidence` block or a stated limitation: the user needs both. Never paste a log in its place; the block names a file for anything longer than 15 lines.
2. **Verify** the hard constraints (count the length; placeholders, forbidden words, sections) against the deliverable, and the Evidence against the real artifact: `git status` for files changed, the test output present and passing, a source that exists (`curl -sI`).
3. **Retry or take over.** A failed check goes back once to the same delegate, defect quoted. If it fails again, fix a mechanical defect yourself, escalate by Step 2, or tell the user plainly.

Relay rule (hard): the reply starts with the deliverable; no sentence about the delegation ("以下为…，由…子代理撰写", "已核对…"), no process commentary; the Evidence block and the label line follow it.

## Step 7 - the label line

End **every** reply with one line saying what ran; the user uses it to catch mis-routing:

```
[Model: Haiku 5.5 | Effort: medium]
[Model: Haiku 5.5 (medium) → Gemini gemini-3.8-flash (low)]
[Model: Haiku 5.5 (medium) → coder Sonnet 5.5 (medium) | Review: Codex <model> (medium)]
```

Each participant, the reviewer too, carries its actual model and effort (Codex: `model` in `~/.codex/config.toml` unless you passed `-m`), as a version (Haiku 5.5, Opus 5.5, Fable 5.1, or the CLI model id). `Review: skipped` only when code changed and no trigger fired. No delegate, no arrow; never write `none`, `无` or a note there. Your effort is the session's (`Default` if unknown). On a stronger model the user picked, the table is suspended and you do the work (`/spick force` keeps routing); still print the label, unless the mod says its band is showing.
