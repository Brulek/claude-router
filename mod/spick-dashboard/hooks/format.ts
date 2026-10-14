import type { Note, Quota, RunningAgent } from '../types'

const CLAUDE_NAMES: Record<string, string> = {
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-fable-5-1': 'Fable 5.1',
}
// price table, USD per million tokens: input, output, cache read, cache write
// (1.25 x input). Estimates only.
const PRICES: Record<string, [number, number, number, number]> = {
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125],
  'claude-sonnet-5-5': [2, 10, 0.2, 2.5],
  'claude-opus-5-5': [4, 20, 0.2, 5],
}

export function modelName(id: string): string {
  const exact = CLAUDE_NAMES[id]
  if (exact) return exact
  for (const [key, name] of Object.entries(CLAUDE_NAMES)) if (id.startsWith(key)) return name
  const alias: Record<string, string> = { haiku: 'Haiku 5.5', sonnet: 'Sonnet 5.5', opus: 'Opus 5.5', fable: 'Fable 5.1' }
  return alias[id] ?? id
}

export type CliLane = { lane: string; model?: string; effort?: string; isReview: boolean }

const PREFIX_WORDS = new Set(['env', 'npx', 'sudo', 'time'])
const QUOTED = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g

/** Classify one command segment by its first real word (after env/npx/sudo/time and any path). */
function segmentLane(words: string[]): { lane: string; rest: string[] } | null {
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    if (PREFIX_WORDS.has(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || (i > 0 && w.startsWith('-'))) i++
    else break
  }
  const first = words[i]
  if (!first) return null
  const base = first.slice(first.lastIndexOf('/') + 1)
  if (/^python3?(\.\d+)?$/.test(base)) {
    const j = words.findIndex((w, k) => k > i && w.slice(w.lastIndexOf('/') + 1) === 'invoke.py')
    if (j > 0) {
      const rest = words.slice(j + 1)
      const l = rest.findIndex(w => w === '--lane' || w.startsWith('--lane='))
      const id = l < 0 ? undefined : rest[l]!.startsWith('--lane=') ? rest[l]!.slice(7) : rest[l + 1]
      if (id) return { lane: id, rest }
    }
    return null
  }
  if (base === 'agy') return { lane: 'Gemini', rest: words.slice(i + 1) }
  if (base === 'grok') return { lane: 'Grok', rest: words.slice(i + 1) }
  if (base === 'codex' && words[i + 1] === 'exec') return { lane: 'Codex', rest: words.slice(i + 2) }
  return null
}

/**
 * A CLI counts only when its basename is the first word of a command segment
 * (segments split on ; & | ( and newlines), optionally behind a path and env/npx/sudo/time.
 * Quoted strings are masked first so names inside arguments never match.
 */
export function parseCli(command: string): CliLane | null {
  const quoted: string[] = []
  const masked = command.replace(QUOTED, m => `"${quoted.push(m) - 1}"`)
  // a backslash-newline continues the same command; a bare newline starts a new one
  for (const seg of masked.replace(/\\\n/g, ' ').split(/[;&|(\n]+/)) {
    const hit = segmentLane(seg.trim().split(/\s+/).filter(Boolean))
    if (!hit) continue
    const restored = (t: string) => t.replace(/"(\d+)"/g, (_, n) => quoted[Number(n)] ?? '')
    const text = hit.rest.join(' ')
    const out: CliLane = { lane: hit.lane, isReview: false }
    const model = text.match(/(?:--model|-m)[=\s]+(\S+)/)
    if (model?.[1]) out.model = model[1]
    const effort = text.match(/(?:--effort|--reasoning-effort)[=\s]+(\S+)/) ?? restored(text).match(/model_reasoning_effort="?(\w+)"?/)
    if (effort?.[1]) out.effort = effort[1]
    if (hit.lane === 'Codex') {
      const prompts = [...text.matchAll(/"(\d+)"/g)].map(m => quoted[Number(m[1])] ?? '')
      out.isReview = prompts.some(p => /\breview\b/i.test(p))
    }
    return out
  }
  return null
}

const NON_SOURCE = /\.(md|markdown|txt|json|jsonl|csv|tsv|ya?ml|toml|lock|log)$/i
export function isSourcePath(path: string): boolean {
  if (/(^|\/)\.claude\//.test(path)) return false
  if (NON_SOURCE.test(path)) return false
  return /\.[A-Za-z0-9]+$/.test(path)
}

/** the main session's lane name in state, totals and the pane */
export const MAIN_LANE = 'main session'

export type Seg = { text: string; style: 'brand' | 'lane' | 'plain' | 'dim' | 'warning' | 'error' }
export type BandView = {
  lane: string
  model: string
  agents: number
  /** ordinal of the agent the band shows among this turn's agents; absent when no agent is showing */
  agentIndex?: number
  /** how many agents of this lane run now; above 1 the lane reads `coder ×12` and the ordinal is dropped */
  count?: number
  isIdle: boolean
  /** active: time since the turn began; ignored when idle (the band shows no duration then) */
  durationMs?: number
  /** the showing call is a Codex review */
  isReview?: boolean
  note?: Note
  /** active delegate: the main session's model, for `main: <model>` */
  mainModel?: string
  /** routing is effectively off this session: the wordmark reads `SPICK off`, `off` in warning */
  routingOff?: boolean
}
/** one provider's quota: the weekly window, else the five-hour one */
export type QuotaMeter = { name: string; window: '7d' | '5h'; pct: number }
/** left: the status sentence; right: at most one item: the attention cause, the main model or the hint */
export type Band = { left: Seg[]; right: Seg[] }
const SEP: Seg = { text: ' · ', style: 'dim' }
const GAP: Seg = { text: '   ', style: 'plain' }
export const HINT = '/spick for details'

const VERBS: Record<string, string> = { Gemini: 'is searching', Grok: 'is fetching X' }
export function verbOf(lane: string, isReview = false): string {
  if (lane === 'Codex') return isReview ? 'is reviewing' : 'is working'
  return VERBS[lane] ?? 'is working'
}

/** An attention cause as segments: a breach colors only the file name, other causes color whole. */
export function noteParts(note: Note): Seg[] {
  if (note.kind === 'error' && note.text.startsWith('edited ')) return [{ text: 'edited ', style: 'plain' }, { text: note.text.slice(7), style: 'error' }]
  return [{ text: note.text, style: note.kind }]
}

/** One meter per known provider, the weekly window preferred, five-hour when the weekly is unknown. */
export function quotaMeters(q: Quota | null | undefined): QuotaMeter[] {
  const out: QuotaMeter[] = []
  for (const [name, w] of [['claude', q?.claude], ['codex', q?.codex]] as const) {
    // only a finite number counts as known: a NaN weekly value must not hide a good five-hour one
    const ok = (p: number | undefined): p is number => typeof p === 'number' && Number.isFinite(p)
    if (ok(w?.sevenDay)) out.push({ name, window: '7d', pct: w.sevenDay })
    else if (ok(w?.fiveHour)) out.push({ name, window: '5h', pct: w.fiveHour })
  }
  return out
}

/** Terminal cells a string takes: the meter glyphs and CJK/fullwidth characters count two, everything else one. */
export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += /[\u2580-\u259F\u25A0-\u25FF\u2E80-\u9FFF\uFF00-\uFFEF]/.test(ch) ? 2 : 1
  return w
}
const segsWidth = (segs: Seg[]): number => segs.reduce((n, s) => n + displayWidth(s.text), 0)
/** the renderer's gap={2} between the left and right groups */
const GROUP_GAP = 2
/** what a band too wide for its columns gives up, first to last; the wordmark and the subject never go */
type Droppable = 'ordinal' | 'elapsed' | 'wording' | 'model'
const DROP_ORDER: Droppable[] = ['ordinal', 'elapsed', 'wording', 'model']

/**
 * The band for a view at a width. Tiers pick the candidate segments; then the band is
 * fitted by measured width: a right group that is not an attention cause goes first,
 * then left segments in DROP_ORDER, until it fits. A cause is kept even when nothing else fits.
 */
export function bandSegments(v: BandView, columns: number): Band {
  const wordmark: Seg[] = v.routingOff ? [{ text: 'SPICK', style: 'brand' }, { text: ' off', style: 'warning' }] : [{ text: 'SPICK', style: 'brand' }]
  const isMain = v.lane === MAIN_LANE
  const many = !isMain && !v.isIdle && (v.count ?? 1) > 1
  const laneText = many ? `${v.lane} \u00d7${v.count}` : v.lane
  const style = (s: Seg['style']): Seg['style'] => (v.isIdle ? 'dim' : s)
  const show: Record<Droppable, boolean> = {
    ordinal: columns >= 70 && !v.isIdle && !many && v.agents > 1 && v.agentIndex !== undefined,
    elapsed: v.durationMs !== undefined && !v.isIdle && columns >= 70,
    wording: true,
    model: !!v.model,
  }

  const buildLeft = (): Seg[] => {
    if (columns < 40) {
      const left: Seg[] = [...wordmark, SEP, { text: v.isIdle ? 'Idle' : isMain ? 'Working' : laneText, style: style('lane') }]
      if (show.model) left.push(SEP, { text: v.model, style: style('plain') })
      return left
    }
    const parts: Seg[][] = []
    if (v.isIdle) {
      parts.push([{ text: 'Idle', style: 'dim' }])
      if (show.wording) {
        const who = isMain ? v.model || MAIN_LANE : v.model ? `${v.lane} on ${v.model}` : v.lane
        parts.push([{ text: `last turn: ${who}`, style: 'dim' }])
      } else {
        if (!isMain) parts.push([{ text: v.lane, style: 'dim' }])
        if (show.model) parts.push([{ text: v.model, style: 'dim' }])
      }
    } else {
      parts.push(isMain ? [{ text: 'Working', style: 'lane' }]
        : show.wording ? [{ text: laneText, style: 'lane' }, { text: ` ${many ? verbOf(v.lane, v.isReview).replace(/^is /, '') : verbOf(v.lane, v.isReview)}`, style: 'plain' }]
        : [{ text: laneText, style: 'lane' }])
      if (show.model) parts.push([{ text: v.model, style: 'plain' }])
    }
    if (show.ordinal) parts.push([{ text: `agent ${v.agentIndex} of ${v.agents}`, style: 'dim' }])
    if (show.elapsed && v.durationMs !== undefined) parts.push([{ text: fmtDuration(v.durationMs), style: 'dim' }])
    return [...wordmark, GAP, ...parts.flatMap((p, i) => (i === 0 ? p : [SEP, ...p]))]
  }

  // right group, at most one item: an attention cause from 40 columns; from 90, while
  // active, the main model for a delegate, else the hint. Idle: nothing.
  let right: Seg[] = []
  if (columns >= 40 && v.note) right = noteParts(v.note)
  else if (columns >= 90 && !v.isIdle) right = !isMain && v.mainModel ? [{ text: `main: ${v.mainModel}`, style: 'dim' }] : [{ text: HINT, style: 'dim' }]

  const fits = (left: Seg[]) => segsWidth(left) + (right.length > 0 ? GROUP_GAP + segsWidth(right) : 0) <= columns
  let left = buildLeft()
  if (!fits(left) && !v.note) right = []
  for (const k of DROP_ORDER) {
    if (fits(left)) break
    if (!show[k]) continue
    show[k] = false
    left = buildLeft()
  }
  return { left, right }
}

/** The longest the pane's Running section gets before it says "and N more". */
export const RUNNING_ROWS = 5
export const TIMED_OUT_TEXT = 'timed out, no completion signal'
/** a delegate with no completion signal this long after it started is dropped from the running state */
export const STALE_MS = 30 * 60_000

/** The Running section as aligned lines (lane, model, elapsed), at most RUNNING_ROWS, and how many were left out. */
export function runningLines(rows: readonly RunningAgent[], now: number): { lines: string[]; more: number } {
  const shown = rows.slice(0, RUNNING_ROWS)
  const lines = table(shown.map(r => [r.lane, r.model, r.timedOutAt !== undefined ? TIMED_OUT_TEXT : fmtDuration(Math.max(0, now - r.startedAt))]), ['l', 'l', 'l'])
  return { lines, more: rows.length - shown.length }
}

export function padRight(s: string, w: number): string { return s + ' '.repeat(Math.max(0, w - s.length)) }
/** s cut to n characters, an ellipsis last when it was longer */
export function clip(s: string, n: number): string { return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s }
export function padLeft(s: string, w: number): string { return ' '.repeat(Math.max(0, w - s.length)) + s }

/** Fixed-width columns, two spaces between, aligned per column. Every row comes back the same length. */
export function table(rows: string[][], align: ('l' | 'r')[]): string[] {
  const widths = (rows[0] ?? []).map((_, i) => Math.max(...rows.map(r => (r[i] ?? '').length)))
  return rows.map(r => widths.map((w, i) => (align[i] === 'r' ? padLeft(r[i] ?? '', w) : padRight(r[i] ?? '', w))).join('  '))
}

/** `cells` cells of used (▰) and free (▱): ten in the pane and the wide band, five on a narrower band. */
export function quotaBar(pct: number, cells = 10): string {
  // a non-finite input draws all cells free
  const used = Number.isFinite(pct) ? Math.min(cells, Math.max(0, Math.round(pct / (100 / cells)))) : 0
  return '▰'.repeat(used) + '▱'.repeat(cells - used)
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}
export function fmtAge(ms: number): string {
  if (ms < 60_000) return 'just now'
  const m = Math.round(ms / 60000)
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`
}
export function fmtCost(usd: number | null): string { return usd === null ? '—' : `$${usd.toFixed(2)}` }

export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

export function estimateCost(modelId: string, u: Usage): number | null {
  const key = Object.keys(PRICES).find(k => modelId === k || modelId.startsWith(k))
  if (!key) return null
  const [i, o, c, w] = PRICES[key]!
  return (u.input_tokens * i + u.output_tokens * o + u.cache_read_input_tokens * c + u.cache_creation_input_tokens * w) / 1_000_000
}
