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
 * $.env.get('HOME'), $.fs.read and $.fs.list.
 */
export type QuotaIO = {
  home: () => Promise<string | undefined>
  read: (path: string) => Promise<string>
  list: (path: string) => Promise<readonly FsEntry[]>
}

async function newestCodexWindows(io: QuotaIO, root: string): Promise<QuotaWindows | null> {
  // sessions/YYYY/MM/DD/*.jsonl: walk the newest branch by name, then by mtime, reading at most 5 files
  const pick = async (dir: string, depth: number): Promise<string[]> => {
    const entries = (await io.list(dir)).filter(e => e.kind === 'dir').map(e => e.name).sort().reverse()
    for (const name of entries) {
      const sub = `${dir}/${name}`
      if (depth === 0) {
        const files = (await io.list(sub)).filter(e => e.kind === 'file' && e.name.endsWith('.jsonl'))
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
      const text = await io.read(file)
      const windows = parseCodexRateLimits(text)
      if (windows) return windows
    } catch { /* next file */ }
  }
  return null
}

export async function readQuota(io: QuotaIO, nowMs: number): Promise<Quota> {
  let home = ''
  try { home = (await io.home()) ?? '' } catch { home = '' }
  let claude: QuotaWindows | null = null
  let codex: QuotaWindows | null = null
  try { claude = parseClaudeUsage(await io.read(`${home}/.claude.json`)) } catch { claude = null }
  try {
    codex = await newestCodexWindows(io, `${home}/.codex/sessions`)
  } catch { codex = null }
  return { claude, codex, readAt: nowMs }
}
