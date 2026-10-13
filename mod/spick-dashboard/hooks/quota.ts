import type { FsEntry } from 'claude-code'
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

async function newestCodexWindows(io: QuotaIO, root: string): Promise<QuotaWindows | null> {
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
        const windows = parseCodexRateLimits(await io.read(`${dir}/${f.name}`))
        if (windows) return windows
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
  try { claude = parseClaudeUsage(await io.read(`${home}/.claude.json`)) } catch { claude = null }
  try {
    codex = await newestCodexWindows(io, `${codexHome}/sessions`)
  } catch { codex = null }
  return { claude, codex, readAt: nowMs }
}
