import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { LaneTotals, Quota, TurnRecord } from '../types'
import { estimateCost, isSourcePath, modelName, parseCli } from './format'
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

  // Tell the model the band is showing so it omits the label line.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    try {
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
    const ran = await next(e)
    try {
      if (!e.run_in_background) {
        activeLane = null
        await setCurrent($, mainLane())
      }
    } catch {}
    return ran
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
    const ran = await next(e)
    if (isCli) {
      try {
        activeLane = before
        await setCurrent($, before ? { lane: before.lane, model: before.model, effort: before.effort } : mainLane())
      } catch {}
    }
    return ran
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

  // ui.render hooks are added in Task 5.
}
