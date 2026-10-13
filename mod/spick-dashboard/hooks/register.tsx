import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { LaneTotals, Quota, QuotaWindows, TurnRecord } from '../types'
import { MAIN_LANE, bandSegments, estimateCost, fmtAge, fmtCost, fmtDuration, isSourcePath, modelName, noteParts, padRight, parseCli, quotaBar, quotaMeters, table } from './format'
import type { BandView, Seg } from './format'
import { readQuota } from './quota'

const P = 'spick-dashboard'
const current = atom({ plugin: 'spick-dashboard', key: 'current' } as const, null)
const last = atom({ plugin: 'spick-dashboard', key: 'last' } as const, null)
const turns = atom({ plugin: 'spick-dashboard', key: 'turns' } as const, [])
const totals = atom({ plugin: 'spick-dashboard', key: 'totals' } as const, {})
const quota = atom({ plugin: 'spick-dashboard', key: 'quota' } as const, null)
const hidden = atom({ plugin: 'spick-dashboard', key: 'hidden' } as const, false)

const QUOTA_TTL_MS = 600_000
const TICK_MS = 1_000
const PANE = 'spick'

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

async function setCurrent($: EngineInterface, patch: Partial<TurnRecord>): Promise<void> {
  await update($, current, c => (c ? { ...c, ...patch } : c))
}

/** who works on the band: the main session, a subagent call or a CLI call */
type Lane = { lane: string; model: string; effort?: string; agentIndex?: number; isReview?: boolean }

/**
 * Put a lane on the current turn. `pick` runs inside the update, so calls that
 * finish in parallel never write back a lane read before the other one landed.
 */
async function showLane($: EngineInterface, pick: () => Lane, extra: (c: TurnRecord) => Partial<TurnRecord> = () => ({})): Promise<void> {
  await update($, current, c => {
    if (!c) return c
    const l = pick()
    return { ...c, ...extra(c), lane: l.lane, model: l.model, effort: l.effort, agentIndex: l.agentIndex, isReview: l.isReview }
  })
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
  /** the turn's latest delegate (Agent or CLI call), kept after the call ends: the closed turn is recorded under it */
  let delegate: Lane | null = null
  let agentsThisTurn = 0
  let mainModel = ''
  let mainEffort: string | undefined
  /** the last elapsed-time stamp written to `current` */
  let lastTickMs = 0

  const mainLane = (): Lane => ({ lane: MAIN_LANE, model: modelName(mainModel), effort: mainEffort })
  /** the most recent call still in flight; the main session only when none is */
  const showing = (): Lane => {
    let top: Lane | undefined
    for (const l of inFlight.values()) top = l
    return top ?? mainLane()
  }

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'spick', description: 'Spick dashboard: lanes, quota, recent turns', argumentHint: '[show|hide|quota]' })
      void refreshQuota($).catch(() => undefined)
    } catch {}
    return next(e)
  })

  // Tell the model the band is showing so it omits the label line. Only where a
  // band is drawn (terminal, desktop) and not hidden; elsewhere the label stays.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    try {
      if (!e.surfaces.some(s => s === 'terminal' || s === 'desktop')) return r
      if (await read($, hidden)) return r
      return { sections: [...r.sections, { id: `${P}:band`, scope: 'session' as const, text: 'The Spick status band is showing above the prompt. Do not print the [Model: ... | Effort: ...] label line at the end of replies.' }] }
    } catch {
      return r
    }
  })

  on('turn.start', async ($, e, next) => {
    try {
      const startedAt = await $.clock.now()
      inFlight.clear()
      delegate = null
      agentsThisTurn = 0
      lastTickMs = startedAt
      await update($, current, () => ({ turnId: e.turnId, startedAt, nowMs: startedAt, lane: MAIN_LANE, model: modelName(mainModel), effort: mainEffort, agents: 0 }))
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
        await showLane($, showing)
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
    return next(e)
  }).catch(passThrough)

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const id = e.tool_use_id
    try {
      const entry: Lane = { lane: e.subagent_type ?? 'agent', model: e.model ? modelName(e.model) : '', effort: e.effort, agentIndex: ++agentsThisTurn }
      inFlight.set(id, entry)
      delegate = entry
      await showLane($, showing, () => ({ agents: agentsThisTurn }))
    } catch {}
    // finally: an interrupted call must not leave the subagent's lane on the band
    try {
      return await next(e)
    } finally {
      try {
        if (!e.run_in_background) {
          inFlight.delete(id)
          await showLane($, showing)
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
        await showLane($, showing)
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
        const entry: Lane = { lane: cli.lane, model: cli.model ?? '', effort: cli.effort, isReview: cli.isReview }
        inFlight.set(id, entry)
        delegate = entry
        await showLane($, showing, () => (cli.isReview ? { note: { kind: 'warning' as const, text: 'review: codex' } } : {}))
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
          await showLane($, showing)
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
        if (call !== undefined && inFlight.delete(call)) await showLane($, showing)
      } else {
        const endedAt = await $.clock.now()
        const c = await read($, current)
        if (c) {
          // the turn is recorded under its latest delegate, the main session when it had none
          const who = delegate ?? mainLane()
          const done: TurnRecord = { ...c, lane: who.lane, model: who.model, effort: who.effort, endedAt, costUsd: usage ? estimateCost(usage.model, usage) : null }
          delete done.agentIndex
          delete done.isReview
          delete done.nowMs
          await update($, last, () => done)
          await update($, turns, list => [done, ...list].slice(0, 50))
          await update($, current, () => null)
        }
      }
    } catch {}
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

  // The band: one line, a short sentence about who is working now. Slot order
  // never changes; the right group holds context or an attention cause.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hidden))) return next(e)
    const c = await read($, current)
    const l = await read($, last)
    const view: BandView | null = c
      ? { lane: c.lane, model: c.model, effort: c.effort, agents: c.agents, agentIndex: c.agentIndex, isReview: c.isReview, isIdle: false,
          durationMs: Math.max(0, (c.nowMs ?? c.startedAt) - c.startedAt), note: c.note, mainModel: mainModel ? modelName(mainModel) : undefined }
      : l
        ? { lane: l.lane, model: l.model, effort: l.effort, agents: 0, isIdle: true, durationMs: (l.endedAt ?? l.startedAt) - l.startedAt }
        : null
    if (!view) return next(e)
    // quota shows as meters on the right (bandSegments decides when); a hot provider is colored there, never a cause
    view.meters = quotaMeters(await read($, quota))
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
      <Box flexDirection="row" justifyContent="space-between" gap={2} width="100%">
        <Box flexDirection="row">{left.map(paint)}</Box>
        {right.length > 0 ? <Box flexDirection="row">{right.map(paint)}</Box> : null}
      </Box>
    )
  })

  // The pane: three sections, spacing and weight only, no borders.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const t = await read($, totals)
    const q = await read($, quota)
    const list = await read($, turns)
    const isHidden = await read($, hidden)
    const now = await $.clock.now()
    const rows = e.props.scroll?.bodyRows || e.viewport?.rows || 30

    const lanes = Object.entries(t).sort((a, b) => b[1].turns - a[1].turns)
    const totalCost = lanes.reduce<number | null>((acc, [, v]) => (v.costUsd === null ? acc : (acc ?? 0) + v.costUsd), null)
    const sessionTable = table([
      ['lane', 'turns', 'est. cost'],
      ...lanes.map(([lane, v]) => [lane, String(v.turns), fmtCost(v.costUsd)]),
      ['total', String(lanes.reduce((n, [, v]) => n + v.turns, 0)), fmtCost(totalCost)],
    ], ['l', 'r', 'r'])

    // name column 8 wide; `unknown` starts where the bars do
    const quotaSources: [string, QuotaWindows | null | undefined][] = [['claude', q?.claude], ['codex', q?.codex], ['grok', null], ['gemini', null]]
    const quotaCells = quotaSources.map(([name, w]) => {
      const cells: { lead: string; meter: string; isTight: boolean }[] = []
      for (const [label, pct] of [['5h', w?.fiveHour], ['7d', w?.sevenDay]] as const) {
        if (pct === undefined) continue
        cells.push({ lead: `${cells.length > 0 ? '     ' : ''}${label}  `, meter: `${quotaBar(pct)} ${String(Math.round(pct)).padStart(3)}%`, isTight: pct >= 80 })
      }
      return { name: padRight(name, 8), cells }
    })
    const quotaRowLength = (r: (typeof quotaCells)[number]) =>
      r.cells.length === 0 ? r.name.length + 11 : r.cells.reduce((n, c) => n + c.lead.length + c.meter.length, r.name.length)
    const staleness = q ? `refreshed ${fmtAge(now - q.readAt)}` : 'not read yet'
    // the heading row spans the quota block, so the staleness note sits beside the numbers it describes
    const quotaWidth = Math.max(2 + Math.max(...quotaCells.map(quotaRowLength)), 'Quota'.length + 2 + staleness.length)

    const recent = list.slice(0, Math.max(1, rows - 14))
    const recentTable = table(
      recent.map(r => [clock(r.startedAt), r.lane, r.model, r.effort ?? '', fmtDuration((r.endedAt ?? r.startedAt) - r.startedAt)]),
      ['l', 'l', 'l', 'l', 'r'])

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>Spick</Text>
          <Text color="subtle">stop picking, just start</Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>This session</Text>
          <Box flexDirection="column" paddingLeft={2}>
            {sessionTable.map((line, i) =>
              i === 0 ? <Text color="subtle">{line}</Text>
              : i === sessionTable.length - 1 ? <Text>{line}<Text color="subtle">{'     list price, not a bill'}</Text></Text>
              : <Text>{line}</Text>)}
          </Box>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" justifyContent="space-between" width={quotaWidth}>
            <Text bold>Quota</Text>
            <Text color="subtle">{staleness}</Text>
          </Box>
          <Box flexDirection="column" paddingLeft={2}>
            {quotaCells.map(r => r.cells.length === 0
              ? <Text>{r.name + '    '}<Text color="subtle">unknown</Text></Text>
              : <Text>{r.name}{r.cells.flatMap(c => [c.lead, c.isTight ? <Text color="warning">{c.meter}</Text> : c.meter])}</Text>)}
          </Box>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Recent turns</Text>
          <Box flexDirection="column" paddingLeft={2}>
            {recent.length === 0 ? <Text color="subtle">no turns yet</Text> : null}
            {recentTable.map((line, i) => {
              const note = recent[i]?.note
              if (!note) return <Text>{line}</Text>
              return <Text>{`${line}   `}{noteParts(note).map(p => (p.style === 'warning' || p.style === 'error' ? <Text color={p.style}>{p.text}</Text> : p.text))}</Text>
            })}
          </Box>
        </Box>

        <Box flexDirection="row" gap={2} marginTop={1}>
          <Button key="hide" label={isHidden ? 'Show band' : 'Hide band'} onPress={() => { void update($, hidden, v => !v) }} />
          <Button key="refresh" label="Refresh quota" onPress={() => { void refreshQuota($, true).catch(() => undefined) }} />
        </Box>
      </Box>
    )
  })
}
