import { test, expect, mock } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { LaneTotals, TurnRecord } from '../types'

const USAGE = { model: 'claude-sonnet-5-5', input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type Snapshot = { current?: TurnRecord | null; last?: TurnRecord | null; turns?: TurnRecord[]; totals?: Record<string, LaneTotals> }

/**
 * The test's `$` has no `state` noun and the test's own hooks may not call
 * $.state.get (the host only allows calls a hooks module's scan lists), so an
 * inline probe plugin reads the mod's keys on `/probe` and answers them as
 * JSON, in a dispatch of its own after the writes landed.
 */
const probePlugin: Plugin = {
  name: 'spick-probe',
  register(on) {
    on('command.run', { command: 'probe' }, async $ => {
      const snap = {
        current: (await $.state.get({ plugin: 'spick-dashboard', key: 'current' })).value,
        last: (await $.state.get({ plugin: 'spick-dashboard', key: 'last' })).value,
        turns: (await $.state.get({ plugin: 'spick-dashboard', key: 'turns' })).value,
        totals: (await $.state.get({ plugin: 'spick-dashboard', key: 'totals' })).value,
      }
      return { text: JSON.stringify(snap) }
    })
  },
}

async function probe($: Engine): Promise<Snapshot> {
  const r = await $.command.run({ command: 'probe', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  return JSON.parse(r.text ?? '{}') as Snapshot
}

test('a main-session turn closes into last and turns, lane you', { plugins: [probePlugin] }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))

  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect((await probe($)).current).toMatchObject({ turnId: 't1', lane: 'you', startedAt: 1000, agents: 0 })

  await clock.advance(2500)
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 2500, isAborted: false, reason: 'answer', usage: USAGE })

  const s = await probe($)
  expect(s.last).toMatchObject({ turnId: 't1', lane: 'you', startedAt: 1000, endedAt: 3500, agents: 0, costUsd: 3 })
  expect(s.turns).toHaveLength(1)
  expect(s.turns?.[0]).toEqual(s.last)
  expect(s.current).toBeNull()
  expect(s.totals?.you).toEqual({ turns: 1, inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, costUsd: 3 })
})

test('a subagent turn.complete adds to its lane totals and leaves last alone', { plugins: [probePlugin] }, async ($, on) => {
  mock.clock(on)
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))

  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'p', description: 'd', subagentType: 'coder', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false })
  await $.turn.complete({ turnId: 't2', agentId: 'a1', answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage: { ...USAGE, model: 'claude-haiku-5-5' } })

  const s = await probe($)
  expect(s.totals?.coder).toMatchObject({ turns: 1, inputTokens: 1_000_000, outputTokens: 100_000 })
  expect(s.totals?.you).toBeUndefined()
  expect(s.last).toBeUndefined()
})
