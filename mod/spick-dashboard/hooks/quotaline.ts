/**
 * The quota line of the checklist, built from <state>/quota.json, ~/.claude/spick/quota.json by default (written by
 * skills/spick/scripts/quota.py). Plain facts with ages, no rules, no judgement. Mirrors
 * quota.py's build_line: both are tested against the same sample, skills/spick/scripts/testdata/cache_sample.*.
 */
import type { LaneInfo } from '../types'
import type { LanesState } from './checklist'

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
  // nothing to say (no window, no fact) reads as unknown, a sampling time or not: never a bare `name: `
  if (facts.length === 0 && (age === null || parts.length === 0)) parts.unshift(`unknown (${e.reason ?? 'no data'})`)
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
    parts.push(l.data ? `data:${l.data}` : 'data:unset')
    return parts.join(' ')
  })
  for (const l of lanes) if (l.kind && THIRD_PARTY_KINDS.includes(l.kind)) segs.push(`${l.id} is a third-party service: sending content to it carries a data-leak risk.`)
  return `Lanes (user-declared; data = most that may be sent): ${segs.join(' \u00b7 ')}`
}

/**
 * What the cache says about declared lanes: `{registry, lanes}` with the enabled lanes. `registry` false means no
 * lane_registry (the built-in lanes apply); `registry` true with an empty list means every lane is off, and an empty
 * list stays empty. A cache written before the `registry` field carried `lanes` only for a registry, so there a lanes
 * list, even an empty one, means registry true.
 * Null when the cache cannot be read or says nothing about lanes (neither field): then spick.json decides
 * (lanesFromConfig). checklist() takes this object (or the older bare list).
 */
export function lanesFromCache(text: string): LanesState | null {
  let doc: { lanes?: unknown; registry?: unknown }
  try { doc = JSON.parse(text) } catch { return null }
  if (!doc || typeof doc !== 'object') return null
  if (typeof doc.registry !== 'boolean' && !Array.isArray(doc.lanes)) return null
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const out: LaneInfo[] = []
  for (const l of (Array.isArray(doc.lanes) ? doc.lanes : []) as Record<string, unknown>[]) {
    if (!l || typeof l.id !== 'string') continue
    out.push({ id: l.id, kind: typeof l.kind === 'string' ? l.kind : undefined, tags: strs(l.tags), data: typeof l.data === 'string' ? l.data : null })
  }
  const registry = typeof doc.registry === 'boolean' ? doc.registry : Array.isArray(doc.lanes)
  return { registry, lanes: registry ? out : [] }
}

/**
 * The built-in lanes as the cache lists them: a copy of skills/spick/assets/builtin-lanes.json's id, kind, tags and
 * data (the mod cannot read the skill's files); test_lanes.py fails when the two drift.
 */
// builtins:start
export const BUILTIN_LANES: readonly LaneInfo[] = [
  { id: 'gemini', kind: 'cli-subscription', tags: ['search', 'long-context', 'multimodal', 'image'], data: 'code' },
  { id: 'grok', kind: 'cli-subscription', tags: ['x-data'], data: 'code' },
  { id: 'codex', kind: 'cli-subscription', tags: ['code', 'review', 'image'], data: 'code' },
]
// builtins:end

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * What spick.json says about lanes when the quota cache is cold (missing, unreadable, or silent on lanes): the config
 * is the authority. Mirrors scripts/lanes.py load_effective: `registry` is whether `lane_registry` is there; each
 * built-in lane is enabled unless `lanes.<id>` is false, a `lane_registry.<id>` record overrides its fields (its
 * `enabled` wins), registry ids that are not built-in follow, enabled unless they say otherwise. A registry with
 * nothing enabled is `{registry: true, lanes: []}`. Null when the text is not a JSON object (no config to go by).
 */
export function lanesFromConfig(text: string): LanesState | null {
  let cfg: unknown
  try { cfg = JSON.parse(text) } catch { return null }
  if (!isObj(cfg)) return null
  if (!('lane_registry' in cfg)) return { registry: false, lanes: [] }
  const switches = isObj(cfg.lanes) ? cfg.lanes : {}
  const reg = isObj(cfg.lane_registry) ? cfg.lane_registry : {}
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const out: LaneInfo[] = []
  const add = (id: string, base: LaneInfo | null, enabledByDefault: boolean): void => {
    const over = isObj(reg[id]) ? (reg[id] as Record<string, unknown>) : {}
    const enabled = 'enabled' in over ? over.enabled : enabledByDefault
    // lanes.py keeps a lane whose enabled is truthy (absent reads true)
    if (!enabled) return
    out.push({
      id,
      kind: typeof over.kind === 'string' ? over.kind : base?.kind,
      tags: 'tags' in over ? strs(over.tags) : [...(base?.tags ?? [])],
      data: 'data' in over ? (typeof over.data === 'string' ? over.data : null) : (base?.data ?? null),
    })
  }
  for (const b of BUILTIN_LANES) add(b.id, b, typeof switches[b.id] === 'boolean' ? (switches[b.id] as boolean) : true)
  for (const id of Object.keys(reg)) if (!BUILTIN_LANES.some(b => b.id === id)) add(id, null, true)
  return { registry: true, lanes: out }
}
