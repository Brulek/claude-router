# Spick

<p align="center"><img src="docs/images/hero.svg" alt="Spick hero: the band while coder works" width="880"></p>

**Stop picking, just start.** Spick is a triage layer for Claude Code. It picks the model and effort for each task and sends some tasks to subscription CLIs you already pay for.

[中文说明](README.zh-CN.md)

## In 30 seconds

- The main session (Haiku) reads each prompt and decides once who does the work.
- Subagents (`coder`, `planner`, `deep`) run on fixed models. Outside CLIs (Gemini, Grok, Codex) take what they do best.
- Each reply shows who worked, in a label line or the band.

## How a request flows

```mermaid
flowchart TD
    IN["Your prompt"]
    HOOK["Checklist hook: plan mode?<br/>who does it? pass/fail check?"]
    QUOTA["Quota line"]
    TRIAGE{"Main session (Haiku)<br/>decides once"}
    PLAN["Plan mode: planner<br/>writes, you approve"]
    GOAL["A ready /goal line"]
    SELF["Haiku does it"]
    SUB["Subagents<br/>coder · planner · deep"]
    CLI["Outside CLIs<br/>Gemini · Grok · Codex"]
    NEXT["Next CLI in the chain"]
    REV{"Review trigger fired?"}
    CODEX["Codex review,<br/>one fix round"]
    CHECK["Main session checks,<br/>retries once"]
    BAND{"Is the band<br/>showing?"}
    LABEL["Label line"]
    SHOWN["Band shows who worked"]

    IN --> HOOK --> TRIAGE
    QUOTA -.-> TRIAGE
    TRIAGE -->|"wide, risky or ambiguous"| PLAN
    TRIAGE -->|"clear pass/fail check"| GOAL
    TRIAGE -->|"simple task"| SELF
    TRIAGE -->|"code, plan, hard call"| SUB
    TRIAGE -->|"search, X data, image, long media"| CLI
    PLAN -->|"approved"| SUB
    CLI -.->|"unavailable or out of quota"| NEXT
    SUB --> REV
    REV -->|"yes"| CODEX --> CHECK
    REV -->|"no"| CHECK
    CLI --> CHECK
    SELF --> BAND
    CHECK --> BAND
    BAND -->|"no"| LABEL
    BAND -->|"yes"| SHOWN
```

- Fallback chains: `skills/spick/references/providers.md`. Review triggers: `skills/spick/SKILL.md`.
- Label line: `[Model: Haiku 5.5 (medium) → coder Sonnet 5.5 (high) | Review: skipped]`

## Who does what

| Task | Done by |
|---|---|
| Simple tasks: Q&A, files, summaries | Main session (Haiku) |
| Code changes | `coder` subagent (Sonnet) |
| Planning and design | `planner` subagent (Opus) |
| Hard reasoning, decisions, formal writing | `deep` subagent (Opus) |
| Web search, fact checks, long media | Gemini (`agy`) |
| X / Twitter data | Grok (`grok`) |
| Independent code review, image generation | Codex (`codex`) |

Default effort: `coder` medium, `planner` high, `deep` high.

## The dashboard (optional)

![The Spick band in six states](docs/images/band-states.svg)

The band is a status line above the prompt. It shows who works.

![The Spick pane](docs/images/pane.svg)

`/spick` opens the pane: switches with hotkeys, and recent turns. Haiku reads a short quota line with each prompt; the pane shows local meters for Claude and Codex.

## Install

```bash
npx skills add Brulek/spick
```

Then in Claude Code say `spick setup`. It detects your CLIs, installs the subagents and registers the checklist hook.

Manual:

```bash
bash ~/.claude/skills/spick/scripts/setup.sh --check
bash ~/.claude/skills/spick/scripts/setup.sh --install --lanes gemini,grok,codex --model haiku --effort medium
```

In the desktop app, pick Haiku once in the model menu.

### Dashboard mod (optional)

In a terminal:

    /plugin install spick-dashboard --marketplace Brulek/spick

While the band shows, replies have no label line.

## Commands

| Say | Effect |
|---|---|
| `spick setup` | first-run setup |
| `spick doctor` | which CLIs are installed and logged in |
| `spick quota` | shows the quota line |
| `/spick on\|off\|auto` | routing switch |
| `/spick review on\|off` | the Codex review step |
| `/spick lane <gemini\|grok\|codex> on\|off` | one outside CLI |
| `/spick hide` / `show` | the band, this session only |
| `/spick quota` | refresh the quota line |

Pane hotkeys: `r` routing, `v` review, `g` `k` `c` Gemini / Grok / Codex, `b` band, `q` refresh quota, `x` close.

## Requirements

Claude Code 2.1 or later, bash and python3. Optional: `codex`, `grok` and `agy`, logged in.

## Layout

Rules: `skills/spick/`. Band and pane: `mod/spick-dashboard/`.

## Pairs well with

[alexei-led/claude-router](https://github.com/alexei-led/claude-router) switches the main session's model each turn.

## Known limits

A session cannot change its own model, so the main session runs on the cheap one.

## License

MIT.
