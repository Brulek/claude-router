# Spick

<p align="center"><img src="docs/images/hero.svg" alt="Spick hero: the band while coder works" width="880"></p>

**Stop picking, just start.**

Spick is a triage layer for Claude Code. It selects the model and effort for each task and delegates some tasks to existing subscription CLIs.

[中文说明](README.zh-CN.md)

## Overview

- The main session (Haiku) reads each prompt and makes a single routing decision, by the shape of the deliverable: a verdict goes to `deep`, a plan to `planner`, changed code to `coder`; the main session is the last line, for plain lookups.
- A keyword pass over each prompt adds a `Hint` line to the checklist naming the default route; the main session keeps a hinted task only with a stated reason.
- Subagents (`coder`, `planner`, `deep`) run on fixed models. Outside CLIs (Gemini, Grok, Codex) handle their specialised tasks.
- Each reply names its participants in a label line or in the band.

## Request flow

```mermaid
flowchart TD
    IN["User prompt"]
    HOOK["Checklist hook: plan mode?<br/>assignee? pass/fail check?"]
    QUOTA["Quota line"]
    TRIAGE{"Main session (Haiku)<br/>single routing decision"}
    PLAN["Plan mode: planner drafts,<br/>user approves"]
    GOAL["Ready /goal line"]
    SELF["Main session executes"]
    SUB["Subagents<br/>coder · planner · deep"]
    CLI["Outside CLIs<br/>Gemini · Grok · Codex"]
    NEXT["Next CLI in the fallback chain"]
    REV{"Review trigger fired?"}
    CODEX["Codex review,<br/>one fix round"]
    CHECK["Main session verifies,<br/>retries once"]
    BAND{"Band<br/>displayed?"}
    LABEL["Label line"]
    SHOWN["Band shows participants"]

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
- Label line format: `[Model: Haiku 5.5 (medium) → coder Sonnet 5.5 (high) | Review: skipped]`

## Roles and models

| Task | Assigned to |
|---|---|
| Lookups: Q&A, file lookup, summaries | Main session (Haiku) |
| Code changes | `coder` subagent (Sonnet) |
| Planning and design | `planner` subagent (Opus) |
| Judgements: comparisons, evaluations, diagnoses, complex reasoning, decisions, formal writing | `deep` subagent (Opus) |
| Web search, fact checking, long media | Gemini (`agy`) |
| X / Twitter data | Grok (`grok`) |
| Independent code review, image generation | Codex (`codex`) |

Default effort: `coder` medium, `planner` high, `deep` high.

## Dashboard

![The Spick band in six states](docs/images/band-states.svg)

The band is an optional status line above the prompt that shows which participant is working.

![The Spick pane](docs/images/pane.svg)

`/spick` opens the pane, which contains hotkey switches and recent turns. Haiku reads a short quota line with each prompt; the pane shows local meters for Claude and Codex.

The gate is the one place the mod intervenes: when a prompt's Hint line named a verdict (or a design) and the main session answered it without delegating anything, the stop is sent back once, telling it to dispatch `deep` (or `planner`) or to state in one line starting with `Kept:` why the deliverable was a plain lookup. It never fires twice in a turn, never on a short reply without tool calls (a question back), and `/spick gate off` switches it off.

## Installation

```bash
npx skills add Brulek/spick
```

Then enter `spick setup` in Claude Code. Setup detects the installed CLIs, installs the subagents and registers the checklist hook.

Manual installation:

```bash
bash ~/.claude/skills/spick/scripts/setup.sh --check
bash ~/.claude/skills/spick/scripts/setup.sh --install --lanes gemini,grok,codex --model haiku --effort medium
```

In the desktop app, select Haiku once in the model menu.

### Dashboard mod (optional)

Run in a terminal:

    /plugin install spick-dashboard --marketplace Brulek/spick

While the band is displayed, replies omit the label line.

## Commands

| Command | Effect |
|---|---|
| `spick setup` | First-run setup |
| `spick doctor` | Lists installed and logged-in CLIs |
| `spick quota` | Displays the quota line |
| `/spick on\|force\|off` | Routing switch: `on` routes in a Haiku session only, `force` on any model |
| `/spick review on\|off` | Codex review step |
| `/spick gate on\|off` | The gate: a hinted verdict the main session kept is sent back once at stop time |
| `/spick lane <id>` | Shows one lane's record |
| `/spick lane <id> on\|off` | Switches a lane on or off (field `enabled`, saved in `spick.json`) |
| `/spick lane <id> <field> <value>` | Changes any field of a lane through `set_lane.py` (tags take a comma list) |
| `/spick hide` / `show` | Hides or shows the band for the current session |
| `/spick quota` | Refreshes the quota line |

Pane hotkeys: `r` routing, `v` review, `e` gate, `g` `k` `c` Gemini / Grok / Codex, `l` the lanes page (edit tags, data and the rest; no Input on mobile), `b` band, `q` refresh quota, `x` close.

## Requirements

Claude Code 2.1 or later, bash and python3. Optional: `codex`, `grok` and `agy`, each logged in.

## Project layout

Routing rules: `skills/spick/`. Band and pane: `mod/spick-dashboard/`.

## Related projects

[alexei-led/claude-router](https://github.com/alexei-led/claude-router) switches the main session's model on each turn and can run alongside Spick.

## Known limitations

Spick does not change the main session's model. A mod can rewrite the model and effort of each request (`turn.step` in the engine types of Claude Code 2.1.299); claude-router and claude-agent-tools do that. Spick leaves it to them and composes with claude-router, so the main session runs on the lower-cost model and triages by checklist. The checklist is advice: the main session can still keep a task it should have delegated, which is what the Hint line and the deliverable-shaped item 2 are there to prevent.

## License

MIT.
