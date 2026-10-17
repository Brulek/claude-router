import type { FsEntry } from 'claude-code'
import type { Quota, QuotaWindows } from '../types'

const pctOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
/** a reset time (ISO text, or epoch seconds as Codex writes it) in ms; undefined when absent or unreadable */
const resetMs = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v * 1000
  if (typeof v !== 'string') return undefined
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : t
}
/** a window whose reset has passed says nothing about now: it is left out (quota.py reports it as used_pct null) */
const isLive = (resetsAt: unknown, nowMs: number | undefined): boolean => {
  const r = resetMs(resetsAt)
  return nowMs === undefined || r === undefined || r > nowMs
}

/**
 * ~/.claude.json's cachedUsageUtilization, read as scripts/quota.py reads it: `limits[]` when present (session is the
 * five-hour window, weekly_all the weekly one; scoped weeklies are not meters here), else utilization.five_hour and
 * seven_day. `sampledAt` is fetchedAtMs, the time Claude Code sampled it, never the time this read happened.
 */
export function parseClaudeUsage(jsonText: string, nowMs?: number): QuotaWindows | null {
  try {
    const d = JSON.parse(jsonText)
    const c = d?.cachedUsageUtilization
    const u = c?.utilization
    if (!u) return null
    const out: QuotaWindows = {}
    const limits: unknown = u.limits
    if (Array.isArray(limits) && limits.length > 0) {
      for (const l of limits as Record<string, unknown>[]) {
        const pct = pctOf(l?.percent)
        if (pct === undefined || !isLive(l.resets_at, nowMs)) continue
        if (l.kind === 'session') out.fiveHour = pct
        else if (l.kind === 'weekly_all') out.sevenDay = pct
      }
    } else {
      const five = pctOf(u.five_hour?.utilization)
      if (five !== undefined && isLive(u.five_hour.resets_at, nowMs)) out.fiveHour = five
      const seven = pctOf(u.seven_day?.utilization)
      if (seven !== undefined && isLive(u.seven_day.resets_at, nowMs)) out.sevenDay = seven
    }
    if (out.fiveHour === undefined && out.sevenDay === undefined) return null
    const fetched = pctOf(c.fetchedAtMs)
    if (fetched !== undefined && fetched > 0) out.sampledAt = fetched
    return out
  } catch { return null }
}

/**
 * Find the last complete `"rate_limits":{...}` object by brace matching; a cut-off tail is ignored. `sampledAt` is the
 * timestamp of the session-log line that carries it, when the line has one; a window past its reset is left out.
 */
export function parseCodexRateLimits(text: string, nowMs?: number): QuotaWindows | null {
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
          const pct = pctOf(w?.used_percent ?? w?.usedPercent)
          if (pct === undefined || !isLive(w.resets_at ?? w.resetsAt, nowMs)) continue
          const mins = w.window_minutes ?? w.windowDurationMins ?? 0
          if (mins >= 10000) out.sevenDay = pct
          else if (mins > 0 && mins <= 400) out.fiveHour = pct
        }
        if (out.fiveHour !== undefined || out.sevenDay !== undefined) {
          // the line this object sits on, for its timestamp
          const lineStart = text.lastIndexOf('\n', at) + 1
          const ts = text.slice(lineStart, at).match(/"timestamp"\s*:\s*"([^"]+)"/)
          const t = ts ? Date.parse(ts[1]!) : NaN
          if (!Number.isNaN(t)) out.sampledAt = t
          return out
        }
      } catch { /* fall through to the previous occurrence */ }
    }
    from = at
    if (from <= 0) return null
  }
}

/**
 * The reads readQuota needs, as plain functions. `$` never crosses an import
 * (claude plugin validate refuses it), so register.tsx builds this from
 * $.env.get (names spelled as literals there), $.fs.read and $.fs.list.
 */
export type QuotaIO = {
  env: (name: 'HOME' | 'CODEX_HOME') => Promise<string | undefined>
  read: (path: string) => Promise<string>
  list: (path: string) => Promise<readonly FsEntry[]>
}

/** the engine refuses to read a file larger than this */
export const MAX_READ_BYTES = 4 * 1024 * 1024
/** most session files one refresh reads, across all day directories */
const MAX_CODEX_FILES = 20

async function newestCodexWindows(io: QuotaIO, root: string, nowMs: number): Promise<QuotaWindows | null> {
  // sessions/YYYY/MM/DD/*.jsonl: walk days newest first by name; inside a day,
  // files newest first by mtime; stop at the first file that parses, or after
  // MAX_CODEX_FILES reads.
  let reads = 0
  const ls = async (dir: string): Promise<readonly FsEntry[]> => { try { return await io.list(dir) } catch { return [] } }
  const subdirs = async (dir: string): Promise<string[]> =>
    (await ls(dir)).filter(e => e.kind === 'dir').map(e => e.name).sort().reverse().map(n => `${dir}/${n}`)
  const walk = async (dir: string, depth: number): Promise<QuotaWindows | null> => {
    if (depth > 0) {
      for (const sub of await subdirs(dir)) {
        const hit = await walk(sub, depth - 1)
        if (hit || reads >= MAX_CODEX_FILES) return hit
      }
      return null
    }
    const files = (await ls(dir))
      .filter(e => e.kind === 'file' && e.name.endsWith('.jsonl') && e.size <= MAX_READ_BYTES)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const f of files) {
      if (reads >= MAX_CODEX_FILES) return null
      reads++
      try {
        const windows = parseCodexRateLimits(await io.read(`${dir}/${f.name}`), nowMs)
        // a line with no timestamp was sampled no later than the file was last written
        if (windows) return windows.sampledAt === undefined && f.mtimeMs > 0 ? { ...windows, sampledAt: f.mtimeMs } : windows
      } catch { /* next file */ }
    }
    return null
  }
  return walk(root, 3)
}

export async function readQuota(io: QuotaIO, nowMs: number): Promise<Quota> {
  let home = ''
  try { home = (await io.env('HOME')) ?? '' } catch { home = '' }
  let codexHome = ''
  try { codexHome = (await io.env('CODEX_HOME')) || `${home}/.codex` } catch { codexHome = `${home}/.codex` }
  let claude: QuotaWindows | null = null
  let codex: QuotaWindows | null = null
  try { claude = parseClaudeUsage(await io.read(`${home}/.claude.json`), nowMs) } catch { claude = null }
  try {
    codex = await newestCodexWindows(io, `${codexHome}/sessions`, nowMs)
  } catch { codex = null }
  return { claude, codex, readAt: nowMs }
}
