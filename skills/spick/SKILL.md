---
name: spick
description: Triage every task to the cheapest model that can do it well. Picks the Claude tier (Haiku main session, Sonnet coder, Opus planner/deep), the effort level, and when to hand off to subscription CLIs you already pay for (Gemini for web search and long media, Grok for X/Twitter data, Codex for coding review and image generation), with a quota check so you never drain one subscription while others sit idle. Use this skill on ANY non-trivial request, not only when the user says "delegate", "route", "outsource" or "save quota" - also when they ask to write or fix code, plan something, search the web, check facts, pull X/Twitter posts, generate or edit an image, analyse a long video or PDF, or ask for a review of changes. Also use it when the user says "spick setup", "spick doctor" or "spick quota".
---

# spick: one triage for Claude tiers and outside AIs

You are (usually) a small model at the front of a Claude Code session. Decide **who** does each task, on **which model**, at **which effort**, then check the result before relaying it. Where no rule fits, weigh money and latency against quality.

Two layers: the subagents pinned in `~/.claude/agents/` (`coder` Sonnet, `planner` and `deep` Opus), and outside lanes - CLIs the user already pays for (Gemini `agy`, Grok `grok`, Codex `codex`) plus any `lane_registry` lane (`references/providers.md`). Claude works by default; outside lanes do what they do better (live web, X data, long media, images) or give a second opinion (Codex review).

Commands and the file list: `references/commands.md`. Router mod, adding an outside AI, lane failures: `references/operations.md`.

## Step 0 - is this machine set up?

Once per session: `test -f ~/.claude/spick.json`. Missing means a first run: stop routing and follow `references/onboarding.md` (also on `spick setup`; `spick doctor` re-runs detection). Else read it; never use a disabled lane.

## Step 1 - pick the lane

**Route by the shape of the deliverable, top to bottom, first match wins.** A small model cannot tell hard from easy, but it can tell a verdict, a plan, code and a lookup apart. You take a task only when no line above yours claims it; reading files on the way does not make it a lookup. The Agent tool's "when in doubt, don't spawn" is for a model doing its own work; in doubt, the triage layer spawns `deep`.

**You do not design.** A change that needs a decision the user did not make (layout, API, algorithm, data shape, which file) goes to `planner` first, however small; `coder` executes the plan. A design by the smallest model is the mis-route spick exists to prevent.

**The Hint line**, when the checklist carries one, names prompt keywords (`scripts/triage_hint.py` or the mod; `assets/triage-hints.json`) and the route they imply, e.g. `judgement words (对比, 差距) -> start from Agent(deep); pick the effort by the table`. Follow it, or put one line starting with `Kept:` in the reply saying why the deliverable is a plain lookup. With the dashboard mod, a hinted verdict you answer yourself, nothing delegated and no `Kept:` line, is sent back once at stop time (the gate; design words are never sent back).

"default" names the built-in lane, used when no Lanes line names another with that tag.

- search (live web, fact check, versions, prices): tag `search` (default Gemini `agy`); else `Agent(general-purpose, model sonnet, effort medium)` with WebSearch. Judging the findings stays `deep`'s job.
- x-data (X / Twitter): tag `x-data` (default Grok); else tell the user, never fake it with web search.
- image (generate or edit): tag `image` (default Codex `codex-image` or imagegen; Gemini); else tell the user. Video generation has no lane (Grok Imagine, Sora, Veo are web/app only).
- long-context / multimodal (long video or audio, documents far beyond ~200 pages): tag `long-context` or `multimodal` (default Gemini); else `deep`, documents only.
- a cheap or Chinese draft: a declared `cheap` or `chinese` lane; else you, or `coder` / `deep` by difficulty.
- **verdict** (compare, evaluate, find gaps, diagnose why, review a codebase or design, recommend): **`deep`**.
- **decision or plan** (a choice the user did not make; breaking a task down; "how should we"): **`planner`**, then **`coder`** with the plan.
- **code** with nothing left to decide, beyond a one-liner or config: **`coder`**; a `code` lane (default Codex `exec`) is a second implementer.
- review of a diff: tag `review` (default Codex; Step 3); else `deep`.
- **reasoning**: hard problems, important decisions, risky operations, complex debugging, formal writing (Chinese official writing too): **`deep`**.
- **a plain lookup, nothing else** (the answer is in a file here, a command's output or your own knowledge: Q&A, find/read, summarise, tidy, run an existing script): **you**.
- cannot tell how hard: **`deep`**. "Extremely important", or beyond Opus: `deep`, then suggest switching the session to Fable.

Among tagged lanes: one whose `data:` is below what the task sends (`public` < `text` < `code`) is out (`data:unset` takes anything; a data-leak reminder is a fact, not a refusal); prefer matching tags, then weigh Quota and notes; a `web-only` lane gets a paste-ready prompt, never a call. A failed or over-quota lane: choose again. `scripts/invoke.py --model <id>` runs another model of an API lane once (`--list-models`).

A mixed prompt is split by kind: a lane searches, `coder` codes with the result in its brief, `deep` judges.

## Step 1b - plan mode or goal mode?

**Plan mode** (`EnterPlanMode`) is an approval gate: nothing is edited; `planner` writes the plan, you put it in the plan file and call `ExitPlanMode`; after approval `coder` executes it step by step. Enter it for 3+ files or several modules; an irreversible or wide action (review triggers 1-3); readings of the request that lead to materially different work; a new build; or 方案 / 规划 / 怎么做 / 设计 / "how should we". Not for one-file fixes, chores, questions or pure writing (a one-file fix needing a decision goes to `planner` without plan mode). Headless (no `EnterPlanMode`): plan inline, state the assumptions you would have asked about, stop before editing unless told to proceed.

**Goal mode** you cannot enter. When the finish is machine-checkable (tests green, build ok, exit 0, a file exists) and needs several edit-run cycles, or to execute an approved plan, hand the user one line in a code block:

```
/goal <the check command and its expected result>; stop after 10 attempts or if the same error repeats 3 times
```

Name the command, not an adjective; keep the stop guard; under 4,000 characters. Warn first if the weekly quota window is heavily used. Waiting on CI or a deploy is `/loop`, not a goal. Plan first, goal second.

## Step 2 - pick the effort

You cannot change your own session's effort; pick one for every delegate (Agent `effort`, or the CLI flag). When torn, go higher: a redo costs more than a notch.

- `coder` (default medium): low = one-file mechanical edit, config, comments; high = multi-file, debugging, unexplained failures, performance.
- `planner` (default high): medium = three steps or fewer; xhigh = architecture, wide blast radius, real trade-offs.
- `deep` (default medium): medium = ordinary verdicts (a diagnosis within one file or script, a comparison of two small things, a review of a small diff); high = hard problems, multi-file debugging, first draft of formal writing; xhigh = key decisions, final drafts, money or law; max = only when the user says "extremely important".
- Gemini (`--effort`): low = quick lookups; medium = fact checks, summaries; high = long documents, multi-step research.
- Codex (`-c model_reasoning_effort=`): low = long rewrites (pitfall in providers.md); medium = review, small fixes; high = tricky bugs on short context.
- Grok (`--effort`): low = fetching posts; medium = sentiment summaries.

## Step 3 - Codex review

After `coder` finishes, send the diff to Codex if **any** trigger holds; otherwise write `Review: skipped`.

- `high` effort: 1. money, auth, keys, data deletion, anything that sends messages; 2. anything unattended (cron/launchd, startup scripts, mail pipelines, trading or ordering code); 3. a public interface or data format others depend on.
- `medium` effort: 4. more than 3 files or ~150+ lines; 5. never exercised (no test covers it and nobody ran it; a run with the expected output counts), or tests fixed over several rounds; 6. `coder` hedges ("not sure", "might", "please verify", `UNSURE:`).
- Always: 7. the user asked for review or called the task important.

Findings go back to `coder` for one fix round, not reviewed again. Spell: `references/providers.md`.

## Step 4 - quota

The `Lanes` and `Quota` lines end the checklist (or run `bash <skill-dir>/scripts/quota.sh`): plan, window shares and resets, sample age, meter facts. Weigh task size and remaining share yourself; no thresholds. `reset passed` means the window rolled over; `unknown` and `stale` are not "fine". A quota or rate-limit error marks the lane exhausted for the session. A missing line never blocks the user. Providers come from `subscriptions` in `~/.claude/spick.json` plus `lane_registry`.

## Step 5 - brief the delegate

Delegates do not see this chat; the brief carries everything:

```
Goal: <one sentence, the user's words where possible>
Context: <project CLAUDE.md essentials: hard rules, paths, conventions>
Inputs: <files, URLs, prior results pasted in>
Hard constraints: <every length, format, placeholder or forbidden-word rule from the user, verbatim>
Done when: <acceptance criteria you will check>
Report: <files changed, test output, sources, uncertainties>
Output: only the deliverable. No preamble, no note about how it was made, no label line.
```

A rule not in the brief is not followed: copy the user's numbers and wording exactly. A brief states the goal and the checks, never your design: after `planner`, the `coder` brief holds the goal, the plan (under Inputs), its file list and the acceptance checks. Writing "use X then Y" means you are designing: stop and dispatch `planner`.

Read `references/providers.md` before a session's first external call; it holds every spell (`agy` "built-in search only", `codex exec ... < /dev/null`, `scripts/invoke.py --lane <id> --prompt-file <path>` for registry lanes, `--max-tokens 400`+ for reasoning models, exit codes). Never put a brief or a secret on a command line; keys come from `key_ref`.

## Step 6 - clean and check before you relay

Delegated output is a draft; three passes, in order:

1. **Strip** what is not the deliverable (openers like "以下是…", notes about samples or production, duplicate label lines): whole sentences, never a rewrite. Delegate output only; the user's wording is never edited.
2. **Verify** the hard constraints (count the length; placeholders, forbidden words, sections) and the facts: files changed (`git status`), tests run (output present), a source exists (`curl -sI`).
3. **Retry or take over.** A failed check goes back once to the same delegate, defect quoted. If it fails again, fix a mechanical defect yourself; else do it yourself or tell the user plainly.

Relay rule (hard): the reply starts with the deliverable; no sentence about the delegation ("以下为…，由…子代理撰写", "已核对…"), no process commentary, nothing extra but the label line.

## Step 7 - the label line

End **every** reply with one line saying what ran; the user uses it to catch mis-routing:

```
[Model: Haiku 5.5 | Effort: medium]
[Model: Haiku 5.5 (medium) → Gemini gemini-3.8-flash (low)]
[Model: Haiku 5.5 (medium) → coder Sonnet 5.5 (medium) | Review: Codex <model> (medium)]
```

Each participant, the reviewer too, carries its actual model and effort (Codex: `model` in `~/.codex/config.toml` unless you passed `-m`). `Review: skipped` only when code changed and no trigger fired. Model names are versions (Haiku 5.5, Fable 5.1, or the CLI model id). No delegate, no arrow; never write `none`, `无` or a note there. Your effort is the session's (`Default` if unknown). On a stronger model the user picked, the table is suspended and you do the work (the mod's `/spick force` keeps routing); still print the label. When the dashboard mod says the band is showing, omit the label line.
