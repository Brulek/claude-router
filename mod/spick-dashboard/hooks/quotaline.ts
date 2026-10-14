/**
 * The quota line of the checklist, built from ~/.claude/spick-quota.json (written by
 * skills/spick/scripts/quota.py). Plain facts with ages, no rules, no judgement. Mirrors
 * quota.py's build_line: both are tested against the same sample, skills/spick/scripts/testdata/cache_sample.*.
 */
import type { LaneInfo } from '../types'

type QWindow = { name: string; used_pct: number | null; resets_at: string | null; reset?: boolean }
type QProvider = { provider: string; plan?: string | null; price?: string | null; sampled_at?: string | null; windows?: QWindow[]; reason?: string; facts?: string[] }

const FRESH_S = 30 * 60

const fmtAge = (s: number): string => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`)
const pct = (p: number): string => `${Math.floor(p + 0.5)}%`
const secs = (iso: unknown): number | null => {
  if (typeof iso !== 'string') return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t / 1000
}

function windowPhrase(w: QWindow, now: number): string {
  const r = secs(w.resets_at)
  if (w.reset || (r !== null && r <= now)) return `${w.name} reset passed`
  const rel = r === null ? '' : ` (resets in ${fmtAge(Math.max(0, Math.floor(r - now)))})`
  if (typeof w.used_pct !== 'number') return `${w.name} unknown${rel}`
  return `${w.name} ${pct(w.used_pct)}${rel}`
}

function providerPhrase(e: QProvider, now: number): string {
  const head = [e.provider, e.plan].filter(Boolean).join(' ')
  const sampled = secs(e.sampled_at)
  const age = sampled === null ? null : Math.max(0, Math.floor(now - sampled))
  const facts = Array.isArray(e.facts) ? e.facts.filter(f => typeof f === 'string') : []
  const parts = (e.windows ?? []).map(w => windowPhrase(w, now))
  if (age === null && facts.length === 0) parts.unshift(`unknown (${e.reason ?? 'no data'})`)
  parts.push(...facts)
  let body = parts.join(', ')
  if (age !== null && age >= FRESH_S) body += ` [stale, ${fmtAge(age)} old]`
  return `${head}: ${body}`
}

/** The line for `nowMs`, or null when the cache is unreadable or lists no provider (then the line is left out). */
export function quotaLineFromCache(text: string, nowMs: number): string | null {
  let doc: { written_at?: string; providers?: QProvider[] }
  try { doc = JSON.parse(text) } catch { return null }
  const written = secs(doc?.written_at)
  if (written === null || !Array.isArray(doc.providers) || doc.providers.length === 0) return null
  const now = nowMs / 1000
  const age = Math.max(0, Math.floor(now - written))
  return `Quota (cache ${fmtAge(age)} old): ${doc.providers.map(e => providerPhrase(e, now)).join(' · ')}.`
}

const THIRD_PARTY_KINDS = ['api-key', 'relay']

/** The Lanes line from the lanes the cache carries; mirrors lanes.py build_line. Empty when there are none. */
export function lanesLine(lanes: readonly LaneInfo[]): string {
  if (lanes.length === 0) return ''
  const segs = lanes.map(l => {
    const parts = [l.id]
    if (l.tags.length > 0) parts.push(l.tags.join(','))
    if (l.prefer.length > 0) parts.push(`prefer:${l.prefer.join(',')}`)
    parts.push(l.data ? `data:${l.data}` : 'data:unset')
    return parts.join(' ')
  })
  for (const l of lanes) if (l.kind && THIRD_PARTY_KINDS.includes(l.kind)) segs.push(`${l.id} is a third-party service: sending content to it carries a data-leak risk.`)
  return `Lanes (user-declared; data = most that may be sent): ${segs.join(' \u00b7 ')}`
}

/** The declared lanes in the cache, or null when it has none (a user without lane_registry) or is unreadable. */
export function lanesFromCache(text: string): LaneInfo[] | null {
  let doc: { lanes?: unknown }
  try { doc = JSON.parse(text) } catch { return null }
  if (!Array.isArray(doc?.lanes)) return null
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const out: LaneInfo[] = []
  for (const l of doc.lanes as Record<string, unknown>[]) {
    if (!l || typeof l.id !== 'string') continue
    out.push({ id: l.id, kind: typeof l.kind === 'string' ? l.kind : undefined, tags: strs(l.tags), prefer: strs(l.prefer), data: typeof l.data === 'string' ? l.data : null })
  }
  return out.length > 0 ? out : null
}
