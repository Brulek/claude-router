# Spick Mod: dashboard design

Date: 2026-10-13. Status: draft for review.

## Purpose

Spick already decides *who* works on each task (Haiku main session, pinned subagents, outside CLIs). Users cannot see that decision while it happens; the only trace is a label line at the end of each reply. The Mod makes routing visible in the Claude Code interface itself, in real time, and does nothing else. Gear changes stay with the small model; the Mod observes, never decides.

Success looks like: a user glances at the band above the prompt and knows, without reading the reply, who is working, on which model, at what effort, and whether anything needs attention. The band reads as part of Claude Code, not as a widget bolted on.

Non-goals for this version: rewriting models or efforts, denying tool calls, replacing the triage hook, quota enforcement. Those are observed and shown, not acted on.

## Visual principles

Appearance is a first-class requirement, not polish at the end. Every screen in this document is binding.

1. **One line, one thought.** The band is a single line that answers one question: who is working now. Everything else lives in the pane.
2. **Hierarchy by weight, not by color.** The lane name is bold; model and effort are normal; counts and hints are dim. Color appears only to mean something.
3. **Three colors, each with one meaning.** `claude` (brand accent) marks the Spick wordmark. `warning` marks something to look at (quota at 80% or more, a review that fired). `error` marks a rule breach (the Haiku session edited a source file). Everything else is `text` or `subtle`. No other colors, no emoji, no spinners.
4. **Fixed rhythm.** Segments are separated by ` · ` (space, middle dot, space). Columns in the pane are padded to fixed widths so rows line up vertically. Numbers are right-aligned.
5. **Nothing jumps.** The band keeps the same slot order in every state so the eye lands on the same place each time. When idle it shows the last turn in dim text instead of disappearing.
6. **Width-aware.** Below 70 columns the band drops the trailing hint, below 50 it drops effort, below 40 it shows the lane and model only. Text uses `wrap="truncate-end"`; the band never wraps to two lines.
7. **Respect the host.** Colors come from theme keys only, so the band follows the user's light or dark theme. The band yields (returns `next(e)`) while a survey is showing or the user hid it.

## The band

Rendered by a `ui.render` hook on `AbovePrompt`. Layout: a single row `Box` with `justifyContent="space-between"`; left group holds the status segments, right group holds the hint.

Active turn, Haiku working alone:

```
spick · you · Haiku 5.5 · low                                     /spick for details
```

Active turn, a subagent working:

```
spick · coder · Sonnet 5.5 · medium · 1 of 2 agents              /spick for details
```

Active turn, an outside lane:

```
spick · Gemini · gemini-3.8-flash · low                           /spick for details
```

Idle, showing the last turn (all dim, hint dropped):

```
spick · last: planner · Opus 5.5 · high · 2m 14s
```

Attention states replace the hint with a short cause; the cause word is colored, nothing else is:

```
spick · coder · Sonnet 5.5 · medium                         codex 7d 83%    ← warning color on "codex 7d 83%"
spick · you · Haiku 5.5 · low                        edited src/lru.py    ← error color on the file name
spick · coder · Sonnet 5.5 · medium                    review: codex    ← warning color on "review: codex"
```

Segment rules:

- `spick` is bold in `claude` color, always first. It is the only branded element.
- Lane: `you` for the main session, the subagent type (`coder`, `planner`, `deep`, `Explore`, …), or the CLI (`Gemini`, `Grok`, `Codex`). Bold.
- Model: a display name. Claude ids map to `Haiku 5.5` / `Sonnet 5.5` / `Opus 5.5` / `Fable 5.1`; CLI models show the id the command named, or nothing if it named none.
- Effort: the level as a word (`low` … `max`). Absent for CLIs that did not name one.
- Agent count appears only when more than one agent ran in this turn: `1 of 2 agents`.
- Idle state prefixes `last:` and appends the turn's wall time, all in `subtle`.
- The hint `/spick for details` is `subtle`; it is dropped first when width is short and whenever an attention state is showing.

Width tiers (terminal columns from `e.viewport.columns`, desktop uses its own width):

| Columns | Shown |
|---|---|
| ≥ 70 | everything |
| 50–69 | no hint, no agent count |
| 40–49 | no effort |
| < 40 | `spick · <lane> · <model>` only |

## The pane

Opened with `/spick` or the hint; title `Spick`. Three sections stacked, each with a bold heading and a one-line description in `subtle`, separated by one blank line. The pane uses `e.viewport.rows` to cap the history list so it never scrolls past the bottom.

```
Spick                                                         stop picking, just start

This session
  lane      turns   est. cost
  you          11      $0.04
  coder         3      $0.21
  planner       1      $0.13
  Gemini        2       —
  total        17      $0.38     list price, not a bill

Quota                                      refreshed 4m ago
  claude  5h  ▰▰▱▱▱▱▱▱▱▱   5%     7d  ▰▱▱▱▱▱▱▱▱▱   1%
  codex   7d  ▰▰▰▱▱▱▱▱▱▱  30%
  grok        unknown
  gemini      unknown

Recent turns
  12:41  coder    Sonnet 5.5  medium   44s   review: skipped
  12:38  you      Haiku 5.5   low       6s
  12:31  planner  Opus 5.5    high   2m14s
  12:20  Gemini   3.8-flash   low      31s   quota unmeasured
```

Rules:

- The header line carries the title bold on the left and the slogan in `subtle` on the right, same row, `space-between`.
- Table columns are padded with spaces to fixed widths computed from the longest value in the column, so digits line up; costs are right-aligned to two decimals; the em dash marks "not priced" for outside lanes.
- Quota bars are ten cells of `▰` (used) and `▱` (free); at 80% or more the bar and percentage take `warning`; `unknown` is `subtle` text, no bar.
- `refreshed 4m ago` tells the user how stale the numbers are; the Mod reads the two local files at most every ten minutes.
- Recent turns shows the newest first, at most `rows - 14` entries; the trailing note column carries attention causes in their colors.
- No borders inside the pane. Structure comes from spacing and weight, as in Claude Code's own panes.

## Behaviour

What the Mod observes and how it turns it into state:

| Event | What is recorded |
|---|---|
| `turn.start` | new turn record: start time, lane `you`, model and effort from the first `turn.step` |
| `turn.step` (main loop) | current model and effort for the `you` lane |
| `agent.spawn` | a subagent starts: lane = subagent type, model from the spawn result; count per turn |
| `tool.call` on `Bash` | if the command starts a known CLI (`agy -p`, `grok -p` / `grok agent`, `codex exec`), lane = that CLI; `--model` / `-m` and `--effort` / `model_reasoning_effort` are parsed for display; `codex exec … review` sets `review: codex` |
| `tool.call` on `Edit` or `Write` from the main loop while its model is Haiku | if the path is a source file (not `.md`, `.txt`, `.json`, `.csv`, plan files, or anything under `.claude/`), set the breach note `edited <file>` for this turn |
| `turn.complete` | close the record with wall time; roll counts and estimated cost into the session table |
| `session.start` | register `/spick`; read quota; add a `prompt.compose` section telling the model the band is active so it omits the label line |

Cost estimate: tokens per model from the engine's usage events when available, multiplied by the list prices held in a small table in the Mod; otherwise the cell shows `—`. The pane says "list price, not a bill" next to the total.

Quota: the same two sources as `scripts/quota.sh`. `~/.claude.json` → `cachedUsageUtilization` for Claude; newest `~/.codex/sessions/**/*.jsonl` with `rate_limits` for Codex. Grok and Gemini are `unknown`. Read through `$.fs`, cached for ten minutes, refreshed on pane open.

Label line: while the Mod is loaded, a `prompt.compose` hook appends a session-scoped section: "The Spick status band is showing; do not print the `[Model: … | Effort: …]` line." Without the Mod the skill's rule stands.

Hide: a `Hide` action in the pane sets a session flag; the band returns `next(e)` while hidden. `/spick show` clears it.

## State

All values live in `$.state` under `spick`, declared in `types/index.d.ts`:

- `current`: the active turn record or null
- `last`: the most recent completed turn record
- `turns`: the last 50 completed records
- `totals`: per-lane `{ turns, tokensIn, tokensOut, costUsd | null }`
- `quota`: `{ claude: {...} | null, codex: {...} | null, readAt }`
- `hidden`: boolean

`$.store` is not used; the dashboard is per session by design.

## Files

```
mod/spick-dashboard/
├── .claude-plugin/plugin.json
├── hooks/hooks.json
├── hooks/register.tsx        events → state, band, pane, command
├── hooks/format.ts           display names, width tiers, padding, bars (pure functions)
├── hooks/quota.ts            the two file readers (pure parse + $.fs)
├── hooks/format.test.ts      width tiers, padding, name mapping, bar rendering
├── hooks/quota.test.ts       parsing of both file shapes, staleness
└── types/index.d.ts          PluginState contract
```

Shipped inside the Spick repository under `mod/`, installed with `claude plugin install spick-dashboard --marketplace Brulek/spick` once a `marketplace.json` is added; during development loaded by hot reload from the dev-mods folder.

## Verification

1. `claude plugin validate mod/spick-dashboard` passes; `tsc -p` passes; `claude plugin test` runs both test files green.
2. Interactive, terminal, width ≥ 70: idle band shows `last:` dim; a chore shows `you · Haiku 5.5`; a code task shows `coder · Sonnet 5.5 · <effort>` while the agent runs; an `agy -p` call shows `Gemini`.
3. Resize the terminal to 60, 45, 35 columns: the band drops segments in the documented order and never wraps.
4. Edit a `.py` file from the Haiku main session: the band shows `edited <file>` in error color for that turn only.
5. `/spick` opens the pane; columns align; quota bars match `scripts/quota.sh`; `Hide` hides the band and `/spick show` restores it.
6. Desktop app: the same checks in the Code tab; the band and pane render on the `desktop` surface.
7. With the Mod loaded, replies carry no label line; with it unloaded, the label line returns.
