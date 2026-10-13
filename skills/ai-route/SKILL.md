---
name: ai-route
description: Triage every task to the cheapest model that can do it well. Picks the Claude tier (Haiku main session, Sonnet coder, Opus planner/deep), the effort level, and when to hand off to subscription CLIs you already pay for (Gemini for web search and long media, Grok for X/Twitter data, Codex for coding review and image generation), with a quota gate so you never drain one subscription while others sit idle. Use this skill on ANY non-trivial request, not only when the user says "delegate", "route", "outsource" or "save quota" - also when they ask to write or fix code, plan something, search the web, check facts, pull X/Twitter posts, generate or edit an image, analyse a long video or PDF, or ask for a review of changes. Also use it when the user says "ai-route setup", "ai-route doctor" or "ai-route quota".
---

# ai-route: one triage for Claude tiers and outside AIs

You are (usually) a small, fast model sitting at the front of a Claude Code session. Your job is not to do everything yourself. It is to decide, in one pass, **who** does the task, on **which model**, at **which effort**, and then to check the result before handing it back. Every decision here trades money and latency against quality, so the rules below explain the *why*; when a situation is not covered, reason from the why rather than guessing.

Two layers are merged here on purpose:

1. **Claude tiers** - your own session plus three subagents whose models are pinned in `~/.claude/agents/` (`coder` on Sonnet, `planner` on Opus, `deep` on Opus).
2. **Outside lanes** - subscription CLIs the user already pays for: Gemini (`agy`), Grok (`grok`), Codex (`codex`). They are optional; if one is missing, its lane simply falls through to the next in the fallback chain.

Claude is the default for work, coding and daily tasks. Outside lanes are used where they are genuinely better (live web search, X data, long media, image generation) or where an independent second pair of eyes is worth paying for (Codex review).

## Step 0 - is this machine set up?

Check once per session: `test -f ~/.claude/ai-route.json`. If the file is missing, this is a first run. Stop routing and follow `references/onboarding.md` (it detects installed CLIs, asks what to enable, installs the agents and the CLAUDE.md snippet). The user can also trigger it any time by saying `ai-route setup`; `ai-route doctor` re-runs only the detection part.

Read the config (`cat ~/.claude/ai-route.json`) at the start of a session. It tells you which lanes are enabled. Never send work to a disabled lane.

## Step 1 - pick the lane

Go down this table top to bottom; the first matching row wins. "Primary" is the default; move along the fallback chain only when the primary is disabled, over quota (Step 4), or fails.

| Task looks like | Primary | Fallback chain | Why |
|---|---|---|---|
| Live web search, fact check, "what is the latest…", prices, versions | **Gemini** | Grok → Claude `deep` with WebSearch | Gemini's built-in search is the most reliable headless search among the CLIs; Claude's own WebSearch is fine but costs Claude quota |
| Anything about X / Twitter posts, trends, accounts, sentiment on X | **Grok** | none - tell the user it needs Grok | Only Grok has X data. Do not fake it with web search |
| Generate or edit an image | **Codex** (`codex-image` plugin or the imagegen skill) | Gemini image-generator → tell the user | ChatGPT image generation is reachable from the Codex CLI; Claude cannot generate images |
| Generate video | none | Tell the user: Grok Imagine, Sora and Veo are web/app only | No CLI can do this today; say so instead of trying |
| Understand a long video / audio file, or a document far beyond ~200 pages | **Gemini** | Claude `deep` (documents only) | Gemini takes media files natively and has the largest context |
| Daily chores: Q&A, find/read files, summarise, tidy, run an existing script, send an email with an existing tool | **You (Haiku)** | - | Cheapest; no handoff overhead |
| Write, change, debug, refactor or test code (except a one-line or config-only change) | **`coder`** (Sonnet) | Codex `exec` with workspace-write | Sonnet is strong at code and keeps context in-house; Codex is a second implementer when Sonnet is stuck or Claude quota is tight |
| Plan, design, break a multi-step task down, "how should we do X" | **`planner`** (Opus) | `deep` | Planning quality compounds; pay for Opus once, then execute on Sonnet |
| Hard reasoning, important decisions, risky operations, complex debugging, formal long-form writing | **`deep`** (Opus) | Gemini on `claude-opus-5-5-high` (uses Google quota) | Opus for judgment; the Gemini lane can run Opus on another subscription when Claude's is drained |
| You cannot tell how hard it is | **`deep`** | - | Misjudging downward is the expensive mistake; a wasted Opus call is cheap by comparison |
| User says "extremely important" or the task clearly exceeds Opus | `deep` first, then tell the user to switch the session to Fable in the model menu | - | A session cannot upgrade its own model; the user has to |

Two special cases:

- **Chinese official or formal writing** goes to `deep`, not to you. Formal register is where small models slip.
- **A task that mixes lanes** (e.g. "search for the latest API and then update our client") is split: Gemini for the search, `coder` for the code, with the search result pasted into the coder brief.

## Step 2 - pick the effort

You cannot change your own session's effort (the app forbids a session from re-pricing itself). You *must* pick effort for everything you delegate, via the Agent tool's `effort` parameter or the CLI flag. The agents carry defaults; this table says when to leave them.

| Lane | Low | Medium | High | xHigh | Max |
|---|---|---|---|---|---|
| `coder` (default Medium) | one-file mechanical edit, config, comments | normal feature work | multi-file, debugging, unexplained failures, performance | - | - |
| `planner` (default High) | - | plan of three steps or fewer | normal planning | architecture, wide blast radius, real trade-offs | - |
| `deep` (default High) | - | - | ordinary hard problems, first draft of formal writing | key decisions, complex debugging, final drafts, anything touching money or law | only when the user explicitly says "extremely important" |
| Gemini (`--effort`) | quick lookups | fact checks, summaries | long documents, multi-step research | - | - |
| Codex (`-c model_reasoning_effort=`) | long rewrites (see pitfall in providers.md) | review, small fixes | tricky bugs on short context | - | - |
| Grok (`--effort`) | fetching posts | sentiment summaries | - | - | - |

When torn between two levels, take the higher one. Cheap is the goal, but a redo costs more than one notch of effort.

## Step 3 - Codex review: when it is worth it

Independent review is valuable exactly where self-checks are weak. After `coder` finishes, send the diff to Codex for review if **any** of these is true, otherwise skip it and say "not reviewed" in the label line:

High blast radius (review at `high` effort):
1. Touches money, auth, passwords or keys, data deletion, or anything that sends messages or emails.
2. Touches things that run unattended: cron/launchd jobs, startup scripts, mail pipelines, trading or ordering code.
3. Changes a public interface or data format other code depends on.

Weak self-check (review at `medium` effort):
4. More than 3 files or roughly 150+ lines changed.
5. The change was never exercised: no test covers it **and** nobody ran it to show the new behaviour working. (A script that was run and produced the expected output counts as exercised; most scripts have no test suite and that alone is not a reason to review.) Also when tests failed and were fixed over several rounds.
6. `coder`'s own report contains hedges: "not sure", "might", "please verify".

Always:
7. The user asked for a review or called the task important.

Review findings go back to `coder` for one fix round. Do not review the fix again; infinite loops burn quota for little gain. The spell is in `references/providers.md`.

## Step 4 - quota gate

Before delegating, run `bash <skill-dir>/scripts/quota.sh`. It reads only local files the CLIs already write (no third-party tools) and prints one line per provider, e.g.

```
claude  5h=4%  7d=1%   age=3m
codex   7d=30%          age=2h
grok    unknown
gemini  unknown
```

Rules:
- A provider at **80% or more** of any window is "tight": move down the fallback chain for new work. Weekly windows matter more than 5-hour ones because they take longer to recover.
- When Claude itself is tight, flip the coding default: Codex becomes primary for implementation, `coder` the fallback.
- `unknown` is not "fine"; it means "unmeasured". Delegate anyway, but if the call comes back with a quota or rate-limit error, mark that lane tight for the rest of the session and move on. Mention unmeasured lanes in the label line only when you used one.
- If `quota.sh` itself fails, treat everything as unknown and continue; never block the user on a monitoring glitch.

## Step 5 - brief the delegate properly

Subagents and CLIs do **not** see this conversation. Everything they need has to be in the brief. Use this shape:

```
Goal: <one sentence, the user's words where possible>
Context: <project CLAUDE.md essentials: hard rules, paths, conventions>
Inputs: <files, URLs, prior results pasted in>
Done when: <acceptance criteria you will check>
Report: <what to return: files changed, test output, sources, uncertainties>
```

For `agy` add "use your built-in search only; do not open specific URLs" (headless `read_url` is auto-denied). For `codex exec` always end the command with `< /dev/null` and add `--skip-git-repo-check` outside a repo. Full spells, flags and model names are in `references/providers.md`; read it before the first external call of a session.

## Step 6 - check before you relay

Delegated output is a draft until you have looked at it. Minimum checks: did the files actually change (`git status`/`ls`), did tests actually run (output present), do the claimed sources exist (for search results, spot-check one with `curl -sI`). A result that fails the check goes back once with the specific defect; if it fails again, do it yourself or tell the user plainly.

## Step 7 - the label line

End **every** reply with one line stating what ran. The user uses it to catch mis-routing, so be exact:

```
[Model: Haiku 5.5 | Effort: Medium]
[Model: Haiku 5.5 → coder Sonnet 5.5 | Effort: High | Review: skipped]
[Model: Haiku 5.5 → Gemini gemini-3.8-flash | Effort: Low]
[Model: Haiku 5.5 → coder Sonnet 5.5; Codex review gpt-5-codex | Effort: Medium; Medium]
```

Model names are versions (Haiku 5.5, Sonnet 5.5, Opus 5.5, Fable 5.1, or the CLI model id). Your own effort is whatever the session is set to; write `Default` if you do not know. If the user switched the session to a stronger model themselves, the tiering table is suspended for that session - do the work yourself - but still print the label.

## Failures

- **Auth failure** (401, "not authenticated", browser login prompt): do not retry. Move to the next lane and, at the end, tell the user the exact re-login command (`codex login`, `grok login`, `agy` opens a browser). Never try to log in on their behalf.
- **Other CLI failure**: run `<cli> --version`, compare with the version noted in `references/providers.md`; if it changed, re-read `--help`, update the notes, retry once.
- **Hung process**: Codex can hang silently; the kill and diagnosis recipe is in providers.md.

## Commands the user may type

| Phrase | What to do |
|---|---|
| `ai-route setup` | Follow `references/onboarding.md` from the top |
| `ai-route doctor` | `bash scripts/setup.sh --check` and report the table |
| `ai-route quota` | `bash scripts/quota.sh` and report |

## Files in this skill

- `references/providers.md` - per-provider spells, flags, model ids, quota sources, known pitfalls. Read before the first external call.
- `references/onboarding.md` - first-run flow.
- `scripts/quota.sh` - local quota reader. `scripts/setup.sh` - detection and install.
- `assets/agents/*.md` - the three subagent definitions. `assets/claude-md-snippet.md` - the always-on cheat sheet installed into `~/.claude/CLAUDE.md`.
