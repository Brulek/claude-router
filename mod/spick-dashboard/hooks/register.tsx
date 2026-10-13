import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { LaneTotals, Note, Quota, QuotaWindows, TurnRecord } from '../types'
import { HINT, bandSegments, estimateCost, fmtAge, fmtCost, fmtDuration, isSourcePath, modelName, padRight, parseCli, quotaBar, table } from './format'
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
const PANE = 'spick'

// Helpers that take $ are top-level function declarations: the validator
// follows $ only into functions declared at the top of this file.
async function refreshQuota($: EngineInterface, force = false): Promise<Quota> {
  const now = await $.clock.now()
  const q = await read($, quota)
  if (!force && q && now - q.readAt < QUOTA_TTL_MS) return q
  const fresh: Quota = await readQuota({ home: () => $.env.get('HOME'), read: path => $.fs.read(path), list: path => $.fs.list(path) }, now)
  await update($, quota, () => fresh)
  return fresh
}

async function setCurrent($: EngineInterface, patch: Partial<TurnRecord>): Promise<void> {
  await update($, current, c => (c ? { ...c, ...patch } : c))
}

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

/** The colored part of a note: the file name of a breach, the whole cause otherwise. */
function splitNote(note: Note): [lead: string, cause: string] {
  return note.kind === 'error' && note.text.startsWith('edited ') ? ['edited ', note.text.slice(7)] : ['', note.text]
}

// Every hook here only observes: its own work sits in try/catch so a failure
// still ends in next(e), and next's own result is never swallowed.
export const register: Register = on => {
  /** agentId -> lane name, for attributing subagent turn.complete usage */
  const laneOfAgent = new Map<string, string>()
  /** lane the band shows while a CLI call or an Agent tool call is in flight */
  let activeLane: { lane: string; model: string; effort?: string } | null = null
  let mainModel = ''
  let mainEffort: string | undefined

  const mainLane = (): Partial<TurnRecord> => ({ lane: 'you', model: modelName(mainModel), effort: mainEffort })

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'spick', description: 'Spick dashboard: lanes, quota, recent turns', argumentHint: '[show|hide|quota]' })
      void refreshQuota($).catch(() => undefined)
    } catch {}
    return next(e)
  })

  // Tell the model the band is showing so it omits the label line; a hidden band shows nothing, so the label stays.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    try {
      if (await read($, hidden)) return r
      return { sections: [...r.sections, { id: `${P}:band`, scope: 'session' as const, text: 'The Spick status band is showing above the prompt. Do not print the [Model: ... | Effort: ...] label line at the end of replies.' }] }
    } catch {
      return r
    }
  })

  on('turn.start', async ($, e, next) => {
    try {
      const startedAt = await $.clock.now()
      activeLane = null
      await update($, current, () => ({ turnId: e.turnId, startedAt, lane: 'you', model: modelName(mainModel), effort: mainEffort, agents: 0 }))
    } catch {}
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    try {
      if (!e.agentId) {
        mainModel = e.model
        mainEffort = typeof e.effort === 'string' ? e.effort : undefined
        if (!activeLane) await setCurrent($, { lane: 'you', model: modelName(e.model), effort: mainEffort })
      }
    } catch {}
    return yield* next(e)
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    try {
      const lane = e.subagent_type ?? 'agent'
      const model = e.model ? modelName(e.model) : ''
      activeLane = { lane, model, effort: e.effort }
      await update($, current, c => (c ? { ...c, lane, model, effort: e.effort, agents: c.agents + 1 } : c))
    } catch {}
    // finally: an interrupted call must not leave the subagent's lane on the band
    try {
      return await next(e)
    } finally {
      try {
        if (!e.run_in_background) {
          activeLane = null
          await setCurrent($, mainLane())
        }
      } catch {}
    }
  }).catch(passThrough)

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    try {
      if (r.agentId) {
        laneOfAgent.set(r.agentId, e.subagentType)
        if (activeLane && activeLane.lane === e.subagentType) {
          activeLane.model = modelName(r.model)
          await setCurrent($, { model: activeLane.model })
        }
      }
    } catch {}
    return r
  }).catch(passThrough)

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId) return next(e)
    let before: typeof activeLane = null
    let isCli = false
    try {
      const cli = parseCli(e.command)
      if (cli) {
        isCli = true
        before = activeLane
        activeLane = { lane: cli.lane, model: cli.model ?? '', effort: cli.effort }
        await update($, current, c => (c ? { ...c, lane: cli.lane, model: cli.model ?? '', effort: cli.effort, note: cli.isReview ? { kind: 'warning' as const, text: 'review: codex' } : c.note } : c))
      }
    } catch {}
    try {
      return await next(e)
    } finally {
      if (isCli) {
        try {
          activeLane = before
          await setCurrent($, before ? { lane: before.lane, model: before.model, effort: before.effort } : mainLane())
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
      const lane = e.agentId ? (laneOfAgent.get(e.agentId) ?? 'agent') : 'you'
      const usage = e.usage
      if (usage) {
        const cost = estimateCost(usage.model, usage)
        await update($, totals, t => {
          const cur: LaneTotals = t[lane] ?? { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: null }
          return { ...t, [lane]: {
            turns: cur.turns + 1,
            inputTokens: cur.inputTokens + usage.input_tokens,
            outputTokens: cur.outputTokens + usage.output_tokens,
            cacheReadTokens: cur.cacheReadTokens + usage.cache_read_input_tokens,
            costUsd: cost === null ? cur.costUsd : (cur.costUsd ?? 0) + cost,
          } }
        })
      }
      if (e.agentId) {
        laneOfAgent.delete(e.agentId)
      } else {
        const endedAt = await $.clock.now()
        const c = await read($, current)
        if (c) {
          const done: TurnRecord = { ...c, endedAt, costUsd: usage ? estimateCost(usage.model, usage) : null }
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

  // The band: one line, who is working now. Slot order never changes; the hint
  // or an attention cause sits alone on the right.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hidden))) return next(e)
    const c = await read($, current)
    const l = await read($, last)
    const view: BandView | null = c
      ? { lane: c.lane, model: c.model, effort: c.effort, agents: c.agents, isIdle: false, note: c.note }
      : l
        ? { lane: l.lane, model: l.model, effort: l.effort, agents: 0, isIdle: true, durationMs: (l.endedAt ?? l.startedAt) - l.startedAt }
        : null
    if (!view) return next(e)
    // a breach or review note already on the turn wins over quota; quota wins over the hint
    if (!view.note && !view.isIdle) {
      const q = await read($, quota)
      const windows: [string, number | undefined][] = [['claude 5h', q?.claude?.fiveHour], ['claude 7d', q?.claude?.sevenDay], ['codex 7d', q?.codex?.sevenDay]]
      for (const [name, pct] of windows) {
        if (pct !== undefined && pct >= 80) { view.note = { kind: 'warning', text: `${name} ${Math.round(pct)}%` }; break }
      }
    }
    const segs = bandSegments(view, e.props.bodyColumns)
    const { Box, Text } = $.ui.resolve(e)
    const right = segs[segs.length - 1]!
    const isRight = right.text === HINT || right.style === 'warning' || right.style === 'error'
    const paint = (s: Seg) => {
      switch (s.style) {
        case 'brand': return <Text bold color="claude" wrap="truncate-end">{s.text}</Text>
        case 'lane': return <Text bold wrap="truncate-end">{s.text}</Text>
        case 'dim': return <Text color="subtle" wrap="truncate-end">{s.text}</Text>
        case 'plain': return <Text wrap="truncate-end">{s.text}</Text>
        default: {
          const [lead, cause] = splitNote({ kind: s.style, text: s.text })
          return <Text wrap="truncate-end">{lead}<Text color={s.style}>{cause}</Text></Text>
        }
      }
    }
    return (
      <Box flexDirection="row" justifyContent="space-between" gap={2} width="100%">
        <Box flexDirection="row">{(isRight ? segs.slice(0, -1) : segs).map(paint)}</Box>
        {isRight ? <Box flexDirection="row">{paint(right)}</Box> : null}
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
    const rows = e.viewport?.rows ?? 30

    const lanes = Object.entries(t).sort((a, b) => b[1].turns - a[1].turns)
    const totalCost = lanes.reduce<number | null>((acc, [, v]) => (v.costUsd === null ? acc : (acc ?? 0) + v.costUsd), null)
    const sessionTable = table([
      ['lane', 'turns', 'est. cost'],
      ...lanes.map(([lane, v]) => [lane, String(v.turns), fmtCost(v.costUsd)]),
      ['total', String(lanes.reduce((n, [, v]) => n + v.turns, 0)), fmtCost(totalCost)],
    ], ['l', 'r', 'r'])

    // name column 8 wide; `unknown` starts where the bars do
    const quotaRow = (name: string, w: QuotaWindows | null | undefined) => {
      const cells: [string, number][] = []
      if (w?.fiveHour !== undefined) cells.push(['5h', w.fiveHour])
      if (w?.sevenDay !== undefined) cells.push(['7d', w.sevenDay])
      if (cells.length === 0) return <Text>{padRight(name, 8) + '    '}<Text color="subtle">unknown</Text></Text>
      return (
        <Text>
          {padRight(name, 8)}
          {cells.flatMap(([label, pct], i) => {
            const meter = `${quotaBar(pct)} ${String(Math.round(pct)).padStart(3)}%`
            return [`${i > 0 ? '     ' : ''}${label}  `, pct >= 80 ? <Text color="warning">{meter}</Text> : meter]
          })}
        </Text>
      )
    }

    const recent = list.slice(0, Math.max(3, rows - 14))
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
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold>Quota</Text>
            <Text color="subtle">{q ? `refreshed ${fmtAge(now - q.readAt)}` : 'not read yet'}</Text>
          </Box>
          <Box flexDirection="column" paddingLeft={2}>
            {quotaRow('claude', q?.claude)}
            {quotaRow('codex', q?.codex)}
            {quotaRow('grok', null)}
            {quotaRow('gemini', null)}
          </Box>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Recent turns</Text>
          <Box flexDirection="column" paddingLeft={2}>
            {recent.length === 0 ? <Text color="subtle">no turns yet</Text> : null}
            {recentTable.map((line, i) => {
              const note = recent[i]?.note
              if (!note) return <Text>{line}</Text>
              const [lead, cause] = splitNote(note)
              return <Text>{`${line}   ${lead}`}<Text color={note.kind}>{cause}</Text></Text>
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
