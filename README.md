# Spick

**Stop picking, just start.** One triage layer for Claude Code.

One triage layer for Claude Code: pick the Claude tier, the effort, and when to hand work to the subscription CLIs you already pay for.

[中文说明](README.zh-CN.md)

## What it does

You run Claude Code with a small, cheap model (Haiku) as the main session. Every request is triaged once:

| Task | Goes to |
|---|---|
| Chores (Q&A, files, summaries, run a script) | the main session itself |
| Code changes | `coder` subagent, pinned to Sonnet |
| Planning and design | `planner` subagent, pinned to Opus |
| Hard reasoning, decisions, formal writing | `deep` subagent, pinned to Opus |
| Live web search, fact checks, long video/audio, huge documents | Gemini (`agy`, Antigravity CLI) |
| X / Twitter data | Grok (`grok`, Grok Build) |
| Independent code review, image generation | Codex (`codex`, ChatGPT subscription) |

Each delegate also gets an effort level chosen per task. The triage layer enters plan mode itself for wide, risky, ambiguous or greenfield work, and hands you a ready-made `/goal` line when a task has a machine-checkable finish. A quota gate reads the usage the CLIs already cache on disk (no third-party tools) and moves work down a fallback chain when a subscription is 80% used. Codex review is triggered by a short checklist (money/auth/unattended code, big diffs, no tests, hedged reports), not on every change. Every reply ends with a label line such as `[Model: Haiku 5.5 → coder Sonnet 5.5 | Effort: High | Review: skipped]` so you can see what ran.

Claude is the default for work; the outside lanes are used only where they are genuinely better or cheaper. If a CLI is not installed, its lane is skipped. With nothing but Claude installed you still get the internal tiering.

## Install

```bash
npx skills add Brulek/spick
```

Then open a Claude Code session and say `spick setup`. The onboarding detects which CLIs are installed and logged in, asks which lanes to enable and which main model to use, installs the three subagents into `~/.claude/agents/`, writes a short cheat sheet into `~/.claude/CLAUDE.md`, registers a per-prompt triage checklist hook (`scripts/triage-hook.sh`, a `UserPromptSubmit` hook in `~/.claude/settings.json`), and (optionally) sets the default model and effort in `~/.claude/settings.json`.

Manual equivalent:

```bash
bash ~/.claude/skills/spick/scripts/setup.sh --check
bash ~/.claude/skills/spick/scripts/setup.sh --install --lanes gemini,grok,codex --model haiku --effort medium
```

Desktop app users: pick Haiku once in the composer's model menu. The app remembers its own choice and overrides `settings.json`.

### Dashboard mod (optional)

In a terminal session:

    /plugin install spick-dashboard --marketplace Brulek/spick

Answer `y` to add the marketplace, pick the user scope. The band above the prompt then shows who is working; `/spick` opens the pane. While the band shows (terminal or desktop app), replies carry no label line; hide it with `/spick hide` and the label line returns.

`/spick on|off|auto` switches routing (auto = on only in a Haiku session; picking a model with `/model` turns it off for the session), `/spick review on|off` the Codex review step, `/spick lane <gemini|grok|codex> on|off` one outside lane; these three choices are remembered across sessions.
`/spick quota` refreshes and prints the quota meters; the pane's Controls section has the same switches with hotkeys (`r` `v` `g` `k` `c` `b` `q` `x`).

## Commands

| Say | Effect |
|---|---|
| `spick setup` | first-run onboarding (re-runnable) |
| `spick doctor` | detection table: installed, logged in, versions |
| `spick quota` | local usage for Claude and Codex; Grok and Gemini report unknown |

## Requirements

- Claude Code 2.1+ (subagent `model`/`effort` frontmatter).
- bash and python3 for the two scripts (Git Bash or WSL on Windows).
- Optional: `codex`, `grok`, `agy` CLIs logged into their subscriptions; the `codex-image` Claude Code plugin for image generation.

## Layout

```
skills/spick/
├── SKILL.md                 the routing rules
├── references/providers.md  spells, flags, model ids, quota sources, pitfalls
├── references/onboarding.md first-run flow
├── scripts/quota.sh         local quota reader
├── scripts/setup.sh         detection and install
└── assets/                  subagent definitions, CLAUDE.md snippet
mod/spick-dashboard/         the dashboard mod (band above the prompt, /spick pane)
```

## Pairs well with

- [alexei-led/claude-router](https://github.com/alexei-led/claude-router): a Claude Code Mod that switches the main session's model and effort per turn using a local or hosted classifier. It covers the one thing this skill cannot (re-pricing the main conversation); this skill covers what it leaves out (outside CLIs, review triggers, quota gate, onboarding). Install both.
- [tzachbon/claude-model-router-hook](https://github.com/tzachbon/claude-model-router-hook): hook-based variant that warns or sets the next session's model.

## Known limits

- A Claude Code session cannot change its own model or effort; only delegates can be re-priced. That is why the main session is cheap and everything else is pinned.
- Grok and Gemini do not expose quota locally; those lanes rely on "quota error means tight".
- Cloud agents (Codex Cloud, ChatGPT agent mode, Grok web tasks) are out of scope.

MIT licensed.
