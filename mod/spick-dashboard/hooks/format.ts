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
