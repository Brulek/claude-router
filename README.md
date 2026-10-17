# Spick

<p align="center"><img src="docs/images/hero.svg" alt="Spick: Stop picking, just start. The dashboard band while the coder subagent works" width="880"></p>

<p align="center">Spick is a triage layer for Claude Code. It selects the model and effort for each task and delegates some tasks to existing subscription CLIs.</p>

Spick keeps the main session cheap and spends Opus only on tasks that need it, so the Gemini, Grok and Codex CLIs you already pay for do not sit idle. The external CLIs are optional: without them Spick still routes work between Claude's Sonnet and Opus subagents.

<p align="center">
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-D77757" alt="License: MIT"></a>
<a href="#requirements"><img src="https://img.shields.io/badge/Claude%20Code-2.1%2B-191919" alt="Claude Code 2.1+"></a>
<a href="https://github.com/Brulek/spick/actions/workflows/ci.yml"><img src="https://github.com/Brulek/spick/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center">
<a href="#quick-start">Quick start</a> · <a href="#dashboard-optional">Dashboard</a> · <a href="#commands">Commands</a> · <a href="#faq">FAQ</a> · <a href="README.zh-CN.md">中文</a>
</p>

## What it does

- The main session (Haiku) reads each prompt and makes a single routing decision. It routes by the shape of the deliverable: a verdict goes to `deep`, a plan to `planner`, changed code to `coder`. The main session is the last line, for plain lookups.
- A keyword pass over each prompt adds a `Hint` line to the checklist. The line names the default route. The main session keeps a hinted task only with a stated reason.
- Subagents (`coder`, `planner`, `deep`) run on fixed models. Outside CLIs (Gemini, Grok, Codex) handle their specialised tasks.
- Each reply names its participants, in a label line or in the band.

## Quick start

1. Install the skill:

   ```bash
   npx skills add Brulek/spick
   ```

2. Enter `spick setup` in Claude Code. Setup detects the installed CLIs, installs the subagents and registers the checklist hook.
3. In the desktop app, select Haiku once in the model menu; Spick routes only in a Haiku session unless forced (`/spick force`).

Manual installation, the dashboard mod and uninstall are under [Installation](#installation).

## How it works

```mermaid
%%{init: {"theme": "base", "themeVariables": {"background": "#FAF9F5", "primaryColor": "#F0EEE6", "primaryTextColor": "#191919", "primaryBorderColor": "#D77757", "lineColor": "#87867F", "secondaryColor": "#FAF9F5", "tertiaryColor": "#FAF9F5", "edgeLabelBackground": "#FAF9F5", "textColor": "#191919"}}}%%
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

Default effort: `coder` medium, `planner` high, `deep` medium (raised per task: high for hard or multi-file problems, xhigh for key decisions).

## Dashboard (optional)

![The Spick band in six states](docs/images/band-states.svg)

The band is an optional status line above the prompt that shows which participant is working.

![The Spick pane](docs/images/pane.svg)

`/spick` opens the pane, which contains hotkey switches and recent turns. Haiku reads a short quota line with each prompt; the pane shows local meters for Claude and Codex with the age of each sample (when Claude Code or the Codex log sampled it, never when the pane read the file).

The band also shows the main loop's last prompt size (`ctx 42k`). On a Haiku session above 80,000 tokens it warns `context 85k: Haiku bills 5x above 100k; /clear or delegate`: Haiku 5.5 bills a prompt over 100K tokens at five times the rate.

The mod acts on facts, at the cheapest moment. Everything else it shows is read only.

**The guard**, while routing is in force:

- Edit cap: the main session may edit one source file itself per turn. A second file is refused with a message that names the first and asks for `Agent(coder)`. Further edits to the same file, a subagent's edits, and notes (`.md`, `.txt`), tables (`.csv`, `.tsv`), logs, lock files and a leading `.claude/` do not count; json, yaml and toml do, and so does a worktree under `.claude/worktrees/`. The cap is a tool-level soft bound: it sees Edit, Write and NotebookEdit, not Bash writes such as `sed -i` or a redirection.
- Check at stop: when any loop, a subagent included, edited source in a turn and no check passed after the last edit, the stop is sent back. A check counts only when the runner is the command itself (after `cd x &&`, `env`, `npx`, `sudo`, `time`; `echo pytest` and `grep pytest README` are not checks), it exited cleanly (`pytest || true` and `pytest --version` do not count), and no source edit came after it started. A project with its own check command declares it as a regex in `<config>/spick.json` under `guard.check_commands` (see `skills/spick/references/providers.md`). The main session is asked to run the project's check, hand the user a `/goal` line, or state why there is none in one line starting with `Unchecked:` (or `未验证:`).
- Escalation: when the same check fails twice in a turn, the second failure's result carries one line telling the main session to dispatch `coder` at effort high, or `deep` if the cause is unknown, instead of a third fix of its own.
- `/spick guard off` switches the guard off, and the choice is remembered.

**The gate** asks for the role a hinted verdict needs: judgement words need `deep`, review words the review lane (Codex with a review prompt, or a lane tagged `review`) or `deep`. Design words stay a Hint line and never gate.

- At stop, the turn is sent back when that role did not complete (a `deep` subagent that finished, or still runs in the background; a review call that returned cleanly; a refused, failed or timed-out call does not count), the reply has no line starting with `Kept:` (or `自留:`), and the turn was substantive (a tool call, or a reply of 400 characters or more).
- `/spick gate off` switches it off.

The gate and the guard send a turn back at most once, with every reason in one block.

**Effort defaults.** An Agent call of `coder`, `planner` or `deep` that names no effort runs at the default from `efforts` in `<config>/spick.json` (coder medium, planner high, deep medium when it is not set).

**The turn record.** Each main turn is one JSON line in `<config>/spick/turns/<sessionId>.jsonl` (`<config>` is `CLAUDE_CONFIG_DIR`, else `~/.claude`): the hint, what ran (each delegate with its status, model, effort, usage and cost), the gate's firings and what followed, the `Kept:` line, the edits, every check with its exit status, any escalation, the main loop's usage and its last prompt size. A background agent that finishes later adds a `late` line for the same turn. `/spick spend` sums the cost of the last seven days (`scripts/spend.py`, which also reads the per-session files of mod 0.x); `/spick audit` runs `scripts/audit.py`: turns by hint kind and what ran, how hinted verdicts ended, gate outcomes and false positive candidates, edits with no passing check, escalations, cost by lane and by kind, and the longest sessions by context size.

## Installation

The usual path is the [Quick start](#quick-start) above.

Manual installation:

```bash
bash ~/.claude/skills/spick/scripts/setup.sh --check
bash ~/.claude/skills/spick/scripts/setup.sh --install --lanes gemini,grok,codex --model haiku --effort medium
```

Before it writes anything, `--install` copies `CLAUDE.md`, `settings.json` and `spick.json` into `~/.claude/spick-backup/<timestamp>/`, together with a `manifest.json` that records what the run changed.

In the desktop app, select Haiku once in the model menu.

### Dashboard mod (optional)

Run in a terminal:

    /plugin install spick-dashboard --marketplace Brulek/spick

While the band is displayed, replies omit the label line.

### Uninstall

```bash
bash ~/.claude/skills/spick/scripts/setup.sh --uninstall [--purge] [--force]
```

It backs up first, like `--install`. Then it removes only what the install wrote:

- the block between the spick markers in `CLAUDE.md`;
- the checklist hook in `settings.json`;
- the three subagents.

What it leaves alone:

- `model` and `effortLevel` go back to their value from before the install only if they still hold the value the install set.
- A subagent file you edited is kept unless you pass `--force`.
- `spick.json` is kept unless you pass `--purge`, which also removes `spick-quota.json` and `spick-spend/`.
- `spick-backup/` is never removed.

Two steps remain for you: `claude plugin uninstall spick-dashboard` and deleting `~/.claude/skills/spick`.

## Commands

| Command | Effect |
|---|---|
| `spick setup` | First-run setup |
| `spick doctor` | Lists installed and logged-in CLIs |
| `spick quota` | Displays the quota line |
| `/spick on\|force\|off` | Routing switch: `on` routes in a Haiku session only, `force` on any model |
| `/spick review on\|off` | Codex review step |
| `/spick gate on\|off` | The gate: a hinted verdict the main session kept is sent back once at stop time |
| `/spick guard on\|off` | The guard: at most 3 source files edited by the main session per turn, and a turn that edited source without running a check is sent back once at stop time |
| `/spick lane <id>` | Shows one lane's record |
| `/spick lane <id> on\|off` | Switches a lane on or off (field `enabled`, saved in `spick.json`) |
| `/spick lane <id> <field> <value>` | Changes any field of a lane through `set_lane.py` (tags take a comma list) |
| `/spick hide` / `show` | Hides or shows the band for the current session |
| `/spick quota` | Refreshes the quota line |
| `/spick spend` | What the sessions cost in the last 7 days, by lane (`scripts/spend.py`; `--days N`, `--by lane\|day\|session`, `--json` when run by hand) |

How `/spick spend` gets its data: the mod writes one file per session to `~/.claude/spick-spend/`, with a row per turn that carried usage and a row per outside CLI call (tokens 0, unpriced). Without the mod there is no spend record: the bash hook sees no usage.

Pane hotkeys: `r` routing, `v` review, `e` gate, `d` guard, `g` `k` `c` Gemini / Grok / Codex, `l` the lanes page (edit tags, data and the rest; no Input on mobile), `b` band, `q` refresh quota, `x` close.

## Requirements

- Claude Code 2.1 or later, bash and python3.
- Optional: `codex`, `grok` and `agy`, each logged in.
- A lane key stored as `keychain:<name>` works on macOS only; on Linux and Windows use `env:<VAR>`.
- `CLAUDE_CONFIG_DIR` is honoured by setup, the hook and the scripts. The dashboard mod sees only `HOME`, so with `CLAUDE_CONFIG_DIR` set its marker (`.spick-mod-active`) and its spend records (`spick-spend/`) still live under `~/.claude`.

## FAQ

### Does Spick switch the main session's model?

No. Spick does not change the main session's model. To switch it on each turn, run claude-router alongside Spick. See [Known limitations](#known-limitations).

### Sessions on Sonnet, Opus or Fable

With `/spick on` (the default) such a session routes nothing, by design: the main model can do the work itself, so the checklist is replaced by one sentence saying so. Without the dashboard mod the CLAUDE.md block says the same. `/spick force` keeps the delegation on any model: `coder` still runs edits in its own context, and `deep` still gives an independent second opinion, even though the main model could do both. That is worth it in long sessions where the main context would fill with edit noise, and for verdicts you want checked by a fresh context.

### Do I need Gemini, Grok and Codex?

No. `codex`, `grok` and `agy` are optional; each one you want to use must be logged in. `spick doctor` lists which are installed and logged in.

### What does setup change, and can I undo it?

Before it writes anything, `--install` backs up `CLAUDE.md`, `settings.json` and `spick.json` into `~/.claude/spick-backup/<timestamp>/`. `--uninstall` removes only what the install wrote; see [Uninstall](#uninstall).

### Can I use Spick without the dashboard mod?

Yes. Without the band, replies name their participants in the label line. The spend record needs the mod: the bash hook sees no usage.

### Where do lane keys go?

A key stored as `keychain:<name>` works on macOS only. On Linux and Windows, use `env:<VAR>`.

## Known limitations

Spick does not change the main session's model. A mod can rewrite the model and effort of each request (`turn.step` in the engine types of Claude Code 2.1.299); claude-router and claude-agent-tools do that. Spick leaves it to them and composes with claude-router, so the main session runs on the lower-cost model and triages by checklist. The checklist is advice: the main session can still keep a task it should have delegated, which is what the Hint line and the deliverable-shaped item 2 are there to prevent.

## Related projects

[alexei-led/claude-router](https://github.com/alexei-led/claude-router) switches the main session's model on each turn and can run alongside Spick.

## Contributing

Issues and pull requests are welcome.

Layout: routing rules live in `skills/spick/`; the band and pane live in `mod/spick-dashboard/`.

CI (`.github/workflows/ci.yml`) runs the python unit tests and the mod tests. To run them locally, from the repo root:

- Python unit tests: `cd skills/spick/scripts && python3 -m unittest -q`
- Mod tests: `claude plugin test mod/spick-dashboard`

The images in this README are generated from the mod's own band and table code. To regenerate them, run `node --experimental-strip-types docs/images/make-art.mts` from the repo root.

## Buy me a coffee

Spick is free and MIT licensed. If it saves you time and you want to support the author, you can send a tip on BNB Smart Chain.

<p><img src="docs/images/bnb-qr.jpg" alt="QR code of the author's BNB Smart Chain address" width="220"><br>
<sub>BNB Smart Chain · for supporting the author</sub></p>

Address (BNB Smart Chain):

    0x25Ca60556e44a9Fe213cC45177F04413094975F9

Send on BNB Smart Chain only. A transfer on another network may be lost.

## License

MIT, see [LICENSE](LICENSE).
