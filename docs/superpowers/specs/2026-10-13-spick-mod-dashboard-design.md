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

Rendered by a `ui.render` hook on `AbovePrompt`. Layout: a single row `Box` with `justifyContent="space-between"`; the left group is the status sentence, the right group is context (hint, main-session model, quota summary, or the attention cause). The wordmark is followed by three spaces, then segments separated by ` · `.

Every state reads as a short sentence. No pronouns, no bare abbreviations: `high effort`, `took 36s`, `agent 2 of 2`.

Active, the main session itself working (elapsed time ticks on each model chunk or tool call):

```
spick   Working · Fable 5.1 · high effort · 12s                                    /spick for details
```

Active, a subagent working (right group names the main session's model):

```
spick   coder is working · Sonnet 5.5 · medium effort · agent 2 of 2 · 44s         main: Fable 5.1
```

Active, an outside CLI (verb by lane: Gemini `is searching`, Grok `is fetching X`, Codex `is reviewing` when the call is a review, else `is working`):

```
spick   Gemini is searching · gemini-3.8-flash · low effort · 31s                  main: Fable 5.1
```

Idle (all `subtle` after the wordmark; right group is a quota summary of the known providers, blank when none is known):

```
spick   Idle · last turn: coder on Sonnet 5.5 · medium effort · took 2m 14s        quota: claude 7d 1% · codex 7d 30%
spick   Idle · last turn: Fable 5.1 · high effort · took 36s                       quota: claude 7d 1% · codex 7d 30%
```

Attention states replace the right group with the cause; only the cause word is colored:

```
spick   Working · Haiku 5.5 · low effort · 8s                                      edited src/lru.py      ← error color on the file name
spick   coder is working · Sonnet 5.5 · medium effort · 44s                        review: codex          ← warning
spick   Working · Haiku 5.5 · low effort · 8s                                      codex 7d 83%           ← warning
```

Segment rules:

- `spick` is bold in `claude` color, always first, followed by three spaces (not a separator).
- Subject: `Working` for the main session; `<lane> is working` for a subagent (bold lane name); `<CLI> is <verb>` for an outside lane. Idle: `Idle`, then `last turn: <subject-in-past-form>` where a delegate reads `coder on Sonnet 5.5` and the main session reads just the model.
- Model: display name (`Haiku 5.5` / `Sonnet 5.5` / `Opus 5.5` / `Fable 5.1`, or the CLI model id). Absent for a CLI call that named none.
- Effort: `<level> effort`. Absent when unknown.
- Agent ordinal: `agent <n> of <m>` only while a subagent is active and more than one agent ran this turn.
- Elapsed: `<duration>` while active (refreshed on every `turn.step` chunk and `tool.call`), `took <duration>` when idle.
- Right group precedence: attention cause > (active delegate: `main: <model>`) > (active main: `/spick for details`) > (idle: `quota: …` summary, omitted when nothing is known).

Width tiers (from `e.props.bodyColumns`):

| Columns | Shown |
|---|---|
| ≥ 90 | everything |
| 70–89 | no right group except an attention cause |
| 50–69 | also no agent ordinal, no elapsed; `effort` keeps its word |
| 40–49 | also no effort; attention cause and idle duration still show |
| < 40 | `spick · <lane or Working> · <model>` only |

"Elapsed" in the 50–69 row means the active timer only; the idle `took <duration>` keeps showing from 40 columns up. Below 40 the idle band reads `spick · Idle · <model>` (the last turn's model), all `subtle` after the wordmark.

The band never wraps: every `Text` in it has `wrap="truncate-end"`.

## The pane

Opened with `/spick` or the hint; title `Spick`. Three sections stacked, each with a bold heading, separated by one blank line. The pane uses `e.props.scroll.bodyRows` to cap the history list so it never scrolls past the bottom.

```
Spick                                                         stop picking, just start

This session
  lane      turns   est. cost
  main session 11      $0.04
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
  12:38  main session  Haiku 5.5   low       6s
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
| `turn.start` | new turn record: start time, lane `main session`, model and effort from the first `turn.step`; clears the in-flight calls and the delegate record; refreshes quota (the ten-minute TTL gates the read) |
| `turn.step` (main loop) | current model and effort for the `main session` lane |
| `tool.call` on `Agent` | a subagent call starts: an in-flight entry keyed by `tool_use_id` (lane = `subagent_type`, else `agent`; model and effort as the call named them; its ordinal among this turn's agents), which also becomes the turn's delegate; the entry leaves when a foreground call returns |
| `agent.spawn` | the in-flight entry with the same `tool_use_id` takes the resolved `subagentType` as its lane and the spawn result's model; a background agent's entry leaves on its own `turn.complete` |
| `tool.call` on `Bash` | if any command segment (split on `;` `&` `|` `(` and newlines) starts a known CLI (`agy -p`, `grok -p` / `grok agent`, `codex exec`), an in-flight entry for that CLI, which also becomes the turn's delegate, and one turn on that CLI's totals row (no tokens, unpriced); `--model` / `-m` and `--effort` / `model_reasoning_effort` are parsed for display; `codex exec … review` sets `review: codex`; the entry leaves when the call returns |
| `tool.call` on `Edit` or `Write` from the main loop while its model is Haiku | if the path is a source file (not `.md`, `.txt`, `.json`, `.csv`, plan files, or anything under `.claude/`), set the breach note `edited <file>` for this turn |
| `turn.complete` | close the record with wall time under the turn's delegate (lane, model, effort; `main session` when it had none); roll the loop's usage and estimated cost into the session table under the loop's own lane (`main session` for main, the subagent type for a subagent) |
| `session.start` | register `/spick`; read quota |
| `prompt.compose` | when the render's `surfaces` include `terminal` or `desktop` and the band is not hidden, add a section telling the model the band is showing so it omits the label line |

Lane on the band: every Agent or CLI call in flight is held in a map keyed by `tool_use_id`, in start order. The band shows the most recent entry still in the map and falls back to `main session` only when the map is empty, so parallel agents never show the wrong lane and one finishing early does not drop the band to `main session` while another still works.

Delegate record: alongside the map, each turn keeps one `delegate` (lane, model, effort), set whenever an Agent or CLI call starts and never cleared when the call ends. At `turn.complete` the closed record in `last` and `turns` takes its lane, model and effort from the delegate, `main session` when the turn had none, so the idle band reads `Idle · last turn: planner on Opus 5.5 · high effort · took 2m 14s` and recent turns list delegates.

Cost estimate: tokens per model from the engine's usage events when available (input, output, cache read, cache write; cache write is priced at 1.25 × input), multiplied by the list prices held in a small table in the Mod; otherwise the cell shows `—`. Outside CLIs report no usage, so their rows count turns and show `—`. The pane says "list price, not a bill" next to the total.

Quota: the same two sources as `scripts/quota.sh`. `~/.claude.json` → `cachedUsageUtilization` for Claude; newest `$CODEX_HOME/sessions/**/*.jsonl` (default `~/.codex`) with `rate_limits` for Codex, walking days newest first and files newest first within a day, skipping files over 4 MiB (the engine refuses to read them), stopping at the first that parses or after 20 files. Grok and Gemini are `unknown`. Read through `$.fs`, cached for ten minutes, refreshed at session start, at each turn start (within the TTL) and on pane open.

Label line: while the band shows, a `prompt.compose` hook appends a session-scoped section: "The Spick status band is showing; do not print the `[Model: … | Effort: …]` line." It does so only when the render's `surfaces` include `terminal` or `desktop` (the surfaces that draw `AbovePrompt`) and the band is not hidden; under `claude -p` or the SDK (no surfaces), in VS Code, or with the band hidden, the label line stays. Without the Mod the skill's rule stands.

Hide: a `Hide` action in the pane sets a session flag; the band returns `next(e)` while hidden. `/spick show` clears it.

## State

All values live in `$.state` under `spick-dashboard`, declared in `types/index.d.ts`:

- `current`: the active turn record or null (while an agent shows, it carries that agent's ordinal as `agentIndex`)
- `last`: the most recent completed turn record
- `turns`: the last 50 completed records
- `totals`: per-lane `{ turns, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd | null }`
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
├── hooks/quota.test.ts       parsing of both file shapes, staleness, the Codex session walk
├── hooks/register.test.ts    events → state: lanes, delegate record, totals, label-line section
├── hooks/band.test.tsx       band and pane rendering on terminal and desktop
└── types/index.d.ts          PluginState contract
```

Shipped inside the Spick repository under `mod/`, installed with `claude plugin install spick-dashboard --marketplace Brulek/spick` once a `marketplace.json` is added; during development loaded by hot reload from the dev-mods folder.

## Verification

1. `claude plugin validate mod/spick-dashboard` passes; `tsc -p` passes; `claude plugin test` runs all four test files green.
2. Interactive, terminal, width ≥ 70: idle band shows `Idle · last turn:` dim; a chore shows `Working · Haiku 5.5`; a code task shows `coder · Sonnet 5.5 · <effort>` while the agent runs; an `agy -p` call shows `Gemini`.
3. Resize the terminal to 60, 45, 35 columns: the band drops segments in the documented order and never wraps.
4. Edit a `.py` file from the Haiku main session: the band shows `edited <file>` in error color for that turn only.
5. `/spick` opens the pane; columns align; quota bars match `scripts/quota.sh`; `Hide` hides the band and `/spick show` restores it.
6. Desktop app: the same checks in the Code tab; the band and pane render on the `desktop` surface.
7. With the Mod loaded and the band showing, replies carry no label line; with the band hidden, under `claude -p`, or with the Mod unloaded, the label line returns.
