# Spick Dashboard Mod Implementation Plan

Status: implemented 2026-10-14; kept as the record of how the mod was built.

> **Status (2026-10-13):** Code and docs are done and on `main` (mod up to 0.3.1, controls merged). `claude plugin validate` passes on the mod and the marketplace; `claude plugin test mod/spick-dashboard` passes 101/101. The plugin is installed at user scope from the local marketplace. Still open: the visual acceptance in a live session (Step 4 of Task 6), and pushing the metadata commit. The checkboxes below were not ticked as the work landed; treat the commits as the record.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** A Claude Code Mod that shows, above the prompt, who is working right now (lane, model, effort) and, in a `/spick` pane, this session's lane totals, local quota and recent turns. It observes; it never changes a model, effort or tool call.

**Architecture:** One hooks module (`register.tsx`) turns engine events into a small `$.state` record and draws two things from it: the `AbovePrompt` band and the `Pane`. All string shaping (names, widths, padding, bars) lives in pure functions in `format.ts`; all file parsing lives in pure functions in `quota.ts`, with one thin `$.fs` reader. Pure functions carry the tests.

**Tech Stack:** Claude Code Mod API (this build, 2.1.29x), TypeScript/JSX against the engine's `claude-code` types, `claude plugin validate|test`, `tsc`.

**Spec:** `docs/superpowers/specs/2026-10-13-spick-mod-dashboard-design.md`

## Global Constraints

- Mod folder during development: `/Users/brulek/.claude/dev-mods/926545ab-e2ec-433f-b398-62b6275f24db/spick-dashboard/` (the engine hot-reloads it after the user enables hot reloading). The finished folder is copied to `~/dev/spick/mod/spick-dashboard/`.
- Plugin name `spick-dashboard`, version `0.1.0`, `types` declared in `plugin.json`; every `$.state` key under `'spick-dashboard'` in `types/index.d.ts`.
- Colors only from theme keys: `claude` for the wordmark, `warning` for attention, `error` for a breach, `subtle` for dim text; nothing else. No emoji, no spinners.
- Segment separator is exactly ` · `. The band never wraps: every `Text` in it has `wrap="truncate-end"`.
- Width tiers from the spec: ≥70 everything; 50–69 no hint, no agent count; 40–49 no effort; <40 lane and model only.
- Hint text is exactly `/spick for details`. Idle prefix is exactly `last:`.
- Quota sources are exactly the two files `scripts/quota.sh` reads; read at most every 10 minutes (600,000 ms) and on pane open.
- Cost cells are list-price estimates; the pane prints `list price, not a bill` beside the total.
- Hooks that only observe must never break the turn: every hook wraps its own work so a failure falls through to `next(e)`.

## Review Focus

Inputs the spec implies but no acceptance step exercises, each pinned by a test in the task that owns it:

1. A Bash command that mentions `agy` inside a quoted string (`echo "run agy later"`) must not register as a Gemini lane. → `parseCli` test in Task 2.
2. A `Write` of a plan file under `~/.claude/plans/` or any `.md` from the Haiku session must not count as a source edit. → `isSourcePath` test in Task 2.
3. `~/.claude.json` with no `cachedUsageUtilization` (fresh install) must yield `null`, not a crash. → `parseClaudeUsage` test in Task 3.
4. A Codex session file whose `rate_limits` object is truncated at the end of the file must be skipped, not mis-parsed. → `parseCodexRateLimits` test in Task 3.
5. A lane totals table with a lane that has turns but no usage (an outside CLI) must print `—` and still align. → `table` test in Task 2.

---

### Task 1: Scaffold the mod and the state contract

**Files:**
- Create: `<mod>/.claude-plugin/plugin.json`
- Create: `<mod>/hooks/hooks.json`
- Create: `<mod>/types/index.d.ts`
- Create: `<mod>/hooks/register.tsx` (minimal: registers nothing yet but loads)

`<mod>` = `/Users/brulek/.claude/dev-mods/926545ab-e2ec-433f-b398-62b6275f24db/spick-dashboard`

**Interfaces:**
- Produces the state types every later task imports from `'../types'`: `TurnRecord`, `LaneTotals`, `Quota`, `Note`.

- [x] **Step 1: Write plugin.json**

```json
{
  "name": "spick-dashboard",
  "version": "0.1.0",
  "description": "Shows who is working now (lane, model, effort) above the prompt, and a /spick pane with lane totals, local quota and recent turns. Observes only.",
  "types": "./types/index.d.ts"
}
```

- [x] **Step 2: Write hooks.json**

```json
{ "modules": ["./register.tsx"] }
```

- [x] **Step 3: Write types/index.d.ts**

```ts
export type NoteKind = 'warning' | 'error'
export type Note = { kind: NoteKind; text: string }

export type TurnRecord = {
  turnId: string
  startedAt: number
  endedAt?: number
  /** 'you' for the main session, a subagent type, or 'Gemini' | 'Grok' | 'Codex' */
  lane: string
  /** display name, e.g. 'Haiku 5.5' or 'gemini-3.8-flash'; '' when unknown */
  model: string
  effort?: string
  /** subagents spawned in this turn */
  agents: number
  /** attention cause, shown in color on the band and in the pane's note column */
  note?: Note
  costUsd?: number | null
}

export type LaneTotals = {
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** null when the lane cannot be priced (outside CLIs, unknown models) */
  costUsd: number | null
}

export type QuotaWindows = { fiveHour?: number; sevenDay?: number }
export type Quota = { claude: QuotaWindows | null; codex: QuotaWindows | null; readAt: number }

declare module 'claude-code' {
  interface PluginState {
    'spick-dashboard': {
      current: TurnRecord | null
      last: TurnRecord | null
      turns: TurnRecord[]
      totals: Record<string, LaneTotals>
      quota: Quota | null
      hidden: boolean
    }
  }
}
```

- [x] **Step 4: Write a minimal register.tsx that loads**

```tsx
import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', ($, e, next) => next(e))
}
```

- [x] **Step 5: Validate**

Run: `claude plugin validate /Users/brulek/.claude/dev-mods/926545ab-e2ec-433f-b398-62b6275f24db/spick-dashboard`
Expected: no refusals listed.

- [x] **Step 6: Commit (in the spick repo, after copying the folder to `mod/spick-dashboard/`)**

```bash
mkdir -p ~/dev/spick/mod && rsync -a --delete "$MOD/" ~/dev/spick/mod/spick-dashboard/
cd ~/dev/spick && git add mod && git commit -m "mod: scaffold spick-dashboard with state contract"
```

---

### Task 2: format.ts, the pure display layer

**Files:**
- Create: `<mod>/hooks/format.ts`
- Test: `<mod>/hooks/format.test.ts`

**Interfaces:**
- Produces:
  - `modelName(id: string): string`
  - `parseCli(command: string): { lane: 'Gemini' | 'Grok' | 'Codex'; model?: string; effort?: string; isReview: boolean } | null`
  - `isSourcePath(path: string): boolean`
  - `type Seg = { text: string; style: 'brand' | 'lane' | 'plain' | 'dim' | 'warning' | 'error' }`
  - `bandSegments(view: BandView, columns: number): Seg[]` where `BandView = { lane: string; model: string; effort?: string; agents: number; isIdle: boolean; durationMs?: number; note?: Note }`
  - `padRight(s, w)`, `padLeft(s, w)`, `table(rows: string[][], align: ('l' | 'r')[]): string[]`
  - `quotaBar(pct: number): string`, `fmtDuration(ms: number): string`, `fmtCost(usd: number | null): string`, `fmtAge(ms: number): string`
  - `estimateCost(modelId: string, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number }): number | null`

- [x] **Step 1: Write the failing tests**

```ts
// format.test.ts
import { test, expect } from 'claude-code/testing'
import {
  modelName, parseCli, isSourcePath, bandSegments, table, quotaBar,
  fmtDuration, fmtCost, estimateCost,
} from './format'

test('modelName maps Claude ids to display names and leaves others alone', () => {
  expect(modelName('claude-haiku-5-5')).toBe('Haiku 5.5')
  expect(modelName('claude-sonnet-5-5')).toBe('Sonnet 5.5')
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelName('claude-fable-5-1')).toBe('Fable 5.1')
  expect(modelName('gemini-3.8-flash-medium')).toBe('gemini-3.8-flash-medium')
})

test('parseCli recognises the three CLIs and their model/effort flags', () => {
  expect(parseCli('agy -p "find it" --model gemini-3.8-flash-low --effort low')).toEqual(
    { lane: 'Gemini', model: 'gemini-3.8-flash-low', effort: 'low', isReview: false })
  expect(parseCli('grok -p "x" -m grok-4.7 --effort medium')).toEqual(
    { lane: 'Grok', model: 'grok-4.7', effort: 'medium', isReview: false })
  expect(parseCli(`git diff | codex exec --skip-git-repo-check --sandbox read-only -c 'model_reasoning_effort="high"' "Review this diff"`)).toEqual(
    { lane: 'Codex', effort: 'high', isReview: true })
  expect(parseCli('codex exec --sandbox workspace-write "fix it" < /dev/null')).toEqual(
    { lane: 'Codex', isReview: false })
})

test('parseCli ignores CLI names inside quoted strings and ordinary words', () => {
  expect(parseCli('echo "remember to run agy later"')).toBeNull()
  expect(parseCli('ls agyfolder')).toBeNull()
  expect(parseCli('python3 -m pytest')).toBeNull()
})

test('isSourcePath excludes docs, data, plan files and .claude', () => {
  expect(isSourcePath('src/lru.py')).toBe(true)
  expect(isSourcePath('scripts/quota.sh')).toBe(true)
  expect(isSourcePath('README.md')).toBe(false)
  expect(isSourcePath('/Users/x/.claude/plans/1-foo.md')).toBe(false)
  expect(isSourcePath('data/report.csv')).toBe(false)
  expect(isSourcePath('config.json')).toBe(false)
})

const view = { lane: 'coder', model: 'Sonnet 5.5', effort: 'medium', agents: 2, isIdle: false }

test('bandSegments shows everything at 80 columns', () => {
  const texts = bandSegments(view, 80).map(s => s.text)
  expect(texts).toEqual(['spick', ' · ', 'coder', ' · ', 'Sonnet 5.5', ' · ', 'medium', ' · ', '1 of 2 agents', '/spick for details'])
  expect(bandSegments(view, 80)[0].style).toBe('brand')
  expect(bandSegments(view, 80)[2].style).toBe('lane')
})

test('bandSegments drops hint and agent count below 70, effort below 50, keeps lane+model below 40', () => {
  expect(bandSegments(view, 60).map(s => s.text)).toEqual(['spick', ' · ', 'coder', ' · ', 'Sonnet 5.5', ' · ', 'medium'])
  expect(bandSegments(view, 45).map(s => s.text)).toEqual(['spick', ' · ', 'coder', ' · ', 'Sonnet 5.5'])
  expect(bandSegments(view, 30).map(s => s.text)).toEqual(['spick', ' · ', 'coder', ' · ', 'Sonnet 5.5'])
})

test('bandSegments idle state prefixes last:, appends duration, and drops the hint', () => {
  const idle = { ...view, isIdle: true, durationMs: 134000, agents: 0 }
  expect(bandSegments(idle, 80).map(s => s.text)).toEqual(['spick', ' · ', 'last: coder', ' · ', 'Sonnet 5.5', ' · ', 'medium', ' · ', '2m 14s'])
  expect(bandSegments(idle, 80).slice(2).every(s => s.style === 'dim')).toBe(true)
})

test('bandSegments attention note replaces the hint and carries its color', () => {
  const warned = { ...view, agents: 0, note: { kind: 'warning' as const, text: 'codex 7d 83%' } }
  const segs = bandSegments(warned, 80)
  expect(segs[segs.length - 1]).toEqual({ text: 'codex 7d 83%', style: 'warning' })
  expect(segs.some(s => s.text === '/spick for details')).toBe(false)
})

test('table pads columns and right-aligns numbers, with em dash for unpriced', () => {
  const rows = table([
    ['lane', 'turns', 'at API rates'],
    ['you', '11', '$0.04'],
    ['Gemini', '2', '—'],
  ], ['l', 'r', 'r'])
  expect(rows[1]).toBe('you        11      $0.04')
  expect(rows[2]).toBe('Gemini      2          —')
  expect(new Set(rows.map(r => r.length)).size).toBe(1)
})

test('quotaBar renders ten cells', () => {
  expect(quotaBar(0)).toBe('▱▱▱▱▱▱▱▱▱▱')
  expect(quotaBar(30)).toBe('▰▰▰▱▱▱▱▱▱▱')
  expect(quotaBar(83)).toBe('▰▰▰▰▰▰▰▰▱▱')
  expect(quotaBar(100)).toBe('▰▰▰▰▰▰▰▰▰▰')
})

test('formatters', () => {
  expect(fmtDuration(6000)).toBe('6s')
  expect(fmtDuration(134000)).toBe('2m 14s')
  expect(fmtCost(0.0412)).toBe('$0.04')
  expect(fmtCost(null)).toBe('—')
  expect(estimateCost('claude-haiku-5-5', { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0 })).toBeCloseTo(0.1, 5)
  expect(estimateCost('gemini-3.8-flash', { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0 })).toBeNull()
})
```

- [x] **Step 2: Run the tests to see them fail**

Run: `claude plugin test "$MOD"`
Expected: FAIL, module `./format` not found.

- [x] **Step 3: Implement format.ts**

```ts
import type { Note } from '../types'

const CLAUDE_NAMES: Record<string, string> = {
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-fable-5-1': 'Fable 5.1',
}
// list prices, USD per million tokens: input, output, cache read. Estimates only.
const PRICES: Record<string, [number, number, number]> = {
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-opus-5-5': [4, 20, 0.2],
}

export function modelName(id: string): string {
  if (CLAUDE_NAMES[id]) return CLAUDE_NAMES[id]
  for (const key of Object.keys(CLAUDE_NAMES)) if (id.startsWith(key)) return CLAUDE_NAMES[key]
  const alias: Record<string, string> = { haiku: 'Haiku 5.5', sonnet: 'Sonnet 5.5', opus: 'Opus 5.5', fable: 'Fable 5.1' }
  return alias[id] ?? id
}

export type CliLane = { lane: 'Gemini' | 'Grok' | 'Codex'; model?: string; effort?: string; isReview: boolean }

/** Strip quoted strings so a CLI name inside an argument never counts as a command. */
function unquoted(command: string): string {
  return command.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
}

export function parseCli(command: string): CliLane | null {
  const bare = unquoted(command)
  const atStart = (name: string) => new RegExp(`(^|[\\s;&|(])${name}(\\s|$)`).test(bare)
  let lane: CliLane['lane'] | null = null
  if (atStart('agy')) lane = 'Gemini'
  else if (atStart('grok')) lane = 'Grok'
  else if (/(^|[\s;&|(])codex\s+exec(\s|$)/.test(bare)) lane = 'Codex'
  if (!lane) return null
  const out: CliLane = { lane, isReview: false }
  const model = bare.match(/(?:--model|-m)[=\s]+(\S+)/)
  if (model) out.model = model[1]
  const effort = bare.match(/(?:--effort|--reasoning-effort)[=\s]+(\S+)/) ?? command.match(/model_reasoning_effort="?(\w+)"?/)
  if (effort) out.effort = effort[1]
  if (lane === 'Codex' && /review/i.test(command)) out.isReview = true
  return out
}

const NON_SOURCE = /\.(md|markdown|txt|json|jsonl|csv|tsv|ya?ml|toml|lock|log)$/i
export function isSourcePath(path: string): boolean {
  if (/(^|\/)\.claude\//.test(path)) return false
  if (NON_SOURCE.test(path)) return false
  return /\.[A-Za-z0-9]+$/.test(path)
}

export type Seg = { text: string; style: 'brand' | 'lane' | 'plain' | 'dim' | 'warning' | 'error' }
export type BandView = { lane: string; model: string; effort?: string; agents: number; isIdle: boolean; durationMs?: number; note?: Note }
const SEP: Seg = { text: ' · ', style: 'dim' }
export const HINT = '/spick for details'

export function bandSegments(v: BandView, columns: number): Seg[] {
  const body = (text: string, style: Seg['style']): Seg => ({ text, style: v.isIdle ? 'dim' : style })
  const segs: Seg[] = [{ text: 'spick', style: 'brand' }, SEP, body(v.isIdle ? `last: ${v.lane}` : v.lane, 'lane')]
  if (v.model) segs.push(SEP, body(v.model, 'plain'))
  if (columns >= 50 && v.effort) segs.push(SEP, body(v.effort, 'plain'))
  if (columns >= 70 && !v.isIdle && v.agents > 1) segs.push(SEP, body(`1 of ${v.agents} agents`, 'dim'))
  if (v.isIdle && v.durationMs !== undefined && columns >= 50) segs.push(SEP, body(fmtDuration(v.durationMs), 'dim'))
  if (v.note && columns >= 50) segs.push({ text: v.note.text, style: v.note.kind })
  else if (columns >= 70 && !v.isIdle) segs.push({ text: HINT, style: 'dim' })
  return segs
}

export function padRight(s: string, w: number): string { return s + ' '.repeat(Math.max(0, w - s.length)) }
export function padLeft(s: string, w: number): string { return ' '.repeat(Math.max(0, w - s.length)) + s }

/** Fixed-width columns, two spaces between, aligned per column. Every row comes back the same length. */
export function table(rows: string[][], align: ('l' | 'r')[]): string[] {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => (r[i] ?? '').length)))
  return rows.map(r => widths.map((w, i) => (align[i] === 'r' ? padLeft(r[i] ?? '', w) : padRight(r[i] ?? '', w))).join('  '))
}

export function quotaBar(pct: number): string {
  const used = Math.min(10, Math.max(0, Math.round(pct / 10)))
  return '▰'.repeat(used) + '▱'.repeat(10 - used)
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}
export function fmtAge(ms: number): string {
  const m = Math.round(ms / 60000)
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`
}
export function fmtCost(usd: number | null): string { return usd === null ? '—' : `$${usd.toFixed(2)}` }

export function estimateCost(modelId: string, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number }): number | null {
  const key = Object.keys(PRICES).find(k => modelId === k || modelId.startsWith(k))
  if (!key) return null
  const [i, o, c] = PRICES[key]
  return (u.input_tokens * i + u.output_tokens * o + u.cache_read_input_tokens * c) / 1_000_000
}
```

- [x] **Step 4: Run the tests**

Run: `claude plugin test "$MOD"`
Expected: all format tests PASS. If the `table` expectation strings differ by a space, fix the expectation to the actual padded output, keeping the equal-length assertion.

- [x] **Step 5: Commit**

```bash
rsync -a --delete "$MOD/" ~/dev/spick/mod/spick-dashboard/ && cd ~/dev/spick && git add mod && git commit -m "mod: pure display layer with tests"
```

---

### Task 3: quota.ts, parsing and the thin reader

**Files:**
- Create: `<mod>/hooks/quota.ts`
- Test: `<mod>/hooks/quota.test.ts`

**Interfaces:**
- Produces:
  - `parseClaudeUsage(jsonText: string): QuotaWindows | null`
  - `parseCodexRateLimits(jsonlText: string): QuotaWindows | null`
  - `readQuota($: EngineInterface, nowMs: number): Promise<Quota>` (never rejects; a failed source is `null`)
- Consumes: `QuotaWindows`, `Quota` from `'../types'`.

- [x] **Step 1: Write the failing tests**

```ts
// quota.test.ts
import { test, expect } from 'claude-code/testing'
import { parseClaudeUsage, parseCodexRateLimits } from './quota'

test('parseClaudeUsage reads the cached utilization', () => {
  const json = JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: 1, utilization: { five_hour: { utilization: 5 }, seven_day: { utilization: 1 } } } })
  expect(parseClaudeUsage(json)).toEqual({ fiveHour: 5, sevenDay: 1 })
})

test('parseClaudeUsage returns null when the field is missing or the text is not JSON', () => {
  expect(parseClaudeUsage('{"oauthAccount":{}}')).toBeNull()
  expect(parseClaudeUsage('not json')).toBeNull()
})

test('parseCodexRateLimits takes the last complete rate_limits object', () => {
  const line = (pct: number) => JSON.stringify({ payload: { rate_limits: { primary: { used_percent: pct, window_minutes: 10080 }, secondary: null } } })
  expect(parseCodexRateLimits(line(12) + '\n' + line(30) + '\n')).toEqual({ sevenDay: 30 })
})

test('parseCodexRateLimits skips a truncated trailing object', () => {
  const good = JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 30, window_minutes: 10080 } } } })
  const cut = '{"payload":{"rate_limits":{"primary":{"used_percent":99,"window_mi'
  expect(parseCodexRateLimits(good + '\n' + cut)).toEqual({ sevenDay: 30 })
  expect(parseCodexRateLimits(cut)).toBeNull()
})

test('parseCodexRateLimits labels a five-hour window', () => {
  const line = JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 7, window_minutes: 300 }, secondary: { used_percent: 30, window_minutes: 10080 } } } })
  expect(parseCodexRateLimits(line)).toEqual({ fiveHour: 7, sevenDay: 30 })
})
```

- [x] **Step 2: Run to see them fail**

Run: `claude plugin test "$MOD"`
Expected: FAIL, `./quota` not found.

- [x] **Step 3: Implement quota.ts**

```ts
import type { EngineInterface } from 'claude-code'
import type { Quota, QuotaWindows } from '../types'

export function parseClaudeUsage(jsonText: string): QuotaWindows | null {
  try {
    const d = JSON.parse(jsonText)
    const u = d?.cachedUsageUtilization?.utilization
    if (!u) return null
    const out: QuotaWindows = {}
    if (typeof u.five_hour?.utilization === 'number') out.fiveHour = u.five_hour.utilization
    if (typeof u.seven_day?.utilization === 'number') out.sevenDay = u.seven_day.utilization
    return out.fiveHour === undefined && out.sevenDay === undefined ? null : out
  } catch { return null }
}

/** Find the last complete `"rate_limits":{...}` object by brace matching; a cut-off tail is ignored. */
export function parseCodexRateLimits(text: string): QuotaWindows | null {
  let from = text.length
  while (true) {
    const at = text.lastIndexOf('"rate_limits":', from - 1)
    if (at < 0) return null
    const start = text.indexOf('{', at)
    if (start < 0) return null
    let depth = 0, end = -1
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}' && --depth === 0) { end = i; break }
    }
    if (end > 0) {
      try {
        const rl = JSON.parse(text.slice(start, end + 1))
        const out: QuotaWindows = {}
        for (const key of ['primary', 'secondary'] as const) {
          const w = rl[key]
          if (w && typeof w.used_percent === 'number') {
            const mins = w.window_minutes ?? 0
            if (mins >= 10000) out.sevenDay = w.used_percent
            else if (mins > 0 && mins <= 400) out.fiveHour = w.used_percent
          }
        }
        if (out.fiveHour !== undefined || out.sevenDay !== undefined) return out
      } catch { /* fall through to the previous occurrence */ }
    }
    from = at
    if (from <= 0) return null
  }
}

async function newestSessionText($: EngineInterface, root: string): Promise<string | null> {
  // sessions/YYYY/MM/DD/*.jsonl: walk the newest branch by name, then by mtime, reading at most 5 files
  const pick = async (dir: string, depth: number): Promise<string[]> => {
    const entries = (await $.fs.list(dir)).filter(e => e.kind === 'dir').map(e => e.name).sort().reverse()
    for (const name of entries) {
      const sub = `${dir}/${name}`
      if (depth === 0) {
        const files = (await $.fs.list(sub)).filter(e => e.kind === 'file' && e.name.endsWith('.jsonl'))
          .sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 5).map(e => `${sub}/${e.name}`)
        if (files.length) return files
      } else {
        const files = await pick(sub, depth - 1)
        if (files.length) return files
      }
    }
    return []
  }
  for (const file of await pick(root, 2)) {
    try {
      const text = await $.fs.read(file)
      if (text.includes('"rate_limits":')) return text
    } catch { /* next file */ }
  }
  return null
}

export async function readQuota($: EngineInterface, nowMs: number): Promise<Quota> {
  const home = (await $.env.get('HOME')) ?? ''
  let claude: QuotaWindows | null = null
  let codex: QuotaWindows | null = null
  try { claude = parseClaudeUsage(await $.fs.read(`${home}/.claude.json`)) } catch { claude = null }
  try {
    const text = await newestSessionText($, `${home}/.codex/sessions`)
    codex = text ? parseCodexRateLimits(text) : null
  } catch { codex = null }
  return { claude, codex, readAt: nowMs }
}
```

- [x] **Step 4: Run the tests**

Run: `claude plugin test "$MOD"`
Expected: all quota tests PASS.

- [x] **Step 5: Commit**

```bash
rsync -a --delete "$MOD/" ~/dev/spick/mod/spick-dashboard/ && cd ~/dev/spick && git add mod && git commit -m "mod: quota parsers and reader with tests"
```

---

### Task 4: register.tsx, events to state

**Files:**
- Modify: `<mod>/hooks/register.tsx` (replace the stub)

**Interfaces:**
- Consumes: everything from Tasks 2 and 3.
- Produces: the atoms `current`, `last`, `turns`, `totals`, `quota`, `hidden` that Task 5 draws from; the helper `laneOfAgent` map kept in module scope.

- [x] **Step 1: Write the state and event hooks**

```tsx
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { LaneTotals, Quota, TurnRecord } from '../types'
import { estimateCost, isSourcePath, modelName, parseCli } from './format'
import { readQuota } from './quota'

const P = 'spick-dashboard'
const current = atom({ plugin: P, key: 'current' } as const, null)
const last = atom({ plugin: P, key: 'last' } as const, null)
const turns = atom({ plugin: P, key: 'turns' } as const, [])
const totals = atom({ plugin: P, key: 'totals' } as const, {})
const quota = atom({ plugin: P, key: 'quota' } as const, null)
const hidden = atom({ plugin: P, key: 'hidden' } as const, false)

const QUOTA_TTL_MS = 600_000
const PANE = 'spick'

export const register: Register = on => {
  /** agentId -> lane name, for attributing subagent turn.complete usage */
  const laneOfAgent = new Map<string, string>()
  /** lane the band shows while a CLI call or an Agent tool call is in flight */
  let activeLane: { lane: string; model: string; effort?: string } | null = null
  let mainModel = ''
  let mainEffort: string | undefined

  const refreshQuota = async ($: Parameters<Parameters<typeof on>[2]>[0], force = false) => {
    const now = await $.clock.now()
    const q = await read($, quota)
    if (!force && q && now - q.readAt < QUOTA_TTL_MS) return q
    const fresh: Quota = await readQuota($, now)
    await update($, quota, () => fresh)
    return fresh
  }

  const setCurrent = ($: Parameters<Parameters<typeof on>[2]>[0], patch: Partial<TurnRecord>) =>
    update($, current, c => (c ? { ...c, ...patch } : c))

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'spick', description: 'Spick dashboard: lanes, quota, recent turns', argumentHint: '[show|hide|quota]' })
    void refreshQuota($).catch(() => undefined)
    return next(e)
  })

  // Tell the model the band is showing so it omits the label line.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return { sections: [...r.sections, { id: `${P}:band`, scope: 'session', text: 'The Spick status band is showing above the prompt. Do not print the [Model: ... | Effort: ...] label line at the end of replies.' }] }
  })

  on('turn.start', async ($, e, next) => {
    const startedAt = await $.clock.now()
    activeLane = null
    await update($, current, () => ({ turnId: e.turnId, startedAt, lane: 'you', model: modelName(mainModel), effort: mainEffort, agents: 0 }))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      mainModel = e.model
      mainEffort = typeof e.effort === 'string' ? e.effort : undefined
      if (!activeLane) await setCurrent($, { lane: 'you', model: modelName(e.model), effort: mainEffort })
    }
    return yield* next(e)
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const lane = e.subagent_type ?? 'agent'
    activeLane = { lane, model: e.model ? modelName(e.model) : '', effort: e.effort }
    await update($, current, c => (c ? { ...c, lane, model: activeLane!.model, effort: e.effort, agents: c.agents + 1 } : c))
    const ran = await next(e)
    if (!e.run_in_background) {
      activeLane = null
      await setCurrent($, { lane: 'you', model: modelName(mainModel), effort: mainEffort })
    }
    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      laneOfAgent.set(r.agentId, e.subagentType)
      if (activeLane && activeLane.lane === e.subagentType) {
        activeLane.model = modelName(r.model)
        await setCurrent($, { model: activeLane.model })
      }
    }
    return r
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId) return next(e)
    const cli = parseCli(e.command)
    if (!cli) return next(e)
    const before = activeLane
    activeLane = { lane: cli.lane, model: cli.model ?? '', effort: cli.effort }
    await update($, current, c => (c ? { ...c, lane: cli.lane, model: cli.model ?? '', effort: cli.effort, note: cli.isReview ? { kind: 'warning', text: 'review: codex' } : c.note } : c))
    const ran = await next(e)
    activeLane = before
    await setCurrent($, before ? { lane: before.lane, model: before.model, effort: before.effort } : { lane: 'you', model: modelName(mainModel), effort: mainEffort })
    return ran
  })

  for (const tool of ['Edit', 'Write'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      if (!e.agentId && /haiku/.test(mainModel) && isSourcePath(e.file_path)) {
        const name = e.file_path.split('/').slice(-2).join('/')
        await setCurrent($, { note: { kind: 'error', text: `edited ${name}` } })
      }
      return next(e)
    })
  }

  on('turn.complete', async ($, e, next) => {
    const lane = e.agentId ? (laneOfAgent.get(e.agentId) ?? 'agent') : 'you'
    if (e.usage) {
      const cost = estimateCost(e.usage.model, e.usage)
      await update($, totals, t => {
        const cur: LaneTotals = t[lane] ?? { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: null }
        return { ...t, [lane]: {
          turns: cur.turns + 1,
          inputTokens: cur.inputTokens + e.usage!.input_tokens,
          outputTokens: cur.outputTokens + e.usage!.output_tokens,
          cacheReadTokens: cur.cacheReadTokens + e.usage!.cache_read_input_tokens,
          costUsd: cost === null ? cur.costUsd : (cur.costUsd ?? 0) + cost,
        } }
      })
    }
    if (e.agentId) { laneOfAgent.delete(e.agentId); return next(e) }
    const endedAt = await $.clock.now()
    const c = await read($, current)
    if (c) {
      const done: TurnRecord = { ...c, endedAt, costUsd: e.usage ? estimateCost(e.usage.model, e.usage) : null }
      await update($, last, () => done)
      await update($, turns, list => [done, ...list].slice(0, 50))
      await update($, current, () => null)
    }
    return next(e)
  })

  on('command.run', { command: 'spick' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'hide') { await update($, hidden, () => true); return { text: 'Spick band hidden. /spick show restores it.' } }
    if (arg === 'show') { await update($, hidden, () => false); return { text: 'Spick band shown.' } }
    await refreshQuota($, true).catch(() => undefined)
    const placed = await $.ui.open({ id: PANE, title: 'Spick', closeOnEscape: true })
    return { text: placed.isPlaced ? 'Spick pane opened.' : `Spick pane not placed: ${placed.reason}` }
  })

  // ui.render hooks are added in Task 5.
}
```

- [x] **Step 2: Validate and type-check**

Run: `claude plugin validate "$MOD" && tsc -p "$MOD"`
Expected: validate lists no refusals; `tsc` passes. If `tsc` complains that `e.subagent_type` or `e.file_path` is not on the event, the matcher did not narrow: check `claude-code-tools/index.d.ts` in `<mod>/.claude-plugin/types/` for the exact field names and adjust.

- [x] **Step 3: Commit**

```bash
rsync -a --delete "$MOD/" ~/dev/spick/mod/spick-dashboard/ && cd ~/dev/spick && git add mod && git commit -m "mod: event hooks that build the dashboard state"
```

---

### Task 5: The band and the pane

**Files:**
- Modify: `<mod>/hooks/register.tsx` (append the two `ui.render` hooks inside `register`)

**Interfaces:**
- Consumes: `bandSegments`, `table`, `quotaBar`, `fmtDuration`, `fmtCost`, `fmtAge`, `HINT` from `./format`; the atoms from Task 4.

- [x] **Step 1: Add the band**

```tsx
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hidden))) return next(e)
    const c = await read($, current)
    const l = await read($, last)
    const q = await read($, quota)
    const view = c
      ? { lane: c.lane, model: c.model, effort: c.effort, agents: c.agents, isIdle: false, note: c.note }
      : l
        ? { lane: l.lane, model: l.model, effort: l.effort, agents: 0, isIdle: true, durationMs: (l.endedAt ?? l.startedAt) - l.startedAt, note: undefined }
        : null
    if (!view) return next(e)
    const segs = bandSegments(view, e.props.bodyColumns)
    const { Box, Text } = $.ui.resolve(e)
    const left = segs.filter(s => s.text !== HINT && s !== segs[segs.length - 1] || (s.style !== 'warning' && s.style !== 'error' && s.text !== HINT))
    const right = segs[segs.length - 1]
    const isRight = right.text === HINT || right.style === 'warning' || right.style === 'error'
    const paint = (s: typeof segs[number], i: number) =>
      s.style === 'brand' ? <Text key={String(i)} bold color="claude" wrap="truncate-end">{s.text}</Text>
      : s.style === 'lane' ? <Text key={String(i)} bold wrap="truncate-end">{s.text}</Text>
      : s.style === 'warning' ? <Text key={String(i)} color="warning" wrap="truncate-end">{s.text}</Text>
      : s.style === 'error' ? <Text key={String(i)} color="error" wrap="truncate-end">{s.text}</Text>
      : s.style === 'dim' ? <Text key={String(i)} color="subtle" wrap="truncate-end">{s.text}</Text>
      : <Text key={String(i)} wrap="truncate-end">{s.text}</Text>
    return (
      <Box flexDirection="row" justifyContent="space-between" width="100%">
        <Box flexDirection="row">{(isRight ? segs.slice(0, -1) : segs).map(paint)}</Box>
        {isRight && <Box flexDirection="row">{paint(right, 99)}</Box>}
      </Box>
    )
  })
```

Note for the implementer: the `left` line above is scaffolding to delete; the two expressions actually used are `isRight ? segs.slice(0, -1) : segs` for the left group and `right` for the right group. Keep the code minimal.

- [x] **Step 2: Add the pane**

```tsx
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const t = await read($, totals)
    const q = await read($, quota)
    const list = await read($, turns)
    const now = await $.clock.now()
    const rows = (e.viewport?.rows ?? 30)

    const laneRows = Object.entries(t).sort((a, b) => b[1].turns - a[1].turns)
    const totalCost = laneRows.reduce<number | null>((acc, [, v]) => (v.costUsd === null ? acc : (acc ?? 0) + v.costUsd), null)
    const sessionTable = table([
      ['lane', 'turns', 'at API rates'],
      ...laneRows.map(([lane, v]) => [lane, String(v.turns), fmtCost(v.costUsd)]),
      ['total', String(laneRows.reduce((n, [, v]) => n + v.turns, 0)), fmtCost(totalCost)],
    ], ['l', 'r', 'r'])

    const qLine = (name: string, w?: { fiveHour?: number; sevenDay?: number } | null) => {
      if (!w) return <Text><Text>{padRightText(name, 7)}</Text><Text color="subtle">unknown</Text></Text>
      const cell = (label: string, pct?: number) => pct === undefined ? null : (
        <Text>{`${label}  ${quotaBar(pct)}  ${String(Math.round(pct)).padStart(3)}%   `}</Text>)
      return <Text>{padRightText(name, 7)}{cell('5h', w.fiveHour)}{cell('7d', w.sevenDay)}</Text>
    }
    const padRightText = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length)) + ' '

    const recent = list.slice(0, Math.max(3, rows - 14))
    const recentTable = table(
      recent.map(r => [clock(r.startedAt), r.lane, r.model, r.effort ?? '', fmtDuration((r.endedAt ?? r.startedAt) - r.startedAt), r.note?.text ?? '']),
      ['l', 'l', 'l', 'l', 'r', 'l'])

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>Spick</Text>
          <Text color="subtle">stop picking, just start</Text>
        </Box>
        <Text> </Text>
        <Text bold>This session</Text>
        {sessionTable.map((line, i) => <Text key={`s${i}`} color={i === 0 ? 'subtle' : undefined}>{'  ' + line}{i === sessionTable.length - 1 ? <Text color="subtle">{'     list price, not a bill'}</Text> : null}</Text>)}
        <Text> </Text>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>Quota</Text>
          <Text color="subtle">{q ? `refreshed ${fmtAge(now - q.readAt)}` : 'not read yet'}</Text>
        </Box>
        <Box paddingLeft={2} flexDirection="column">
          {qLine('claude', q?.claude)}
          {qLine('codex', q?.codex)}
          {qLine('grok', null)}
          {qLine('gemini', null)}
        </Box>
        <Text> </Text>
        <Text bold>Recent turns</Text>
        {recent.length === 0 && <Text color="subtle">{'  no turns yet'}</Text>}
        {recentTable.map((line, i) => {
          const note = recent[i].note
          return <Text key={`r${i}`}>{'  ' + line.slice(0, line.length - (note?.text.length ?? 0))}{note ? <Text color={note.kind}>{note.text}</Text> : null}</Text>
        })}
        <Text> </Text>
        <Box flexDirection="row" gap={2}>
          <Button key="hide" label={'Hide band'} onPress={() => update($, hidden, v => !v)} />
          <Button key="refresh" label="Refresh quota" onPress={() => refreshQuota($, true)} />
        </Box>
      </Box>
    )
  })
```

with, at module scope:

```tsx
const clock = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
```

and `padRight` imported from `./format` used in place of the local `padRightText` if the implementer prefers; either is fine, but only one may remain.

- [x] **Step 3: Validate, type-check, run the tests**

Run: `claude plugin validate "$MOD" && tsc -p "$MOD" && claude plugin test "$MOD"`
Expected: all green. A `ui.render` tree the engine refuses shows in the transcript as `spick-dashboard: ui.render (AbovePrompt) refused: <reason>`; fix the props it names.

- [x] **Step 4: Visual acceptance in this session (hot reload on)**

After the turn ends the mod loads. Check, in order, and fix anything off before moving on:
1. Idle band reads `spick · last: … · … · …` in dim text, wordmark in brand color.
2. Send a chore prompt: band shows `you · Haiku 5.5 · <effort>` while it runs (in this Fable session it will say `Fable 5.1`; that is correct).
3. Dispatch `coder`: band shows `coder · Sonnet 5.5 · <effort>` while the agent runs.
4. `/spick` opens the pane: header row aligned, three sections separated by one blank line, numbers right-aligned, quota bars present, `Hide band` toggles the band.

- [x] **Step 5: Commit**

```bash
rsync -a --delete "$MOD/" ~/dev/spick/mod/spick-dashboard/ && cd ~/dev/spick && git add mod && git commit -m "mod: status band and /spick pane"
```

---

### Task 6: Ship it from the Spick repository

**Files:**
- Create: `~/dev/spick/.claude-plugin/marketplace.json`
- Modify: `~/dev/spick/README.md`, `~/dev/spick/README.zh-CN.md` (install section)
- Modify: `~/dev/spick/skills/spick/SKILL.md` (label-line rule: skipped when the mod is loaded, the mod tells the model so)

- [x] **Step 1: Marketplace file**

```json
{
  "name": "spick",
  "owner": { "name": "Brulek" },
  "plugins": [{ "name": "spick-dashboard", "source": "./mod/spick-dashboard" }]
}
```

- [x] **Step 2: Validate the whole repo as a marketplace**

Run: `claude plugin validate ~/dev/spick/mod/spick-dashboard && claude plugin validate ~/dev/spick`
Expected: both pass.

- [x] **Step 3: README install lines (both languages)**

English, under Install:

```
### Dashboard mod (optional)

In a terminal session:

    /plugin install spick-dashboard --marketplace Brulek/spick

Answer `y` to add the marketplace, pick the user scope. The band above the prompt then shows who is working; `/spick` opens the pane. While the mod is loaded, replies carry no label line.
```

Chinese equivalent under 安装, same command.

- [x] **Step 4: SKILL.md label-line note**

In "Step 7 - the label line", append: "When the Spick dashboard mod is loaded it adds a system section saying the band is showing; then omit the label line entirely. The band is the record."

- [x] **Step 5: Install from the marketplace on this machine and check the user-scope load**

Run in a terminal `claude` session: `/plugin install spick-dashboard --marketplace Brulek/spick` (after pushing). Then `claude plugin list` shows `spick-dashboard`.

- [x] **Step 6: Commit and push**

```bash
cd ~/dev/spick && git add -A && git commit -m "Ship the dashboard mod via the repo marketplace; docs" && git push
```

---

## Self-review notes

- Spec coverage: band states (Task 2 `bandSegments`, Task 5 render), width tiers (Task 2), pane sections (Task 5), observation table (Task 4: turn.start/step/complete, agent.spawn, Bash parse, Edit/Write breach), quota (Task 3 + refresh on pane open in Task 4), label line suppression (Task 4 prompt.compose), hide/show (Task 4 command + Task 5 button), state contract (Task 1), shipping (Task 6). Desktop-surface check is in the spec's verification list and is done by the user; the code uses `$.ui.resolve(e)` so it draws on whichever surface asks.
- Known simplification: `bandSegments` returns the attention note or the hint as the last segment; the band render splits it to the right. The scaffolding variable `left` in Task 5 Step 1 is called out for deletion.
- Type names are consistent across tasks: `TurnRecord`, `LaneTotals`, `Quota`, `QuotaWindows`, `Note`, `Seg`, `BandView`, `CliLane`.
