import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'
import type { Controls, LaneInfo, LaneKey, LaneTotals, Quota, QuotaWindows, Review, RunningAgent, Routing, TurnRecord } from '../types'
import { ARGUMENT_HINT, DEFAULT_CONTROLS, LANE_KEYS, LANE_NAMES, MANUAL_TOAST, USAGE, checklist, drawsBand, effectiveRouting, isDelivery, laneName, parseLanes, parseReview, parseRouting, parseSpick } from './checklist'
import { MAIN_LANE, STALE_MS, bandSegments, estimateCost, fmtAge, fmtCost, fmtDuration, isSourcePath, modelName, noteParts, padRight, parseCli, quotaBar, quotaMeters, runningLines, table } from './format'
import type { BandView, Seg } from './format'
import { readQuota } from './quota'
import { lanesFromCache, quotaLineFromCache } from './quotaline'

const P = 'spick-dashboard'
const current = atom({ plugin: 'spick-dashboard', key: 'current' } as const, null)
const running = atom({ plugin: 'spick-dashboard', key: 'running' } as const, [])
const last = atom({ plugin: 'spick-dashboard', key: 'last' } as const, null)
const turns = atom({ plugin: 'spick-dashboard', key: 'turns' } as const, [])
const totals = atom({ plugin: 'spick-dashboard', key: 'totals' } as const, {})
const quota = atom({ plugin: 'spick-dashboard', key: 'quota' } as const, null)
const hidden = atom({ plugin: 'spick-dashboard', key: 'hidden' } as const, false)
const controls = atom({ plugin: 'spick-dashboard', key: 'controls' } as const, DEFAULT_CONTROLS)
const sessionModel = atom({ plugin: 'spick-dashboard', key: 'sessionModel' } as const, '')

const QUOTA_TTL_MS = 600_000
const TICK_MS = 1_000
const PANE = 'spick'
const MARKER_REFRESH_MS = 3_600_000

// Helpers that take $ are top-level function declarations: the validator
// follows $ only into functions declared at the top of this file.
async function refreshQuota($: EngineInterface, force = false): Promise<Quota> {
  const now = await $.clock.now()
  const q = await read($, quota)
  if (!force && q && now - q.readAt < QUOTA_TTL_MS) return q
  // env names stay literal: the validator lists the variables a module reads
  const env = (name: 'HOME' | 'CODEX_HOME') => (name === 'CODEX_HOME' ? $.env.get('CODEX_HOME') : $.env.get('HOME'))
  const fresh: Quota = await readQuota({ env, read: path => $.fs.read(path), list: path => $.fs.list(path) }, now)
  await update($, quota, () => fresh)
  return fresh
}

/**
 * The quota line, from the cache scripts/quota.py keeps at ~/.claude/spick-quota.json. One read, no run:
 * a missing, unreadable or empty cache gives null and the line is left out. The bash hook keeps the cache warm.
 */
async function quotaLineNow($: EngineInterface): Promise<string | null> {
  try {
    const home = await $.env.get('HOME')
    if (!home) return null
    return quotaLineFromCache(await $.fs.read(`${home}/.claude/spick-quota.json`), await $.clock.now())
  } catch { return null }
}

/** The lanes the user declared (lane_registry), from the same cache; null for a user without one, or when it cannot be read. */
async function lanesNow($: EngineInterface): Promise<LaneInfo[] | null> {
  try {
    const home = await $.env.get('HOME')
    if (!home) return null
    return lanesFromCache(await $.fs.read(`${home}/.claude/spick-quota.json`))
  } catch { return null }
}

/** the ids `/spick lane` accepts: the built-ins and every lane the cache registers */
async function knownLaneIds($: EngineInterface): Promise<string[]> {
  const extra = ((await lanesNow($)) ?? []).map(l => l.id).filter(id => !LANE_KEYS.includes(id))
  return [...LANE_KEYS, ...extra]
}

/** The three remembered choices: routing, review and the lanes (a JSON string). */
async function loadControls($: EngineInterface): Promise<void> {
  const routing = parseRouting(await $.store.get('spick:routing'))
  const review = parseReview(await $.store.get('spick:review'))
  const lanes = parseLanes(await $.store.get('spick:lanes'))
  // a manual model pick lasts one session only
  await update($, controls, () => ({ routing, review, lanes, manualModel: false }))
}

/** Change the switches and write the three remembered ones back to $.store. */
async function setControls($: EngineInterface, change: (c: Controls) => Controls): Promise<Controls> {
  const next = await update($, controls, change)
  try {
    await $.store.set('spick:routing', next.routing)
    await $.store.set('spick:review', next.review)
    await $.store.set('spick:lanes', JSON.stringify(next.lanes))
  } catch {}
  return next
}

/** The session model, read fresh where the engine answers, else the last one read. */
async function readSessionModel($: EngineInterface): Promise<string> {
  try {
    const m = await $.session.model()
    if (typeof m === 'string' && m) return await update($, sessionModel, () => m)
  } catch {}
  return await read($, sessionModel)
}

/**
 * Tell scripts/triage-hook.sh that the mod owns the checklist: it prints nothing
 * while this marker is younger than 24 hours.
 */
async function writeMarker($: EngineInterface): Promise<void> {
  const home = await $.env.get('HOME')
  if (!home) return
  await $.fs.write(`${home}/.claude/.spick-mod-active`, new Date(await $.clock.now()).toISOString())
}

/**
 * Whether the band is on screen: a surface that draws AbovePrompt and the band not hidden.
 * One test for both prompt.compose (its label-line section) and prompt.submit (the checklist's wording).
 */
async function bandShowing($: EngineInterface, surfaces: readonly RenderSurface[]): Promise<boolean> {
  return drawsBand(surfaces) && !(await read($, hidden))
}

/** the model now, or '' when the engine cannot say */
async function modelNow($: EngineInterface): Promise<string> {
  try {
    const m = await $.session.model()
    return typeof m === 'string' ? m : ''
  } catch {
    return ''
  }
}

/** A user's own model pick (a real change) turns routing off for the session; one toast. */
async function modelPickedByHand($: EngineInterface, model: string): Promise<void> {
  if (model) await update($, sessionModel, () => model)
  const before = await read($, controls)
  if (before.manualModel) return
  await update($, controls, c => ({ ...c, manualModel: true }))
  $.ui.toast(MANUAL_TOAST)
}

/** the reply to a routing change: the reason only where the value alone does not say it (auto, a manual pick) */
async function routingLine($: EngineInterface): Promise<string> {
  const c = await read($, controls)
  if (c.routing !== 'auto' && !c.manualModel) return `spick: routing ${c.routing}`
  return `spick: routing ${c.routing} · ${effectiveRouting(c, await readSessionModel($)).why}`
}

/** the quota meters as one line of text */
async function quotaLine($: EngineInterface, force: boolean): Promise<string> {
  const q = await refreshQuota($, force)
  const meters = quotaMeters(q).map(m => `${m.name} ${m.window} ${quotaBar(m.pct)} ${Math.round(m.pct)}%`)
  return meters.length > 0 ? `spick: quota ${meters.join('   ')}` : 'spick: quota unknown (no local data for claude or codex)'
}

/** `/spick` where nothing can draw a pane: one paragraph of status. */
async function statusParagraph($: EngineInterface): Promise<string> {
  const c = await read($, controls)
  const eff = effectiveRouting(c, await readSessionModel($))
  const lanes = (await knownLaneIds($)).map(k => `${laneName(k)} ${c.lanes[k] !== false ? 'on' : 'off'}`).join(', ')
  const quotaText = await quotaLine($, false).catch(() => 'spick: quota not read')
  return `spick: routing ${c.routing}, ${eff.why}; review ${c.review}; lanes: ${lanes}; band ${(await read($, hidden)) ? 'hidden' : 'shown'}; ${quotaText.replace(/^spick: /, '')}.`
}

async function setCurrent($: EngineInterface, patch: Partial<TurnRecord>): Promise<void> {
  await update($, current, c => (c ? { ...c, ...patch } : c))
}

/** who works on the band: the main session, a subagent call or a CLI call */
type Lane = {
  lane: string; model: string; effort?: string; agentIndex?: number; isReview?: boolean
  /** when the call began; set on every call in flight */
  startedAt?: number
  /** on the lane `showing` returns: how many calls of that lane run, and when the oldest began */
  count?: number
  since?: number
}

/**
 * Put a lane on the current turn. `pick` runs inside the update, so calls that
 * finish in parallel never write back a lane read before the other one landed.
 */
async function showLane($: EngineInterface, pick: () => Lane, extra: (c: TurnRecord) => Partial<TurnRecord> = () => ({})): Promise<void> {
  await update($, current, c => {
    if (!c) return c
    const l = pick()
    return { ...c, ...extra(c), lane: l.lane, model: l.model, effort: l.effort, agentIndex: l.agentIndex, isReview: l.isReview, laneCount: l.count, laneSince: l.since }
  })
}

/** The Running section's state: the calls in flight (oldest first), then those that timed out. */
async function publishRunning($: EngineInterface, inFlight: Map<string, Lane>, timedOut: Map<string, RunningAgent>): Promise<void> {
  const live: RunningAgent[] = [...inFlight].map(([id, l]) => ({ id, lane: l.lane, model: l.model, effort: l.effort, startedAt: l.startedAt ?? 0 }))
  await update($, running, () => [...live, ...timedOut.values()])
}

/** What the band bookkeeping reads: the calls in flight, the timed-out ones, who shows now, whether the main turn is open. */
type Tracker = { inFlight: Map<string, Lane>; timedOut: Map<string, RunningAgent>; showing: () => Lane; isMainTurnOpen: () => boolean }

/** put the lane that works now on the band and publish the Running list */
async function refreshBand($: EngineInterface, t: Tracker, extra?: (c: TurnRecord) => Partial<TurnRecord>): Promise<void> {
  await showLane($, t.showing, extra)
  await publishRunning($, t.inFlight, t.timedOut)
}

/** Move calls with no completion signal for STALE_MS out of flight into `timedOut`. True when any moved. */
async function sweepStale($: EngineInterface, inFlight: Map<string, Lane>, timedOut: Map<string, RunningAgent>): Promise<boolean> {
  const now = await $.clock.now()
  let moved = false
  for (const [id, l] of [...inFlight]) {
    if (l.startedAt === undefined || now - l.startedAt < STALE_MS) continue
    inFlight.delete(id)
    timedOut.set(id, { id, lane: l.lane, model: l.model, effort: l.effort, startedAt: l.startedAt, timedOutAt: now })
    moved = true
  }
  return moved
}

/** Drop calls that have gone 30 minutes without a completion signal; the band follows. */
async function sweep($: EngineInterface, t: Tracker): Promise<void> {
  if (!(await sweepStale($, t.inFlight, t.timedOut))) return
  // nothing left running after the main turn ended: the band goes idle
  if (!t.isMainTurnOpen() && t.inFlight.size === 0) await update($, current, () => null)
  else await showLane($, t.showing)
  await publishRunning($, t.inFlight, t.timedOut)
}

/**
 * Stamp the current turn with the time, so the band's elapsed time moves.
 * At most one write per TICK_MS: returns the stamp to compare the next call with.
 */
async function tick($: EngineInterface, lastMs: number): Promise<number> {
  const now = await $.clock.now()
  if (now - lastMs < TICK_MS) return lastMs
  if (!(await read($, current))) return lastMs
  // parallel streams may tick from the same old stamp: never move the clock back
  await update($, current, c => (c ? { ...c, nowMs: Math.max(c.nowMs ?? 0, now) } : c))
  return now
}

const ZERO_TOTALS: LaneTotals = { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null }

/** a Haiku main session editing source itself is the attention case the band flags */
async function noteEdit($: EngineInterface, mainModel: string, agentId: string | undefined, filePath: string): Promise<void> {
  try {
    if (!agentId && /haiku/.test(mainModel) && isSourcePath(filePath)) {
      const name = filePath.split('/').slice(-2).join('/')
      await setCurrent($, { note: { kind: 'error', text: `edited ${name}` } })
    }
  } catch {}
}

// The .catch on the gating hooks: should one throw past its own try/catch or
// overrun its budget, its call passes through. In a .catch, next is
// replay-safe: when the hook had already called it, nothing beneath runs again.
function passThrough<E, R>($: unknown, e: E, next: (e: E) => R): R {
  return next(e)
}

const routingOptions: readonly Routing[] = ['auto', 'on', 'off']
const reviewOptions: readonly Review[] = ['auto', 'off']
const nextRouting = (r: Routing): Routing => (r === 'auto' ? 'on' : r === 'on' ? 'off' : 'auto')
const LANE_HOTKEYS: Record<LaneKey, string> = { gemini: 'g', grok: 'k', codex: 'c' }

const clock = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

// Every hook here only observes: its own work sits in try/catch so a failure
// still ends in next(e), and next's own result is never swallowed.
export const register: Register = on => {
  /** agentId -> lane name, for attributing subagent turn.complete usage */
  const laneOfAgent = new Map<string, string>()
  /** agentId -> the Agent call that started it, so a background agent's lane leaves the band when it finishes */
  const callOfAgent = new Map<string, string>()
  /** tool_use_id -> lane of every Agent or CLI call in flight, oldest first; the band shows the most recent */
  const inFlight = new Map<string, Lane>()
  /** whether the main session's turn is open: a background agent outlives it, and the band must not read idle meanwhile */
  let mainTurnOpen = false
  /** true for an Agent call whose subagent has spawned and not yet finished (a background agent, or a foreground one still running) */
  const isRunningAgentCall = (id: string): boolean => { for (const c of callOfAgent.values()) if (c === id) return true; return false }
  /** forget every call in flight except the ones whose subagent is still running */
  const dropFinishedCalls = (): void => { for (const id of [...inFlight.keys()]) if (!isRunningAgentCall(id)) inFlight.delete(id) }
  /** the turn's latest delegate (Agent or CLI call), kept after the call ends: the closed turn is recorded under it */
  let delegate: Lane | null = null
  let agentsThisTurn = 0
  let mainModel = ''
  let mainEffort: string | undefined
  /** the last elapsed-time stamp written to `current` */
  let lastTickMs = 0
  /** when the mod-active marker was last written */
  let markerAt = 0
  /** the model before a user's /model that changed nothing yet (a picker may still be open) */
  let modelBeforePick: string | null = null

  const mainLane = (): Lane => ({ lane: MAIN_LANE, model: modelName(mainModel), effort: mainEffort })
  /** the most recent call still in flight; the main session only when none is */
  const showing = (): Lane => {
    let top: Lane | undefined
    for (const l of inFlight.values()) top = l
    if (!top) return mainLane()
    // calls of the same lane aggregate: how many run, and when the oldest began
    let count = 0
    let since: number | undefined
    for (const l of inFlight.values()) {
      if (l.lane !== top.lane) continue
      count++
      if (l.startedAt !== undefined) since = since === undefined ? l.startedAt : Math.min(since, l.startedAt)
    }
    return { ...top, count, since }
  }
  /** calls that timed out (no completion signal for 30 minutes), listed in the pane until the next prompt drops them */
  const timedOut = new Map<string, RunningAgent>()
  const tracker: Tracker = { inFlight, timedOut, showing, isMainTurnOpen: () => mainTurnOpen }

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'spick', description: 'Spick dashboard and switches: routing, review, lanes, band, quota', argumentHint: ARGUMENT_HINT, immediate: true })
      void refreshQuota($).catch(() => undefined)
    } catch {}
    try { await loadControls($) } catch {}
    try { await readSessionModel($) } catch {}
    // unawaited: a slow write must not hold the session's start
    try {
      markerAt = await $.clock.now()
      void writeMarker($).catch(() => undefined)
    } catch {}
    return next(e)
  })

  // The per-prompt checklist: exactly one block, built from the switches, worded for
  // whether the band shows. Rewrites only the context it attaches; any failure
  // (the session model unreadable included) passes the prompt on unchanged.
  on('prompt.submit', async ($, e, next) => {
    let block: string | null = null
    try {
      if (!isDelivery(e.origin.kind)) {
        // rows that timed out before this prompt leave the pane now; any that time out from here on stay one more prompt
        if (timedOut.size > 0) { timedOut.clear(); await publishRunning($, inFlight, timedOut) }
        await sweep($, tracker)
        // an unreadable model ('') falls back to the last one read, then the main loop's
        const fresh = await modelNow($)
        if (fresh) await update($, sessionModel, () => fresh)
        // a /model whose picker answered after the command returned: compare now
        if (modelBeforePick !== null) {
          const before = modelBeforePick
          modelBeforePick = null
          if (fresh && fresh !== before) await modelPickedByHand($, fresh)
        }
        const surfaces = await $.session.surfaces().catch(() => [] as readonly RenderSurface[])
        block = checklist(await read($, controls), fresh || (await read($, sessionModel)) || mainModel, !(await bandShowing($, surfaces)), (await quotaLineNow($)) ?? undefined, (await lanesNow($)) ?? undefined)
        // keep the bash hook silent through long sessions: refresh the marker hourly
        const now = await $.clock.now()
        if (now - markerAt >= MARKER_REFRESH_MS) {
          markerAt = now
          void writeMarker($).catch(() => undefined)
        }
      }
    } catch {
      block = null
    }
    return next(block ? { ...e, context: [...(e.context ?? []), block] } : e)
  }).catch(passThrough)

  // A model the user picks by hand (/model, or the model setting) turns routing off for
  // the session, only when the model really changed.
  on('command.run', { command: 'model' }, async ($, e, next) => {
    const isUser = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    const before = isUser ? await modelNow($) : ''
    const r = await next(e)
    try {
      if (isUser && before) {
        const after = await modelNow($)
        if (after && after !== before) { modelBeforePick = null; await modelPickedByHand($, after) }
        // unchanged: maybe a picker still open; the next prompt compares again
        else modelBeforePick = before
      }
    } catch {}
    return r
  }).catch(passThrough)
  on('config.set', { key: 'model' }, async ($, e, next) => {
    const r = await next(e)
    try {
      const isUser = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
      if (isUser && !r.deny && e.value !== e.previous) { modelBeforePick = null; await modelPickedByHand($, await modelNow($)) }
    } catch {}
    return r
  }).catch(passThrough)

  // Tell the model the band is showing so it omits the label line. Only where a
  // band is drawn (terminal, desktop) and not hidden; elsewhere the label stays.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    try {
      if (!(await bandShowing($, e.surfaces))) return r
      return { sections: [...r.sections, { id: `${P}:band`, scope: 'session' as const, text: 'The Spick status band is showing above the prompt. Do not print the [Model: ... | Effort: ...] label line at the end of replies; this overrides any note that asks for it.' }] }
    } catch {
      return r
    }
  })

  on('turn.start', async ($, e, next) => {
    try {
      const startedAt = await $.clock.now()
      mainTurnOpen = true
      dropFinishedCalls()
      delegate = null
      agentsThisTurn = 0
      lastTickMs = startedAt
      await update($, current, () => ({ turnId: e.turnId, startedAt, nowMs: startedAt, lane: MAIN_LANE, model: modelName(mainModel), effort: mainEffort, agents: 0 }))
      await sweep($, tracker)
      await refreshBand($, tracker)
      // the TTL gates it: at most one read per ten minutes, so the band's quota meters stay current
      void refreshQuota($).catch(() => undefined)
    } catch {}
    return next(e)
  })

  // Every chunk passes up unchanged; each one (main loop or subagent) may tick the elapsed time.
  on('turn.step', async function* ($, e, next) {
    try {
      if (!e.agentId) {
        mainModel = e.model
        mainEffort = typeof e.effort === 'string' ? e.effort : undefined
        await sweep($, tracker)
        await refreshBand($, tracker)
      }
    } catch {}
    const stream = next(e)
    for await (const chunk of stream) {
      yield chunk
      try { lastTickMs = Math.max(lastTickMs, await tick($, lastTickMs)) } catch {}
    }
    return await stream.result
  })

  // any tool call, from any loop, ticks the elapsed time
  on('tool.call', async ($, e, next) => {
    try { lastTickMs = Math.max(lastTickMs, await tick($, lastTickMs)) } catch {}
    try { await sweep($, tracker) } catch {}
    return next(e)
  }).catch(passThrough)

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const id = e.tool_use_id
    try {
      const entry: Lane = { lane: e.subagent_type ?? 'agent', model: e.model ? modelName(e.model) : '', effort: e.effort, agentIndex: ++agentsThisTurn, startedAt: await $.clock.now() }
      inFlight.set(id, entry)
      delegate = entry
      await refreshBand($, tracker, () => ({ agents: agentsThisTurn }))
    } catch {}
    // finally: an interrupted call must not leave the subagent's lane on the band
    try {
      return await next(e)
    } finally {
      try {
        if (!e.run_in_background) {
          inFlight.delete(id)
          await refreshBand($, tracker)
        }
      } catch {}
    }
  }).catch(passThrough)

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    try {
      if (r.agentId) {
        laneOfAgent.set(r.agentId, e.subagentType)
        callOfAgent.set(r.agentId, e.tool_use_id)
      }
      // the resolved type and model replace what the Agent call named (it may have named neither)
      const entry = inFlight.get(e.tool_use_id)
      if (entry && !r.deny) {
        entry.lane = e.subagentType
        if (r.model) entry.model = modelName(r.model)
        await refreshBand($, tracker)
      }
    } catch {}
    return r
  }).catch(passThrough)

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId) return next(e)
    const id = e.tool_use_id
    let isCli = false
    try {
      const cli = parseCli(e.command)
      if (cli) {
        isCli = true
        const entry: Lane = { lane: cli.lane, model: cli.model ?? '', effort: cli.effort, isReview: cli.isReview, startedAt: await $.clock.now() }
        inFlight.set(id, entry)
        delegate = entry
        await refreshBand($, tracker, () => (cli.isReview ? { note: { kind: 'warning' as const, text: 'review: codex' } } : {}))
        // outside CLIs report no usage: count the call, leave it unpriced
        await update($, totals, t => {
          const cur = t[cli.lane] ?? ZERO_TOTALS
          return { ...t, [cli.lane]: { ...cur, turns: cur.turns + 1 } }
        })
      }
    } catch {}
    try {
      return await next(e)
    } finally {
      if (isCli) {
        try {
          inFlight.delete(id)
          await refreshBand($, tracker)
        } catch {}
      }
    }
  }).catch(passThrough)

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    await noteEdit($, mainModel, e.agentId, e.file_path)
    return next(e)
  }).catch(passThrough)
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    await noteEdit($, mainModel, e.agentId, e.file_path)
    return next(e)
  }).catch(passThrough)

  on('turn.complete', async ($, e, next) => {
    try {
      const lane = e.agentId ? (laneOfAgent.get(e.agentId) ?? 'agent') : MAIN_LANE
      const usage = e.usage
      if (usage) {
        const cost = estimateCost(usage.model, usage)
        await update($, totals, t => {
          const cur: LaneTotals = t[lane] ?? ZERO_TOTALS
          return { ...t, [lane]: {
            turns: cur.turns + 1,
            inputTokens: cur.inputTokens + usage.input_tokens,
            outputTokens: cur.outputTokens + usage.output_tokens,
            cacheReadTokens: cur.cacheReadTokens + usage.cache_read_input_tokens,
            cacheCreationTokens: (cur.cacheCreationTokens ?? 0) + usage.cache_creation_input_tokens,
            costUsd: cost === null ? cur.costUsd : (cur.costUsd ?? 0) + cost,
          } }
        })
      }
      if (e.agentId) {
        laneOfAgent.delete(e.agentId)
        const call = callOfAgent.get(e.agentId)
        callOfAgent.delete(e.agentId)
        // a background agent's Agent call returned long ago; its lane leaves the band now
        if (call !== undefined && inFlight.delete(call)) {
          // the main turn already ended and this was the last agent: the band goes idle (last stays as written)
          if (!mainTurnOpen && inFlight.size === 0) await update($, current, () => null)
          else await showLane($, showing)
          await publishRunning($, inFlight, timedOut)
        } else if (call !== undefined && timedOut.delete(call)) {
          // it did finish after all: its "timed out" row goes
          await publishRunning($, inFlight, timedOut)
        }
      } else {
        const endedAt = await $.clock.now()
        mainTurnOpen = false
        dropFinishedCalls()
        const c = await read($, current)
        if (c) {
          // the turn is recorded under its latest delegate, the main session when it had none
          const who = delegate ?? mainLane()
          const done: TurnRecord = { ...c, lane: who.lane, model: who.model, effort: who.effort, endedAt, costUsd: usage ? estimateCost(usage.model, usage) : null }
          delete done.agentIndex
          delete done.isReview
          delete done.laneCount
          delete done.laneSince
          delete done.nowMs
          await update($, last, () => done)
          await update($, turns, list => [done, ...list].slice(0, 50))
          // a background agent still running keeps the band on its lane (turnId and start time kept, so the
          // elapsed time goes on) until its own turn.complete clears it
          if (inFlight.size > 0) await showLane($, showing, () => ({ note: undefined }))
          else await update($, current, () => null)
        }
        await sweep($, tracker)
        await publishRunning($, inFlight, timedOut)
      }
    } catch {}
    return next(e)
  })

  // Every change answers one line; the pane redraws from the state it reads.
  on('command.run', { command: 'spick' }, async ($, e) => {
    const cmd = parseSpick(e.args, await knownLaneIds($))
    switch (cmd.kind) {
      case 'band':
        await update($, hidden, () => cmd.hidden)
        return { text: cmd.hidden ? 'spick: band hidden · /spick show restores it' : 'spick: band shown' }
      case 'routing':
        // the user has decided: a /model still pending comparison no longer counts
        modelBeforePick = null
        await setControls($, c => ({ ...c, routing: cmd.value, manualModel: false }))
        return { text: await routingLine($) }
      case 'review':
        await setControls($, c => ({ ...c, review: cmd.value }))
        return { text: `spick: review ${cmd.value}` }
      case 'lane':
        await setControls($, c => ({ ...c, lanes: { ...c.lanes, [cmd.lane]: cmd.on } }))
        return { text: `spick: ${laneName(cmd.lane)} lane ${cmd.on ? 'on' : 'off'}` }
      case 'quota':
        return { text: await quotaLine($, true).catch(() => 'spick: quota not read') }
      case 'usage':
        return { text: USAGE }
      case 'open': {
        await refreshQuota($, true).catch(() => undefined)
        const surfaces = await $.session.surfaces().catch(() => [] as const)
        if (surfaces.length === 0) return { text: await statusParagraph($) }
        const placed = await $.ui.open({ id: PANE, title: 'SPICK', closeOnEscape: true })
        return { text: placed.isPlaced ? 'spick: pane opened' : `spick: pane not placed: ${placed.reason}` }
      }
    }
  })

  // The band: one line, a short sentence about who is working now. Slot order
  // never changes; the right group holds at most one item: an attention cause or a hint.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hidden))) return next(e)
    const c = await read($, current)
    const l = await read($, last)
    const view: BandView | null = c
      ? { lane: c.lane, model: c.model, agents: c.agents, agentIndex: c.agentIndex, isReview: c.isReview, isIdle: false, count: c.laneCount,
          // several of one lane: the time is the oldest of them; one agent or none: the turn's, as before
          durationMs: Math.max(0, (c.nowMs ?? c.startedAt) - (c.laneCount !== undefined && c.laneCount > 1 && c.laneSince !== undefined ? c.laneSince : c.startedAt)), note: c.note, mainModel: mainModel ? modelName(mainModel) : undefined }
      : l
        ? { lane: l.lane, model: l.model, agents: 0, isIdle: true }
        : null
    if (!view) return next(e)
    // routing off shows on the wordmark; under auto, only once the model is known
    const ctl = await read($, controls)
    const model = (await read($, sessionModel)) || mainModel
    view.routingOff = (model !== '' || ctl.routing !== 'auto' || ctl.manualModel) && !effectiveRouting(ctl, model).on
    const { left, right } = bandSegments(view, e.props.bodyColumns)
    const { Box, Text } = $.ui.resolve(e)
    const paint = (s: Seg) => {
      switch (s.style) {
        case 'brand': return <Text bold color="claude" wrap="truncate-end">{s.text}</Text>
        case 'lane': return <Text bold wrap="truncate-end">{s.text}</Text>
        case 'dim': return <Text color="subtle" wrap="truncate-end">{s.text}</Text>
        case 'plain': return <Text wrap="truncate-end">{s.text}</Text>
        default: return <Text color={s.style} wrap="truncate-end">{s.text}</Text>
      }
    }
    return (
      <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" gap={2} width="100%">
        <Box flexDirection="row" flexShrink={1}>{left.map(paint)}</Box>
        {right.length > 0 ? <Box flexDirection="row" flexShrink={1}>{right.map(paint)}</Box> : null}
      </Box>
    )
  })

  // The pane: the controls, then the session, quota and recent turns, spacing and weight only, no borders.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const ctl = await read($, controls)
    const eff = effectiveRouting(ctl, (await read($, sessionModel)) || mainModel)
    const t = await read($, totals)
    const runningNow = await read($, running)
    const q = await read($, quota)
    const list = await read($, turns)
    const isHidden = await read($, hidden)
    // a manual model pick shows as off: the switch's value for this session
    const shownRouting: Routing = ctl.manualModel ? 'off' : ctl.routing
    const now = await $.clock.now()
    const rows = e.props.scroll?.bodyRows || e.viewport?.rows || 30

    const isNarrow = e.props.bodyColumns < 80
    const barCells = isNarrow ? 5 : 10

    // "This session" is the table's header row: its heading and column headers share one row
    const lanes = Object.entries(t).sort((a, b) => b[1].turns - a[1].turns)
    const totalCost = lanes.reduce<number | null>((acc, [, v]) => (v.costUsd === null ? acc : (acc ?? 0) + v.costUsd), null)
    const sessionTable = table([
      ['This session', 'turns', 'at API rates'],
      ...lanes.map(([lane, v]) => ['  ' + lane, String(v.turns), fmtCost(v.costUsd)]),
      ...(lanes.length > 1 ? [['  total', String(lanes.reduce((n, [, v]) => n + v.turns, 0)), fmtCost(totalCost)]] : []),
    ], ['l', 'r', 'r'])
    const headCut = 'This session'.length

    // only claude and codex; a provider with no window data gets no row
    const quotaRows = ([['claude', q?.claude], ['codex', q?.codex]] as [string, QuotaWindows | null | undefined][]).map(([name, w]) => {
      const cells: { lead: string; meter: string }[] = []
      for (const [label, pct] of [['5h', w?.fiveHour], ['7d', w?.sevenDay]] as const) {
        if (pct === undefined) continue
        cells.push({ lead: `${cells.length > 0 ? '     ' : ''}${label}  `, meter: `${quotaBar(pct, barCells)} ${String(Math.round(pct)).padStart(3)}%` })
      }
      return { name: padRight(name, 8), cells }
    }).filter(r => r.cells.length > 0)
    const quotaNote = !q ? 'not read' : quotaRows.length === 0 ? 'unknown' : ''

    // rows the pane uses besides the turn list, so the list never scrolls past the bottom
    const runningView = runningLines(runningNow, now)
    const runningUsed = runningNow.length > 0 ? 2 + runningView.lines.length + (runningView.more > 0 ? 1 : 0) : 0
    const used = runningUsed + 2 + 5 + (isNarrow ? 1 : 0) + 2 + sessionTable.length + 2 + 1 + Math.max(quotaRows.length, quotaNote ? 1 : 0) + 2
    const recent = list.slice(0, Math.max(1, rows - used))
    const recentTable = table(
      recent.map(r => [clock(r.startedAt), r.lane, r.model, r.effort ?? '', fmtDuration((r.endedAt ?? r.startedAt) - r.startedAt)]),
      ['l', 'l', 'l', 'l', 'r'])

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color="claude">SPICK</Text>
          <Button key="close" label="Close" variant="secondary" hotkey="x" role="dismiss" onPress={() => { void $.ui.close({ id: PANE }).catch(() => undefined) }} />
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Controls</Text>
          <Box flexDirection="column" paddingLeft={2}>
            <Box flexDirection="row">
              <Text>{padRight('Routing', 10)}</Text>
              {routingOptions.flatMap((v, i) => [
                i > 0 ? <Text>{' '}</Text> : null,
                <Button key={`routing-${v}`} label={`${shownRouting === v ? '◉' : '○'} ${v}`}
                  variant={shownRouting === v ? 'primary' : 'secondary'}
                  // r presses the next value's button: auto -> on -> off -> auto; the active one does nothing
                  hotkey={nextRouting(shownRouting) === v ? 'r' : undefined}
                  onPress={() => { if (shownRouting !== v) void setControls($, c => ({ ...c, routing: v, manualModel: false })).catch(() => undefined) }} />,
              ])}
              {isNarrow ? null : <Text color="subtle">{'      ' + eff.why}</Text>}
            </Box>
            {isNarrow ? <Text color="subtle">{' '.repeat(10) + eff.why}</Text> : null}
            <Box flexDirection="row">
              <Text>{padRight('Review', 10)}</Text>
              {reviewOptions.flatMap((v, i) => [
                i > 0 ? <Text>{' '}</Text> : null,
                <Button key={`review-${v}`} label={`${ctl.review === v ? '◉' : '○'} ${v}`}
                  variant={ctl.review === v ? 'primary' : 'secondary'}
                  // v presses the other option
                  hotkey={ctl.review !== v ? 'v' : undefined}
                  onPress={() => { if (ctl.review !== v) void setControls($, c => ({ ...c, review: v })).catch(() => undefined) }} />,
              ])}
            </Box>
            <Box flexDirection="row">
              <Text>{padRight('Lanes', 10)}</Text>
              {LANE_KEYS.flatMap((k, i) => [
                i > 0 ? <Text>{' '}</Text> : null,
                <Button key={`lane-${k}`} label={`${LANE_NAMES[k]} ${ctl.lanes[k] ? 'on' : 'off'}`}
                  variant={ctl.lanes[k] ? 'primary' : 'secondary'} hotkey={LANE_HOTKEYS[k]}
                  onPress={() => { void setControls($, c => ({ ...c, lanes: { ...c.lanes, [k]: !c.lanes[k] } })).catch(() => undefined) }} />,
              ])}
            </Box>
            <Box flexDirection="row">
              <Text>{padRight('Band', 10)}</Text>
              <Button key="band" label={isHidden ? 'hidden' : 'shown'} variant={isHidden ? 'secondary' : 'primary'} hotkey="b"
                onPress={() => { void update($, hidden, v => !v) }} />
            </Box>
          </Box>
        </Box>

        {runningNow.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Running</Text>
            <Box flexDirection="column" paddingLeft={2}>
              {runningView.lines.map(line => <Text>{line}</Text>)}
              {runningView.more > 0 ? <Text color="subtle">{`and ${runningView.more} more`}</Text> : null}
            </Box>
          </Box>
        ) : null}

        <Box flexDirection="column" marginTop={1}>
          {sessionTable.map((line, i) =>
            i === 0 ? (lanes.length > 0 ? <Text><Text bold>{line.slice(0, headCut)}</Text><Text color="subtle">{line.slice(headCut)}</Text></Text> : <Text bold>This session</Text>)
            : <Text>{line}</Text>)}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row">
            <Text bold>Quota</Text>
            {q ? <Text>{'  '}</Text> : null}
            {q ? <Text color="subtle">{fmtAge(now - q.readAt)}</Text> : null}
            <Text>{'  '}</Text>
            <Button key="refresh" label="Refresh" variant="secondary" hotkey="q" onPress={() => { void refreshQuota($, true).catch(() => undefined) }} />
          </Box>
          <Box flexDirection="column" paddingLeft={2}>
            {quotaNote ? <Text color="subtle">{quotaNote}</Text> : null}
            {quotaRows.map(r => <Text>{r.name}{r.cells.flatMap(c => [c.lead, c.meter])}</Text>)}
          </Box>
        </Box>

        {recent.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Recent turns</Text>
            <Box flexDirection="column" paddingLeft={2}>
              {recentTable.map((line, i) => {
                const note = recent[i]?.note
                if (!note) return <Text>{line}</Text>
                return <Text>{`${line}   `}{noteParts(note).map(p => (p.style === 'warning' || p.style === 'error' ? <Text color={p.style}>{p.text}</Text> : p.text))}</Text>
              })}
            </Box>
          </Box>
        ) : null}

      </Box>
    )
  })
}
