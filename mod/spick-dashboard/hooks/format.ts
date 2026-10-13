import type { Note, Quota } from '../types'

const CLAUDE_NAMES: Record<string, string> = {
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-fable-5-1': 'Fable 5.1',
}
// list prices, USD per million tokens: input, output, cache read, cache write
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

export type CliLane = { lane: 'Gemini' | 'Grok' | 'Codex'; model?: string; effort?: string; isReview: boolean }

const PREFIX_WORDS = new Set(['env', 'npx', 'sudo', 'time'])
const QUOTED = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g

/** Classify one command segment by its first real word (after env/npx/sudo/time and any path). */
function segmentLane(words: string[]): { lane: CliLane['lane']; rest: string[] } | null {
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    if (PREFIX_WORDS.has(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || (i > 0 && w.startsWith('-'))) i++
    else break
  }
  const first = words[i]
  if (!first) return null
  const base = first.slice(first.lastIndexOf('/') + 1)
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
  effort?: string
  agents: number
  /** ordinal of the agent the band shows among this turn's agents; absent when no agent is showing */
  agentIndex?: number
  isIdle: boolean
  /** active: time since the turn began; idle: the last turn's wall time */
  durationMs?: number
  /** the showing call is a Codex review */
  isReview?: boolean
  note?: Note
  /** active delegate: the main session's model, for `main: <model>` */
  mainModel?: string
  /** idle: known quota windows, e.g. `claude 7d 1% · codex 7d 30%` */
  quota?: string
}
/** left: the status sentence; right: hint, main model, quota summary or the attention cause */
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

/** One window per known provider, the weekly one when known: `claude 7d 1% · codex 7d 30%`. */
export function quotaSummary(q: Quota | null | undefined): string | undefined {
  const parts: string[] = []
  for (const [name, w] of [['claude', q?.claude], ['codex', q?.codex]] as const) {
    if (w?.sevenDay !== undefined) parts.push(`${name} 7d ${Math.round(w.sevenDay)}%`)
    else if (w?.fiveHour !== undefined) parts.push(`${name} 5h ${Math.round(w.fiveHour)}%`)
  }
  return parts.length > 0 ? parts.join(' · ') : undefined
}

export function bandSegments(v: BandView, columns: number): Band {
  const brand: Seg = { text: 'spick', style: 'brand' }
  const isMain = v.lane === MAIN_LANE
  const style = (s: Seg['style']): Seg['style'] => (v.isIdle ? 'dim' : s)
  if (columns < 40) {
    const left: Seg[] = [brand, SEP, { text: v.isIdle ? 'Idle' : isMain ? 'Working' : v.lane, style: style('lane') }]
    if (v.model) left.push(SEP, { text: v.model, style: style('plain') })
    return { left, right: [] }
  }

  const parts: Seg[][] = []
  if (v.isIdle) {
    const who = isMain ? v.model || MAIN_LANE : v.model ? `${v.lane} on ${v.model}` : v.lane
    parts.push([{ text: 'Idle', style: 'dim' }], [{ text: `last turn: ${who}`, style: 'dim' }])
  } else {
    parts.push(isMain ? [{ text: 'Working', style: 'lane' }] : [{ text: v.lane, style: 'lane' }, { text: ` ${verbOf(v.lane, v.isReview)}`, style: 'plain' }])
    if (v.model) parts.push([{ text: v.model, style: 'plain' }])
  }
  if (columns >= 50 && v.effort) parts.push([{ text: `${v.effort} effort`, style: style('plain') }])
  if (columns >= 70 && !v.isIdle && v.agents > 1 && v.agentIndex !== undefined) parts.push([{ text: `agent ${v.agentIndex} of ${v.agents}`, style: 'dim' }])
  if (v.durationMs !== undefined) {
    if (v.isIdle) parts.push([{ text: `took ${fmtDuration(v.durationMs)}`, style: 'dim' }])
    else if (columns >= 70) parts.push([{ text: fmtDuration(v.durationMs), style: 'dim' }])
  }
  const left: Seg[] = [brand, GAP, ...parts.flatMap((p, i) => (i === 0 ? p : [SEP, ...p]))]

  let right: Seg[] = []
  if (v.note) right = noteParts(v.note)
  else if (columns >= 90) {
    const context = v.isIdle ? (v.quota ? `quota: ${v.quota}` : undefined) : !isMain && v.mainModel ? `main: ${v.mainModel}` : HINT
    if (context) right = [{ text: context, style: 'dim' }]
  }
  return { left, right }
}

export function padRight(s: string, w: number): string { return s + ' '.repeat(Math.max(0, w - s.length)) }
export function padLeft(s: string, w: number): string { return ' '.repeat(Math.max(0, w - s.length)) + s }

/** Fixed-width columns, two spaces between, aligned per column. Every row comes back the same length. */
export function table(rows: string[][], align: ('l' | 'r')[]): string[] {
  const widths = (rows[0] ?? []).map((_, i) => Math.max(...rows.map(r => (r[i] ?? '').length)))
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

export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

export function estimateCost(modelId: string, u: Usage): number | null {
  const key = Object.keys(PRICES).find(k => modelId === k || modelId.startsWith(k))
  if (!key) return null
  const [i, o, c, w] = PRICES[key]!
  return (u.input_tokens * i + u.output_tokens * o + u.cache_read_input_tokens * c + u.cache_creation_input_tokens * w) / 1_000_000
}
