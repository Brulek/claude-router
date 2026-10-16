import { test, expect, mock } from 'claude-code/testing'
import type { Engine, Plugin, TestBody } from 'claude-code/testing'
import type { LaneTotals, TurnRecord } from '../types'
import { SCRIPT, fakeSetLane } from './fakelane'

const USAGE = { model: 'claude-sonnet-5-5', input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type Snapshot = { current?: TurnRecord | null; last?: TurnRecord | null; turns?: TurnRecord[]; totals?: Record<string, LaneTotals>; quota?: { readAt: number } | null }

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
        quota: (await $.state.get({ plugin: 'spick-dashboard', key: 'quota' })).value,
      }
      return { text: JSON.stringify(snap) }
    })
  },
}

async function probe($: Engine): Promise<Snapshot> {
  const r = await $.command.run({ command: 'probe', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  return JSON.parse(r.text ?? '{}') as Snapshot
}

test('a main-session turn closes into last and turns, lane main session', { plugins: [probePlugin] }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))

  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect((await probe($)).current).toMatchObject({ turnId: 't1', lane: 'main session', startedAt: 1000, agents: 0 })

  await clock.advance(2500)
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 2500, isAborted: false, reason: 'answer', usage: USAGE })

  const s = await probe($)
  expect(s.last).toMatchObject({ turnId: 't1', lane: 'main session', startedAt: 1000, endedAt: 3500, agents: 0, costUsd: 3 })
  expect(s.turns).toHaveLength(1)
  expect(s.turns?.[0]).toEqual(s.last)
  expect(s.current).toBeNull()
  expect(s.totals?.['main session']).toEqual({ turns: 1, inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 3 })
})

test('a subagent turn.complete adds to its lane totals and leaves last alone', { plugins: [probePlugin] }, async ($, on) => {
  mock.clock(on)
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))

  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'p', description: 'd', subagentType: 'coder', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false })
  await $.turn.complete({ turnId: 't2', agentId: 'a1', answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage: { ...USAGE, model: 'claude-haiku-5-5' } })

  const s = await probe($)
  expect(s.totals?.coder).toMatchObject({ turns: 1, inputTokens: 1_000_000, outputTokens: 100_000 })
  expect(s.totals?.['main session']).toBeUndefined()
  expect(s.last).toBeUndefined()
})

const DONE = { answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' as const, usage: USAGE }
// the kit's types carry no timers; the runner has them
const timers = globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }
const tick = () => new Promise<void>(r => timers.setTimeout(r, 1))

/** A tool.call answer that holds each call until the test releases it by tool_use_id. */
function gatedTools(on: Parameters<TestBody>[1]) {
  const gates = new Map<string, () => void>()
  on('tool.call', async ($, e) => {
    await new Promise<void>(res => gates.set(e.tool_use_id, res))
    return { result: {} as never }
  })
  return {
    async held(id: string) { while (!gates.has(id)) await tick() },
    release(id: string) { gates.get(id)?.() },
  }
}

const agentCall = (id: string, subagent_type?: string) =>
  ({ tool: 'Agent' as const, tool_use_id: id, prompt: 'p', description: 'd', run_in_background: false, ...(subagent_type ? { subagent_type } : {}) })

test('a turn that delegated to a coder Agent call closes as lane coder', { plugins: [probePlugin] }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('tool.call', async () => ({ result: {} as never }))

  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call({ ...agentCall('tu1', 'coder'), model: 'sonnet', effort: 'medium' })
  // the call is over, so the band is back on the main session
  expect((await probe($)).current).toMatchObject({ lane: 'main session' })
  await $.turn.complete({ turnId: 't1', ...DONE })

  const s = await probe($)
  expect(s.last).toMatchObject({ lane: 'coder', model: 'Sonnet 5.5', effort: 'medium', agents: 1 })
  expect(s.turns?.[0]?.lane).toBe('coder')
  // the main loop's own usage still counts under the main session
  expect(s.totals?.['main session']?.turns).toBe(1)
})

test('an agy -p Bash call counts a Gemini turn and the turn closes as lane Gemini', { plugins: [probePlugin] }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('tool.call', async () => ({ result: {} as never }))

  await $.turn.start({ text: 'search', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'cd /tmp\nagy -p "look it up" --model gemini-3.8-flash --effort low' })
  await $.turn.complete({ turnId: 't1', ...DONE })

  const s = await probe($)
  expect(s.totals?.Gemini).toEqual({ turns: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null })
  expect(s.last).toMatchObject({ lane: 'Gemini', model: 'gemini-3.8-flash', effort: 'low' })
})

test('two Agent calls in flight show the later one; the earlier finishing does not drop to the main session', { plugins: [probePlugin] }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  const tools = gatedTools(on)

  await $.turn.start({ text: 'go', turnId: 't1' })
  const coder = $.tool.call(agentCall('c1', 'coder'))
  await tools.held('c1')
  const planner = $.tool.call(agentCall('p1', 'planner'))
  await tools.held('p1')
  expect((await probe($)).current).toMatchObject({ lane: 'planner', agents: 2, agentIndex: 2 })

  tools.release('c1')
  await coder
  expect((await probe($)).current).toMatchObject({ lane: 'planner', agents: 2, agentIndex: 2 })

  tools.release('p1')
  await planner
  expect((await probe($)).current?.lane).toBe('main session')
})

test('the later call finishing first brings the earlier one back, with its own ordinal', { plugins: [probePlugin] }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  const tools = gatedTools(on)

  await $.turn.start({ text: 'go', turnId: 't1' })
  const coder = $.tool.call(agentCall('c1', 'coder'))
  await tools.held('c1')
  const search = $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'agy -p "x"' })
  await tools.held('b1')
  expect((await probe($)).current).toMatchObject({ lane: 'Gemini' })

  tools.release('b1')
  await search
  expect((await probe($)).current).toMatchObject({ lane: 'coder', agentIndex: 1 })
  tools.release('c1')
  await coder
})

const bgCall = (id: string, subagent_type: string) => ({ ...agentCall(id, subagent_type), run_in_background: true })
const bgSpawn = (id: string) =>
  ({ tool_use_id: id, prompt: 'p', description: 'd', subagentType: 'coder', provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'claude-opus-5-5', background: true, fork: false })

test('a background agent still running after the main turn completes keeps the band on its lane, not idle', { plugins: [probePlugin] }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('tool.call', async () => ({ result: {} as never }))

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ ...bgCall('bg1', 'coder'), model: 'sonnet', effort: 'medium' })
  await $.agent.spawn(bgSpawn('bg1'))
  await clock.advance(2000)
  await $.turn.complete({ turnId: 't1', ...DONE })

  // the main turn is recorded as before, but the band is not idle: current stays on the subagent's lane
  let s = await probe($)
  expect(s.last).toMatchObject({ turnId: 't1', lane: 'coder', endedAt: 3000 })
  expect(s.current).toMatchObject({ turnId: 't1', lane: 'coder', model: 'Sonnet 5.5', startedAt: 1000, agents: 1 })

  // the subagent's own turn.complete clears it: the band returns to idle
  await clock.advance(5000)
  await $.turn.complete({ turnId: 'sub1', agentId: 'a1', ...DONE, usage: { ...USAGE, model: 'claude-sonnet-5-5' } })
  s = await probe($)
  expect(s.current).toBeNull()
  expect(s.last).toMatchObject({ turnId: 't1' })
})

test('a background agent survives a second main turn and the band stays on it until it finishes', { plugins: [probePlugin] }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('tool.call', async () => ({ result: {} as never }))

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(bgCall('bg1', 'coder'))
  await $.agent.spawn(bgSpawn('bg1'))
  await $.turn.complete({ turnId: 't1', ...DONE })

  await $.turn.start({ text: 'and another thing', turnId: 't2' })
  await $.turn.complete({ turnId: 't2', ...DONE })
  expect((await probe($)).current).toMatchObject({ turnId: 't2', lane: 'coder' })

  await $.turn.complete({ turnId: 'sub1', agentId: 'a1', ...DONE })
  expect((await probe($)).current).toBeNull()
})

/** an Agent call as the model usually writes it: run_in_background left out */
const defaultCall = (id: string, subagent_type: string) => {
  const { run_in_background: _, ...call } = agentCall(id, subagent_type)
  return call
}

test('an Agent call that leaves run_in_background out runs in the background (the default): the band stays on its lane', { plugins: [probePlugin] }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('agent.spawn', async () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  const tools = gatedTools(on)

  // the engine spawns while the Agent call runs, then the call returns at once ("launched")
  await $.turn.start({ text: 'go', turnId: 't1' })
  const call = $.tool.call(defaultCall('p1', 'planner'))
  await tools.held('p1')
  await $.agent.spawn({ ...bgSpawn('p1'), subagentType: 'planner' })
  tools.release('p1')
  await call
  expect((await probe($)).current).toMatchObject({ lane: 'planner', model: 'Opus 5.5' })
  await $.turn.complete({ turnId: 't1', ...DONE })
  expect((await probe($)).current).toMatchObject({ turnId: 't1', lane: 'planner' })

  await $.turn.complete({ turnId: 'sub1', agentId: 'a1', ...DONE })
  expect((await probe($)).current).toBeNull()
})

test('a foreground Agent call (the spawn says not background) leaves the band when it returns', { plugins: [probePlugin] }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  const tools = gatedTools(on)

  await $.turn.start({ text: 'go', turnId: 't1' })
  const call = $.tool.call(defaultCall('f1', 'coder'))
  await tools.held('f1')
  await $.agent.spawn({ ...bgSpawn('f1'), background: false })
  expect((await probe($)).current).toMatchObject({ lane: 'coder' })
  tools.release('f1')
  await call
  expect((await probe($)).current).toMatchObject({ lane: 'main session' })
})

test('agent.spawn names the lane of an Agent call that gave no subagent_type', { plugins: [probePlugin] }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  const tools = gatedTools(on)

  await $.turn.start({ text: 'go', turnId: 't1' })
  const call = $.tool.call(agentCall('g1'))
  await tools.held('g1')
  expect((await probe($)).current?.lane).toBe('agent')
  await $.agent.spawn({ tool_use_id: 'g1', prompt: 'p', description: 'd', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false })
  expect((await probe($)).current).toMatchObject({ lane: 'general-purpose', model: 'Sonnet 5.5' })

  tools.release('g1')
  await call
  await $.turn.complete({ turnId: 't1', ...DONE })
  expect((await probe($)).last?.lane).toBe('general-purpose')
})

test('turn.start refreshes the quota', { plugins: [probePlugin] }, async ($, on) => {
  mock.clock(on, { now: 5000 })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  await $.turn.start({ text: 'hi', turnId: 't1' })
  let q: Snapshot['quota']
  for (let i = 0; i < 50 && !q; i++) { q = (await probe($)).quota; if (!q) await tick() }
  expect(q).toMatchObject({ readAt: 5000 })
})

test('tool calls tick the elapsed time, at most one write per second', { plugins: [probePlugin] }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('tool.call', async () => ({ result: {} as never }))
  const read = { tool: 'Read' as const, file_path: '/repo/a.py' }

  await $.turn.start({ text: 'go', turnId: 't1' })
  expect((await probe($)).current?.nowMs).toBe(1000)
  await clock.advance(1500)
  await $.tool.call({ ...read, tool_use_id: 'r1' })
  expect((await probe($)).current?.nowMs).toBe(2500)
  await clock.advance(400)
  await $.tool.call({ ...read, tool_use_id: 'r2' })
  expect((await probe($)).current?.nowMs).toBe(2500)
  await clock.advance(700)
  await $.tool.call({ ...read, tool_use_id: 'r3' })
  expect((await probe($)).current?.nowMs).toBe(3600)
})

test('turn.step chunks tick the elapsed time', { plugins: [probePlugin] }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  const RESULT = { turnId: 't1', index: 0, answer: 'hi there', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  on('turn.step', async function* () {
    yield { kind: 'text' as const, index: 0, text: 'hi' }
    yield { kind: 'text' as const, index: 0, text: ' there' }
    return RESULT
  })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(2000)
  const chunks: unknown[] = []
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-fable-5-1', effort: 'high', messageCount: 1 })
  // read by hand so the generator's own return value is caught
  let r = await step.next()
  while (!r.done) { chunks.push(r.value); r = await step.next() }
  // both chunks pass up in order and unchanged, the engine's result comes back as returned, and the stream stamped the turn
  expect(chunks).toEqual([{ kind: 'text', index: 0, text: 'hi' }, { kind: 'text', index: 0, text: ' there' }])
  expect(r.value).toEqual(RESULT)
  expect((await probe($)).current).toMatchObject({ nowMs: 3000, model: 'Fable 5.1', effort: 'high' })
})

const COMPOSE = { model: 'claude-haiku-5-5', promptModel: 'claude-haiku-5-5', tools: [], outputStyle: null, traits: [] }

test('the label-line section is added on terminal and desktop only', async ($, on) => {
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', scope: 'shared' as const, text: 'hi' }] }))
  const ids = async (surfaces: ('terminal' | 'desktop' | 'mobile' | 'vscode')[]) =>
    (await $.prompt.compose({ ...COMPOSE, surfaces })).sections.map(s => s.id)
  expect(await ids(['terminal'])).toEqual(['intro', 'spick-dashboard:band'])
  expect(await ids(['desktop'])).toEqual(['intro', 'spick-dashboard:band'])
  // claude -p / the SDK draw nothing; vscode draws no AbovePrompt band
  expect(await ids([])).toEqual(['intro'])
  expect(await ids(['vscode'])).toEqual(['intro'])
})

test('the label-line section is left out while the band is hidden', async ($, on) => {
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', scope: 'shared' as const, text: 'hi' }] }))
  await $.command.run({ command: 'spick', args: 'hide', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect((await $.prompt.compose({ ...COMPOSE, surfaces: ['terminal'] })).sections.map(s => s.id)).toEqual(['intro'])
})

// --- controls ---------------------------------------------------------------

const RUN = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }
const START = { cwd: '/repo', surface: 'terminal' as const, isInteractive: true }
const OFF_HEAD = 'Spick routing is off for this session: do the work yourself, do not dispatch coder/planner/deep by the Spick table, do not route to Gemini/Grok/Codex; '
/** the off sentence while the band shows (a terminal session) */
const OFF = OFF_HEAD + 'the status band shows who worked, so print no label line.'
/** the off sentence where no band is drawn */
const OFF_LABEL = OFF_HEAD + 'still end with the label line.'
const MODELS: Record<string, string> = { opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1' }

/**
 * The session world the controls read: a model the test's /model and model setting change,
 * a marker write recorded (never the real file), toasts recorded, a prompt that enters.
 */
function session(on: Parameters<TestBody>[1], model = 'claude-haiku-5-5', surfaces: ('terminal' | 'desktop')[] = ['terminal']) {
  const world = { model, isModelBroken: false, writes: [] as { path: string; text: string }[], toasts: [] as string[], submits: [] as unknown[] }
  on('session.model', async () => { if (world.isModelBroken) throw new Error('no model'); return { value: world.model } })
  on('session.surfaces', async () => ({ value: surfaces }))
  on('fs.write', async ($, e) => { world.writes.push({ path: e.path, text: e.text }); return { value: undefined } })
  on('ui.toast', async ($, e) => { world.toasts.push(e.text); return { value: undefined } })
  on('prompt.submit', async ($, e) => { world.submits.push(e); return { text: e.text, context: e.context } })
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  // a bare /model (picker) changes nothing by itself; a named one switches when the name is known
  on('command.run', { command: 'model' }, async ($, e) => { const m = MODELS[e.args.trim()]; if (m) world.model = m; return { text: 'model set' } })
  on('config.set', { key: 'model' }, async ($, e) => { const m = MODELS[String(e.value)]; if (m) world.model = m; return { value: e.value } })
  return world
}

const PROMPT = { text: 'fix the bug', wait: false, origin: { kind: 'composer' as const } }
const contextOf = async ($: Engine) => (await $.prompt.submit(PROMPT)).context ?? []
const isChecklist = (ctx: readonly string[]) => ctx.length === 1 && (ctx[0] ?? '').startsWith('[spick triage')
async function until(f: () => boolean) { for (let i = 0; i < 50 && !f(); i++) await tick() }

test('a Haiku session gets the checklist, one block per prompt; /spick off swaps in the off sentence', async ($, on) => {
  mock.clock(on, { now: 1000 })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  const world = session(on)
  await $.session.start(START)
  await until(() => world.writes.length > 0)
  expect(world.writes).toEqual([{ path: '/h/.claude/.spick-mod-active', text: new Date(1000).toISOString() }])

  expect(isChecklist(await contextOf($))).toBe(true)
  expect((await $.command.run({ command: 'spick', args: 'off', ...RUN })).text).toBe('spick: routing off')
  expect(await contextOf($)).toEqual([OFF])
  expect((await $.command.run({ command: 'spick', args: 'on', ...RUN })).text).toBe('spick: routing on · routes (Haiku 5.5 session)')
  expect(isChecklist(await contextOf($))).toBe(true)
})

test('the block is worded for the band: no label line while it shows, the label line where it does not', async ($, on) => {
  mock.clock(on)
  mock.store(on, { 'spick:routing': 'off' })
  session(on)
  await $.session.start(START)
  expect(await contextOf($)).toEqual([OFF])
  const checklistOn = async () => { await $.command.run({ command: 'spick', args: 'on', ...RUN }); return (await contextOf($))[0] ?? '' }
  expect(await checklistOn()).toContain('Reply starts with the deliverable; the status band shows who worked, so print no label line.')
  // hidden band: the label line is back
  await $.command.run({ command: 'spick', args: 'hide', ...RUN })
  expect(await checklistOn()).toContain('end with the label line: no delegate')
  await $.command.run({ command: 'spick', args: 'off', ...RUN })
  expect(await contextOf($)).toEqual([OFF_LABEL])
})

test('with no band surface (claude -p) the label-line wording stays', async ($, on) => {
  mock.clock(on)
  mock.store(on, { 'spick:routing': 'off', 'spick:review': 'off' })
  session(on, 'claude-haiku-5-5', [])
  await $.session.start(START)
  expect(await contextOf($)).toEqual([OFF_LABEL])
  await $.command.run({ command: 'spick', args: 'on', ...RUN })
  expect((await contextOf($))[0]?.split('\n').at(-1)).toBe('Codex review is off: skip the review step and write `Review: off` in the label line.')
})

test('on, on a model that is not Haiku, routes nothing; force routes there; auto is the old name of on', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  session(on, 'claude-fable-5-1')
  await $.session.start(START)
  expect(await contextOf($)).toEqual([OFF])
  expect((await $.command.run({ command: 'spick', args: 'on', ...RUN })).text).toBe('spick: routing on · routes nothing (Fable 5.1 is not Haiku)')
  expect((await $.command.run({ command: 'spick', args: 'force', ...RUN })).text).toBe('spick: routing force')
  expect(isChecklist(await contextOf($))).toBe(true)
  expect((await $.command.run({ command: 'spick', args: 'auto', ...RUN })).text).toBe('spick: routing on · routes nothing (Fable 5.1 is not Haiku)')
  expect(await contextOf($)).toEqual([OFF])
})

test('a routing value stored under the old names is read in its new name, and written under the new key only', async ($, on) => {
  mock.clock(on)
  const held = new Map<string, unknown>([['spick:routing', 'on']])
  const written: string[] = []
  on('store.get', async (_$, e) => ({ value: held.get(e.key) }))
  on('store.set', async (_$, e) => { written.push(e.key); held.set(e.key, e.value); return { value: undefined } })
  session(on, 'claude-fable-5-1')
  await $.session.start(START)
  // the old on routed on any model: it is force now, so a Fable session gets the checklist
  expect(isChecklist(await contextOf($))).toBe(true)
  expect((await $.command.run({ command: 'spick', args: 'off', ...RUN })).text).toBe('spick: routing off')
  expect(held.get('spick:routing2')).toBe('off')
  expect(held.get('spick:routing')).toBe('on')
  expect(written).not.toContain('spick:routing')
  // the new key wins from then on
  await $.session.start(START)
  expect(await contextOf($)).toEqual([OFF])
})

test('a prompt that already carries context and attachments keeps them, with one block appended', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const world = session(on)
  await $.session.start(START)
  const attachments = [{ type: 'image' as const, mediaType: 'image/png', filename: 'a.png' }]
  const r = await $.prompt.submit({ ...PROMPT, context: ['earlier block'], attachments })
  expect(r.context).toHaveLength(2)
  expect(r.context?.[0]).toBe('earlier block')
  expect(r.context?.[1]?.startsWith('[spick triage')).toBe(true)
  expect(world.submits).toHaveLength(1)
  expect(world.submits[0]).toMatchObject({ text: 'fix the bug', attachments })
})

test('a delivery (task notification) gets no block', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  session(on)
  await $.session.start(START)
  const r = await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' } })
  expect(r.context).toBeUndefined()
})

test('the session model unreadable: the block is still attached, from the cached session model', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const world = session(on)
  await $.session.start(START)
  world.isModelBroken = true
  // the cached Haiku keeps auto on: the checklist, not the off sentence
  expect(isChecklist(await contextOf($))).toBe(true)
  expect(world.submits).toHaveLength(1)
})

test('a /model that changed nothing, then /spick force: the next prompt raises no toast and routing stays on', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const world = session(on)
  await $.session.start(START)
  await $.command.run({ command: 'model', args: '', ...RUN })
  // force, so the later change of model below cannot take routing off on its own
  expect((await $.command.run({ command: 'spick', args: 'force', ...RUN })).text).toBe('spick: routing force')
  world.model = 'claude-opus-5-5' // a later change the pending comparison must not claim
  expect(isChecklist(await contextOf($))).toBe(true)
  expect(world.toasts).toEqual([])
})

test('session.start resolves when the store, the session model and fs.write all fail', async ($, on) => {
  mock.clock(on)
  mock.env(on, { HOME: '/h' })
  on('store.get', async () => { throw new Error('store down') })
  on('store.set', async () => { throw new Error('store down') })
  on('session.model', async () => { throw new Error('no model') })
  on('fs.write', async () => ({ deny: 'read-only' }))
  let started = 0
  on('session.start', async ($, e) => { started++; return { cwd: e.cwd } })
  expect(await $.session.start(START)).toEqual({ cwd: '/repo' })
  expect(started).toBe(1)
  // the switches still answer, kept in state for the session
  expect((await $.command.run({ command: 'spick', args: 'off', ...RUN })).text).toBe('spick: routing off')
})

test('review off persists to the store and the next session.start reads it back; the lanes switch is not in the store', async ($, on) => {
  mock.clock(on)
  const written: string[] = []
  const held = new Map<string, unknown>()
  on('store.get', async (_$, e) => ({ value: held.get(e.key) }))
  on('store.set', async (_$, e) => { written.push(e.key); held.set(e.key, e.value); return { value: undefined } })
  mock.env(on, { HOME: '/h' })
  const fake = fakeSetLane(on)
  session(on)
  await $.session.start(START)
  expect((await $.command.run({ command: 'spick', args: 'review off', ...RUN })).text).toBe('spick: review off')
  expect((await $.command.run({ command: 'spick', args: 'lane gemini off', ...RUN })).text).toBe('spick: gemini enabled: yes -> no. Backup: spick.json.bak.')
  expect(fake.rows.find(r => r.id === 'gemini')?.enabled).toBe(false)

  // a new session: the state starts from the store, so only what was written comes back
  await $.session.start(START)
  const block = (await contextOf($))[0] ?? ''
  expect(block).toContain('Codex review is off: skip the review step.')
  // the lane switch lives in spick.json (and reaches the checklist through the cache), not in the mod's store
  expect(written.length).toBeGreaterThan(0)
  expect(written).not.toContain('spick:lanes')
})

test('session.start reads the two stored choices and ignores an old spick:lanes', async ($, on) => {
  mock.clock(on)
  mock.store(on, { 'spick:routing': 'off', 'spick:review': 'auto', 'spick:lanes': JSON.stringify({ gemini: true, grok: false, codex: true }) })
  session(on)
  await $.session.start(START)
  expect(await contextOf($)).toEqual([OFF])
  await $.command.run({ command: 'spick', args: 'on', ...RUN })
  const block = (await contextOf($))[0] ?? ''
  expect(block).toContain('X data -> Grok')
  expect(block).not.toContain('lane is off')
})

test('/model by the user turns routing off for the session with one toast; /spick on restores', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const world = session(on)
  await $.session.start(START)
  expect(isChecklist(await contextOf($))).toBe(true)

  expect((await $.command.run({ command: 'model', args: 'opus', ...RUN })).text).toBe('model set')
  expect(world.toasts).toEqual(['spick: routing off (model selected manually) · /spick on or /spick force to resume'])
  expect(await contextOf($)).toEqual([OFF])
  // a second pick: still off, no second toast
  await $.command.run({ command: 'model', args: 'fable', ...RUN })
  expect(world.toasts).toHaveLength(1)

  await $.command.run({ command: 'model', args: 'haiku', ...RUN })
  expect((await $.command.run({ command: 'spick', args: 'on', ...RUN })).text).toBe('spick: routing on · routes (Haiku 5.5 session)')
  expect(isChecklist(await contextOf($))).toBe(true)
})

test('/model that changes nothing (same model, unknown name, cancelled picker) leaves routing on', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const world = session(on)
  await $.session.start(START)
  await $.command.run({ command: 'model', args: 'haiku', ...RUN })
  await $.command.run({ command: 'model', args: 'no-such-model', ...RUN })
  await $.command.run({ command: 'model', args: '', ...RUN })
  expect(world.toasts).toEqual([])
  expect(isChecklist(await contextOf($))).toBe(true)
  expect(world.toasts).toEqual([])
})

test('a bare /model whose picker is answered later is caught at the next prompt', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const world = session(on)
  await $.session.start(START)
  await $.command.run({ command: 'model', args: '', ...RUN })
  expect(world.toasts).toEqual([])
  world.model = 'claude-opus-5-5' // the picker answered after the command returned
  expect(await contextOf($)).toEqual([OFF])
  expect(world.toasts).toEqual(['spick: routing off (model selected manually) · /spick on or /spick force to resume'])
})

test('a /model issued by a plugin or the SDK leaves routing alone', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const world = session(on)
  await $.session.start(START)
  await $.command.run({ command: 'model', args: 'opus', origin: { kind: 'plugin', name: 'other' }, presentation: RUN.presentation })
  await $.command.run({ command: 'model', args: 'fable', origin: { kind: 'sdk' }, presentation: RUN.presentation })
  expect(world.toasts).toEqual([])
})

test('a model change through settings by the user turns routing off; the same value does not', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const world = session(on)
  await $.session.start(START)
  const set = (value: string, previous: string) => $.config.set({ key: 'model', value, previous, provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })
  await set('haiku', 'haiku')
  expect(world.toasts).toEqual([])
  expect(isChecklist(await contextOf($))).toBe(true)
  await set('opus', 'haiku')
  expect(world.toasts).toEqual(['spick: routing off (model selected manually) · /spick on or /spick force to resume'])
  expect(await contextOf($)).toEqual([OFF])
})

test('the marker is refreshed at most hourly from prompt.submit', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  const world = session(on)
  await $.session.start(START)
  await until(() => world.writes.length > 0)
  await contextOf($)
  await clock.advance(59 * 60_000)
  await contextOf($)
  await tick()
  expect(world.writes).toHaveLength(1)
  await clock.advance(60_000)
  await contextOf($)
  await until(() => world.writes.length > 1)
  expect(world.writes).toHaveLength(2)
  expect(world.writes[1]?.text).toBe(new Date(1000 + 60 * 60_000).toISOString())
})

test('/spick quota answers with the meters text', async ($, on) => {
  mock.clock(on, { now: 1000 })
  mock.env(on, { HOME: '/h' })
  const claudeJson = JSON.stringify({ cachedUsageUtilization: { utilization: { five_hour: { utilization: 5 }, seven_day: { utilization: 8 } } } })
  on('fs.read', async ($, e) => (e.path === '/h/.claude.json' ? { value: claudeJson } : { deny: 'missing' }))
  on('fs.list', async () => ({ value: [] }))
  expect((await $.command.run({ command: 'spick', args: 'quota', ...RUN })).text).toBe('spick: quota claude 7d ▰▱▱▱▱▱▱▱▱▱ 8%')
})

test('every /spick answer is one line starting with spick:', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  fakeSetLane(on)
  session(on)
  await $.session.start(START)
  const answer = async (args: string) => (await $.command.run({ command: 'spick', args, ...RUN })).text ?? ''
  expect(await answer('details')).toBe('spick: usage /spick [on|force|off|review on|off|gate on|off|guard on|off|lane <id> [<field> <value>]|hide|show|quota|spend]')
  expect(await answer('lane glm')).toBe('spick: unknown lane id glm')
  expect(await answer('hide')).toBe('spick: band hidden · /spick show restores it')
  expect(await answer('show')).toBe('spick: band shown')
  for (const args of ['on', 'force', 'off', 'auto', 'review on', 'review off', 'gate off', 'gate on', 'guard off', 'guard on', 'lane grok on', 'lane codex off', 'lane claude off', 'lane grok', 'lane openrouter notes Two words', 'lane grok tags', 'hide', 'show', 'quota', 'what']) {
    const text = await answer(args)
    expect(text.startsWith('spick: ')).toBe(true)
    expect(text).not.toContain('\n')
  }
})

test('/spick with no UI surface prints a one-paragraph status', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('session.model', async () => ({ value: 'claude-haiku-5-5' }))
  on('session.surfaces', async () => ({ value: [] }))
  on('fs.write', async () => ({ value: undefined }))
  on('fs.read', async () => ({ deny: 'missing' }))
  on('fs.list', async () => ({ value: [] }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  mock.env(on, { HOME: '/h' })
  fakeSetLane(on)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.command.run({ command: 'spick', args: 'lane codex off', ...RUN })
  const text = (await $.command.run({ command: 'spick', args: '', ...RUN })).text ?? ''
  expect(text).toBe('spick: routing on, routes (Haiku 5.5 session); review auto; gate on; guard on; lanes: Gemini on, Grok on, Codex off, openrouter on; band shown; quota unknown (no local data for claude or codex).')
  expect(text).not.toContain('\n')
})

test('the quota line from the cache file is the checklist\'s last line; with no cache the line is left out', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-13T15:34:00Z') })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  session(on)
  let cache: string | null = '{"written_at":"2026-10-13T15:30:00Z","providers":[{"provider":"codex","plan":"Pro Lite","sampled_at":"2026-10-13T15:29:00Z","windows":[{"name":"7d","used_pct":53,"resets_at":"2026-10-20T05:38:29Z","reset":false}]}]}'
  on('fs.read', async (_$, e) => (e.path === '/h/.claude/spick-quota.json' && cache !== null ? { value: cache } : { deny: 'missing' }))
  await $.session.start(START)
  const withLine = await contextOf($)
  expect(withLine.length).toBe(1)
  expect((withLine[0] ?? '').split('\n').at(-1)).toBe('Quota (cache 4m old): codex Pro Lite: 7d 53% (resets in 6d).')
  cache = null
  const without = await contextOf($)
  expect(isChecklist(without)).toBe(true)
  expect(without[0]).not.toContain('Quota')
})

test('registry lanes with facts and no windows reach the checklist with their facts; one with neither reads unknown', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-13T15:34:00Z') })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  session(on)
  const lane = (id: string, facts: string) => `{"provider":"${id}","plan":null,"sampled_at":"2026-10-13T15:29:50Z","windows":[],"facts":${facts}}`
  const cache = `{"written_at":"2026-10-13T15:30:00Z","providers":[${lane('deepseek', '["balance 12.40 CNY"]')},${lane('kimi', '["balance 3.00 CNY"]')},${lane('openrouter', '["used 3.20 of 10.00 USD"]')},${lane('proxy', '[]')}]}`
  on('fs.read', async (_$, e) => (e.path === '/h/.claude/spick-quota.json' ? { value: cache } : { deny: 'missing' }))
  await $.session.start(START)
  const last = ((await contextOf($))[0] ?? '').split('\n').at(-1) ?? ''
  expect(last).toBe('Quota (cache 4m old): deepseek: balance 12.40 CNY · kimi: balance 3.00 CNY · openrouter: used 3.20 of 10.00 USD · proxy: unknown (no data).')
  expect(last).not.toMatch(/: (·|\.$)/)
})

test('lanes in the cache switch line 2 to the capability wording and add the Lanes line; a lane switched off is simply gone from the cache', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-13T15:34:00Z') })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  fakeSetLane(on, [{ id: 'gemini', name: 'Gemini', enabled: true, tags: ['search'], data: 'public', notes: null, kind: 'cli-subscription' }, { id: 'glm', name: 'glm', enabled: true, tags: ['cheap'], data: 'text', notes: null, kind: 'api-key' }])
  session(on)
  const lane = (id: string, kind: string, tags: string, data: string) => `{"id":"${id}","kind":"${kind}","tags":["${tags}"],"data":"${data}"}`
  let cache = `{"written_at":"2026-10-13T15:30:00Z","providers":[{"provider":"glm","facts":["no meter (declared plan only)"]}],"lanes":[${lane('gemini', 'cli-subscription', 'search', 'public')},${lane('glm', 'api-key', 'cheap', 'text')}]}`
  on('fs.read', async (_$, e) => (e.path === '/h/.claude/spick-quota.json' ? { value: cache } : { deny: 'missing' }))
  await $.session.start(START)
  const lines = ((await contextOf($))[0] ?? '').split('\n')
  // item 2 is a block of seven lines (head, five bullets, tail); the registry swaps its lane bullet
  expect(lines.slice(2, 9).join('\n')).toContain('   - a task an outside lane is tagged for')
  expect(lines.slice(2, 9).join('\n')).not.toContain('Gemini (agy)')
  expect(lines.at(-2)).toBe('Lanes (user-declared; data = most that may be sent): gemini search data:public · glm cheap data:text · glm is a third-party service: sending content to it carries a data-leak risk.')
  expect(lines.at(-1)).toBe('Quota (cache 4m old): glm: no meter (declared plan only).')
  expect((await $.command.run({ command: 'spick', args: 'lane glm off', ...RUN })).text).toBe('spick: glm enabled: yes -> no. Backup: spick.json.bak.')
  // set_lane.py rebuilt the cache (quota.py --relane): glm is out of its lanes list
  cache = `{"written_at":"2026-10-13T15:30:00Z","providers":[{"provider":"glm","facts":["no meter (declared plan only)"]}],"lanes":[${lane('gemini', 'cli-subscription', 'search', 'public')}]}`
  const after = ((await contextOf($))[0] ?? '').split('\n')
  expect(after.at(-2)).toBe('Lanes (user-declared; data = most that may be sent): gemini search data:public')
  expect(after.join('\n')).not.toContain('lane is off')
})

// --- /spick lane through set_lane.py ------------------------------------------------------

async function laneWorld($: Engine, on: Parameters<TestBody>[1]) {
  mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  const fake = fakeSetLane(on)
  session(on)
  await $.session.start(START)
  const run = async (args: string) => (await $.command.run({ command: 'spick', args, ...RUN })).text ?? ''
  return { fake, run }
}

test('/spick lane <id> <field> <value> runs set_lane.py with an argv array, the value verbatim', async ($, on) => {
  const { fake, run } = await laneWorld($, on)
  expect(await run('lane openrouter tags gateway,cheap')).toBe('spick: openrouter tags: gateway -> gateway,cheap. Backup: spick.json.bak.')
  expect(fake.writes()).toEqual([['python3', SCRIPT, '--id', 'openrouter', '--field', 'tags', '--value', 'gateway,cheap']])
  // notes keep their case and inner spaces
  expect(await run('lane openrouter notes  Use for Chinese   Drafts ONLY ')).toBe('spick: openrouter notes: Pay per use -> Use for Chinese   Drafts ONLY. Backup: spick.json.bak.')
  expect(fake.writes().at(-1)).toEqual(['python3', SCRIPT, '--id', 'openrouter', '--field', 'notes', '--value', 'Use for Chinese   Drafts ONLY'])
  // a field the list does not carry
  expect(await run('lane openrouter model some/model-1')).toBe('spick: openrouter model: changed. Backup: spick.json.bak.')
})

test('/spick lane <id> on|off still works and now maps to the enabled field', async ($, on) => {
  const { fake, run } = await laneWorld($, on)
  expect(await run('lane codex off')).toBe('spick: codex enabled: yes -> no. Backup: spick.json.bak.')
  expect(fake.writes()).toEqual([['python3', SCRIPT, '--id', 'codex', '--field', 'enabled', '--value', 'no']])
  expect(await run('lane codex on')).toBe('spick: codex enabled: no -> yes. Backup: spick.json.bak.')
  expect(fake.writes().at(-1)).toEqual(['python3', SCRIPT, '--id', 'codex', '--field', 'enabled', '--value', 'yes'])
  expect(fake.rows.find(r => r.id === 'codex')?.enabled).toBe(true)
})

test('a refusal (non-zero exit) answers spick: plus the first stderr line, and writes nothing', async ($, on) => {
  const { fake, run } = await laneWorld($, on)
  expect(await run('lane nope tags a')).toBe('spick: set_lane: unknown lane id nope; to add a new lane use add_lane.py')
  expect(await run('lane grok notes sk-abcdefghijklmnopqrstuvwxyz')).toBe('spick: set_lane: the value looks like a secret; not written')
  expect(await run('lane grok bogus x')).toBe('spick: set_lane: unknown field bogus; fields: name, tags, data')
  expect(fake.rows.find(r => r.id === 'grok')).toMatchObject({ notes: null, tags: ['x-data'] })
})

test('/spick lane <id> shows the lane\'s whole record on one line', async ($, on) => {
  const { run } = await laneWorld($, on)
  expect(await run('lane openrouter')).toBe('spick: openrouter · enabled yes · name OpenRouter · tags gateway · data text · kind api-key · notes Pay per use')
  expect(await run('lane nope')).toBe('spick: unknown lane id nope')
})

test('the prompt path runs no process', async ($, on) => {
  const { fake } = await laneWorld($, on)
  fake.calls.length = 0
  await contextOf($)
  await $.prompt.submit(PROMPT)
  expect(fake.calls).toEqual([])
})

test('the Hint line comes from the prompt itself: a comparison gets it after item 2, a plain question does not', async ($, on) => {
  mock.clock(on, { now: 1000 })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  session(on)
  await $.session.start(START)
  const judged = ((await $.prompt.submit({ ...PROMPT, text: '把 spick 和对方的分流机制对比一下，看看有没有差距' })).context ?? [])[0] ?? ''
  const lines = judged.split('\n')
  const at = lines.findIndex(l => l.startsWith('   Hint (keywords in this prompt, not a verdict): judgement words (对比, 差距) -> start from Agent(deep); pick the effort by the table'))
  expect(at).toBeGreaterThan(2)
  expect((lines[at - 1] ?? '').startsWith('   A prompt that mixes kinds')).toBe(true)
  expect((lines[at + 1] ?? '').startsWith('3. Goal-shaped?')).toBe(true)
  // the other tests' prompt ("fix the bug") carries an edit word; a plain question carries none
  expect((await contextOf($))[0] ?? '').toContain('   Hint (keywords in this prompt, not a verdict): edit words (fix) -> Agent(coder) once nothing is left to decide.')
  const plain = ((await $.prompt.submit({ ...PROMPT, text: '现在几点了?' })).context ?? [])[0] ?? ''
  expect(plain.startsWith('[spick triage')).toBe(true)
  expect(plain).not.toContain('   Hint')
  // routing off: no checklist, so no hint
  await $.command.run({ command: 'spick', args: 'off', ...RUN })
  expect(((await $.prompt.submit({ ...PROMPT, text: '对比一下' })).context ?? [])[0]).toBe(OFF)
})

// --- the gate: a hinted verdict the main session kept is sent back once at stop time -------------------------------
const GATE_STOP = { stop_hook_active: false as const }
const LONG_REPLY = 'The two routers differ in five ways. '.repeat(14)
const VERDICT = '为什么这两个脚本的输出不一样'

test('a hinted verdict answered by the main session alone is blocked once at stop, with a toast; the next stop passes', async ($, on) => {
  mock.clock(on, { now: 1000 })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  const world = session(on)
  on('classic.Stop', async () => ({}))
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('tool.call', async () => ({ result: {} as never }))
  await $.session.start(START)
  const text = '把 spick 和对方的分流机制对比一下，看看有没有差距'
  await $.prompt.submit({ ...PROMPT, text })
  await $.turn.start({ text, turnId: 't1' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'wc -l a b' })
  const r = await $.classic.Stop({ ...GATE_STOP, last_assistant_message: LONG_REPLY })
  expect(r.block).toContain('spick gate: this prompt was hinted as a verdict (对比, 差距) and nothing was delegated this turn')
  expect(r.block).toContain('dispatch Agent(deep)')
  expect(r.block).toContain('`Kept:`')
  expect(world.toasts).toContain('spick: gate — verdict kept by the triage session; sent back once')
  // once per turn: the stop after a block (Claude Code marks it stop_hook_active) passes, and so would one without the mark
  expect((await $.classic.Stop({ stop_hook_active: true, last_assistant_message: LONG_REPLY })).block).toBeUndefined()
  expect((await $.classic.Stop({ ...GATE_STOP, last_assistant_message: LONG_REPLY })).block).toBeUndefined()
  await $.turn.complete({ turnId: 't1', ...DONE })
  expect(world.toasts.filter(t => t.startsWith('spick: gate')).length).toBe(1)
})

test('the gate stays quiet when something was delegated, on a short reply or a Kept: line, without a verdict hint, on a delivery, and when it or routing is off', async ($, on) => {
  mock.clock(on, { now: 1000 })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  const world = session(on)
  on('classic.Stop', async () => ({}))
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('tool.call', async () => ({ result: {} as never }))
  await $.session.start(START)
  const turn = async (id: string, text: string) => { await $.prompt.submit({ ...PROMPT, text }); await $.turn.start({ text, turnId: id }) }
  const stop = async (msg: string) => (await $.classic.Stop({ ...GATE_STOP, last_assistant_message: msg })).block
  // delegated to an Agent: no gate
  await turn('t1', VERDICT)
  await $.tool.call({ ...agentCall('a1', 'deep'), model: 'opus', effort: 'high' })
  expect(await stop(LONG_REPLY)).toBeUndefined()
  await $.turn.complete({ turnId: 't1', ...DONE })
  // delegated to an outside CLI: no gate
  await turn('t2', VERDICT)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'agy -p "why" --model gemini-3.8-flash --effort low' })
  expect(await stop(LONG_REPLY)).toBeUndefined()
  await $.turn.complete({ turnId: 't2', ...DONE })
  // a short reply with no tool call is a question back: no gate; a long one with no tool call is a verdict: gated
  await turn('t3', VERDICT)
  expect(await stop('你指的是哪两个脚本?')).toBeUndefined()
  expect(await stop(LONG_REPLY)).toContain('spick gate')
  await $.turn.complete({ turnId: 't3', ...DONE })
  // a Kept: line is the stated reason: no gate (the Chinese form too)
  await turn('t4', VERDICT)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b4', command: 'diff a b' })
  expect(await stop(LONG_REPLY + '\nKept: the deliverable is a diff, a plain lookup.')).toBeUndefined()
  expect(await stop(LONG_REPLY + '\n自留：交付物是一份 diff，纯查阅。')).toBeUndefined()
  await $.turn.complete({ turnId: 't4', ...DONE })
  // an edit-word prompt is coder's bucket, not the gate's business
  await turn('t5', 'fix the bug in a.py')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b5', command: 'cat a.py' })
  expect(await stop(LONG_REPLY)).toBeUndefined()
  await $.turn.complete({ turnId: 't5', ...DONE })
  // a delivery (no checklist) carries no hint, whatever its words
  await $.prompt.submit({ ...PROMPT, text: VERDICT, origin: { kind: 'task-notification' as const } })
  await $.turn.start({ text: VERDICT, turnId: 't6' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b6', command: 'cat a.py' })
  expect(await stop(LONG_REPLY)).toBeUndefined()
  await $.turn.complete({ turnId: 't6', ...DONE })
  // /spick gate off silences it; gate on restores; routing off silences it too
  expect((await $.command.run({ command: 'spick', args: 'gate off', ...RUN })).text).toBe('spick: gate off')
  await turn('t7', VERDICT)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b7', command: 'cat a.py' })
  expect(await stop(LONG_REPLY)).toBeUndefined()
  await $.turn.complete({ turnId: 't7', ...DONE })
  expect((await $.command.run({ command: 'spick', args: 'gate on', ...RUN })).text).toBe('spick: gate on')
  expect((await $.command.run({ command: 'spick', args: 'off', ...RUN })).text).toBe('spick: routing off')
  await turn('t8', VERDICT)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b8', command: 'cat a.py' })
  expect(await stop(LONG_REPLY)).toBeUndefined()
  await $.turn.complete({ turnId: 't8', ...DONE })
  expect(world.toasts.filter(t => t.startsWith('spick: gate')).length).toBe(1)
})

test('gate off persists to the store and comes back at the next session.start', async ($, on) => {
  mock.clock(on)
  const held = new Map<string, unknown>()
  on('store.get', async (_$, e) => ({ value: held.get(e.key) }))
  on('store.set', async (_$, e) => { held.set(e.key, e.value); return { value: undefined } })
  mock.env(on, { HOME: '/h' })
  session(on)
  on('classic.Stop', async () => ({}))
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('tool.call', async () => ({ result: {} as never }))
  await $.session.start(START)
  expect((await $.command.run({ command: 'spick', args: 'gate off', ...RUN })).text).toBe('spick: gate off')
  expect(held.get('spick:gate')).toBe('off')
  await $.session.start(START)
  await $.prompt.submit({ ...PROMPT, text: VERDICT })
  await $.turn.start({ text: VERDICT, turnId: 't1' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'diff a b' })
  expect((await $.classic.Stop({ ...GATE_STOP, last_assistant_message: LONG_REPLY })).block).toBeUndefined()
  await $.turn.complete({ turnId: 't1', ...DONE })
})

// --- the guard: an edit cap per turn for the main session, a check before the turn ends -----------------------------
const edit = (id: string, file_path: string, agentId?: string) =>
  ({ tool: 'Edit' as const, tool_use_id: id, file_path, old_string: 'a', new_string: 'b', ...(agentId ? { agentId } : {}) })
const write = (id: string, file_path: string) => ({ tool: 'Write' as const, tool_use_id: id, file_path, content: 'x' })
const notebook = (id: string, notebook_path: string) => ({ tool: 'NotebookEdit' as const, tool_use_id: id, notebook_path, new_source: 'x' })
const bash = (id: string, command: string, agentId?: string) => ({ tool: 'Bash' as const, tool_use_id: id, command, ...(agentId ? { agentId } : {}) })
const CHECKED = 'Done; the tests pass.'

/** a session for the guard's tests: the model given, every tool call answered, the edits that reached the tool recorded */
async function guardWorld($: Engine, on: Parameters<TestBody>[1], model = 'claude-haiku-5-5') {
  mock.clock(on, { now: 1000 })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  const world = session(on, model)
  const ran: string[] = []
  on('classic.Stop', async () => ({}))
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('tool.call', async ($, e) => {
    const p = (e as { file_path?: string; notebook_path?: string }).file_path ?? (e as { notebook_path?: string }).notebook_path
    if (p) ran.push(p)
    return { result: {} as never }
  })
  await $.session.start(START)
  const turn = async (id: string, text = 'tidy the module') => { await $.prompt.submit({ ...PROMPT, text }); await $.turn.start({ text, turnId: id }) }
  const stop = async (msg = CHECKED) => (await $.classic.Stop({ ...GATE_STOP, last_assistant_message: msg })).block
  const run = async (args: string) => (await $.command.run({ command: 'spick', args, ...RUN })).text
  return { world, ran, turn, stop, run }
}

test('the guard refuses the main session\'s fourth distinct source file in a turn, naming the three, with a toast and an edit cap note', { plugins: [probePlugin] }, async ($, on) => {
  const { world, ran, turn } = await guardWorld($, on)
  await turn('t1')
  for (const [i, f] of ['/repo/a.py', '/repo/b.ts', '/repo/c.go'].entries()) expect((await $.tool.call(edit(`e${i}`, f))).deny).toBeUndefined()
  const r = await $.tool.call(edit('e4', '/repo/d.rs'))
  expect(r.deny).toContain('spick guard')
  for (const f of ['/repo/a.py', '/repo/b.ts', '/repo/c.go']) expect(r.deny).toContain(f)
  expect(r.deny).toContain('Agent(coder)')
  // the refused edit never reached the tool; a Write and a NotebookEdit to a new file are refused alike
  expect(ran).toEqual(['/repo/a.py', '/repo/b.ts', '/repo/c.go'])
  expect((await $.tool.call(write('w5', '/repo/e.swift'))).deny).toContain('spick guard')
  expect((await $.tool.call(notebook('n6', '/repo/f.ipynb'))).deny).toContain('spick guard')
  expect(world.toasts.filter(t => t.startsWith('spick: guard — edit cap')).length).toBe(3)
  expect((await probe($)).current?.note).toEqual({ kind: 'error', text: 'edit cap' })
  // the cap is per turn: the next turn starts again
  await $.turn.complete({ turnId: 't1', ...DONE })
  await turn('t2')
  expect((await $.tool.call(edit('e7', '/repo/d.rs'))).deny).toBeUndefined()
})

test('the guard lets through a file already edited, a subagent\'s edits, and paths that are not source', async ($, on) => {
  const { ran, turn } = await guardWorld($, on)
  await turn('t1')
  for (const [i, f] of ['/repo/a.py', '/repo/b.py', '/repo/c.py'].entries()) await $.tool.call(edit(`e${i}`, f))
  // the same file a fourth, fifth time: still one of the three
  expect((await $.tool.call(edit('e4', '/repo/a.py'))).deny).toBeUndefined()
  expect((await $.tool.call(write('w5', '/repo/b.py'))).deny).toBeUndefined()
  // a subagent's edits never count against the main session's cap
  for (const f of ['/repo/d.py', '/repo/e.py', '/repo/f.py', '/repo/g.py']) expect((await $.tool.call(edit(`s-${f}`, f, 'a1'))).deny).toBeUndefined()
  // notes, data and .claude/ are not source
  for (const f of ['/repo/README.md', '/repo/data.json', '/repo/notes.txt', '/repo/.claude/settings.local.py']) expect((await $.tool.call(edit(`n-${f}`, f))).deny).toBeUndefined()
  expect(ran).toHaveLength(13)
})

test('the guard lets every edit through when it is off, when routing is off, and in a session that is not Haiku', async ($, on) => {
  const { world, turn, run } = await guardWorld($, on)
  const four = async (t: string) => {
    await turn(t)
    const out: (string | undefined)[] = []
    for (const f of ['a.py', 'b.py', 'c.py', 'd.py']) out.push((await $.tool.call(edit(`${t}-${f}`, `/repo/${f}`))).deny)
    await $.turn.complete({ turnId: t, ...DONE })
    return out.filter(Boolean).length
  }
  expect(await run('guard off')).toBe('spick: guard off')
  expect(await four('t1')).toBe(0)
  expect(await run('guard on')).toBe('spick: guard on')
  expect(await four('t2')).toBe(1)
  expect(await run('off')).toBe('spick: routing off')
  expect(await four('t3')).toBe(0)
  await run('on')
  // routing on in an Opus session routes nothing, so the guard stays out of the way
  world.model = 'claude-opus-5-5'
  expect(await four('t4')).toBe(0)
  // forced routing on Opus: the guard applies
  await run('force')
  expect(await four('t5')).toBe(1)
})

test('a turn that edited source and ran no check is sent back once at stop, with a toast; the next stop passes', async ($, on) => {
  const { world, turn, stop } = await guardWorld($, on)
  await turn('t1')
  await $.tool.call(edit('e1', '/repo/a.py'))
  const block = await stop()
  expect(block).toContain('spick guard: source files were edited this turn (/repo/a.py) and no check ran')
  expect(block).toContain('`Unchecked:`')
  expect(block).toContain('`/goal <check command>; stop after 10 attempts`')
  expect(world.toasts).toContain('spick: guard — source edited and no check ran; sent back once')
  expect((await $.classic.Stop({ stop_hook_active: true, last_assistant_message: CHECKED })).block).toBeUndefined()
  expect(await stop()).toBeUndefined()
  await $.turn.complete({ turnId: 't1', ...DONE })
  expect(world.toasts.filter(t => t.startsWith('spick: guard — source')).length).toBe(1)
})

test('the check before the turn ends passes after a check command, on an Unchecked: line, with no source edited, and when the guard or routing is off', async ($, on) => {
  const { turn, stop, run } = await guardWorld($, on)
  // a check ran in the main loop
  await turn('t1')
  await $.tool.call(edit('e1', '/repo/a.py'))
  await $.tool.call(bash('b1', 'cd skills/spick/scripts && python3 -m unittest -q'))
  expect(await stop()).toBeUndefined()
  await $.turn.complete({ turnId: 't1', ...DONE })
  // a check a subagent ran counts too
  await turn('t2')
  await $.tool.call(edit('e2', '/repo/a.py'))
  await $.tool.call(bash('b2', 'npm test', 'a1'))
  expect(await stop()).toBeUndefined()
  await $.turn.complete({ turnId: 't2', ...DONE })
  // an Unchecked: line says why there is none (the Chinese form too)
  await turn('t3')
  await $.tool.call(edit('e3', '/repo/a.py'))
  expect(await stop('Done.\nUnchecked: this repo has no tests.')).toBeUndefined()
  expect(await stop('改好了。\n未验证：本项目没有测试。')).toBeUndefined()
  await $.turn.complete({ turnId: 't3', ...DONE })
  // only notes edited, and a command that is not a check: nothing to check
  await turn('t4')
  await $.tool.call(edit('e4', '/repo/README.md'))
  await $.tool.call(bash('b4', 'ls -la'))
  expect(await stop()).toBeUndefined()
  await $.turn.complete({ turnId: 't4', ...DONE })
  // guard off, routing off: silent
  await run('guard off')
  await turn('t5')
  await $.tool.call(edit('e5', '/repo/a.py'))
  expect(await stop()).toBeUndefined()
  await $.turn.complete({ turnId: 't5', ...DONE })
  await run('guard on')
  await run('off')
  await turn('t6')
  await $.tool.call(edit('e6', '/repo/a.py'))
  expect(await stop()).toBeUndefined()
  await $.turn.complete({ turnId: 't6', ...DONE })
  // and a check from an earlier turn does not carry over
  await run('on')
  await turn('t7')
  await $.tool.call(edit('e7', '/repo/a.py'))
  expect(await stop()).toContain('spick guard')
})

test('a coder that edited source and ran no check still sends the turn back, though something was delegated', async ($, on) => {
  const { world, turn, stop } = await guardWorld($, on)
  await turn('t1', 'rename the helper in a.py')
  await $.tool.call({ ...agentCall('ag1', 'coder'), model: 'sonnet', effort: 'high' })
  await $.tool.call(edit('e1', '/repo/a.py', 'a1'))
  await $.tool.call(edit('e2', '/repo/b.py', 'a1'))
  const block = await stop()
  expect(block).toContain('spick guard: source files were edited this turn (/repo/a.py, /repo/b.py)')
  // the hint gate stayed out of it (something was delegated); the guard's check did not
  expect(world.toasts.filter(t => t.startsWith('spick: gate')).length).toBe(0)
  expect(world.toasts.filter(t => t.startsWith('spick: guard')).length).toBe(1)
})

test('the gate and the guard\'s check send a turn back once between them', async ($, on) => {
  const { world, turn, stop } = await guardWorld($, on)
  await turn('t1', VERDICT)
  await $.tool.call(edit('e1', '/repo/a.py'))
  expect(await stop(LONG_REPLY)).toContain('spick gate')
  // the second stop of the turn: neither sends it back again
  expect(await stop(LONG_REPLY)).toBeUndefined()
  expect(world.toasts.filter(t => t.startsWith('spick: guard')).length).toBe(0)
})

test('guard off persists to the store and comes back at the next session.start', async ($, on) => {
  mock.clock(on)
  const held = new Map<string, unknown>()
  on('store.get', async (_$, e) => ({ value: held.get(e.key) }))
  on('store.set', async (_$, e) => { held.set(e.key, e.value); return { value: undefined } })
  mock.env(on, { HOME: '/h' })
  session(on)
  on('classic.Stop', async () => ({}))
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('tool.call', async () => ({ result: {} as never }))
  await $.session.start(START)
  expect((await $.command.run({ command: 'spick', args: 'guard off', ...RUN })).text).toBe('spick: guard off')
  expect(held.get('spick:guard')).toBe('off')
  await $.session.start(START)
  await $.prompt.submit(PROMPT)
  await $.turn.start({ text: PROMPT.text, turnId: 't1' })
  for (const f of ['a.py', 'b.py', 'c.py', 'd.py']) expect((await $.tool.call(edit(f, `/repo/${f}`))).deny).toBeUndefined()
  expect((await $.classic.Stop({ ...GATE_STOP, last_assistant_message: CHECKED })).block).toBeUndefined()
  await $.turn.complete({ turnId: 't1', ...DONE })
})

// --- spend: one file per session under ~/.claude/spick-spend/ -------------------------------------------------------------

type SpendDoc = { sessionId: string; cwd: string; startedAt: string; rows: Record<string, unknown>[] }

/** a session whose id is s1 and whose HOME is /h; every fs.write recorded (never the real file), a previous file served when given */
function spendWorld(on: Parameters<TestBody>[1], previous: string | null = null) {
  const world = { writes: [] as { path: string; text: string }[], isWriteBroken: false }
  mock.env(on, { HOME: '/h' })
  mock.store(on)
  on('session.id', async () => ({ value: 's1' }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('fs.write', async ($, e) => { if (world.isWriteBroken) return { deny: 'read-only' }; world.writes.push({ path: e.path, text: e.text }); return { value: undefined } })
  on('fs.read', async ($, e) => (e.path === '/h/.claude/spick-spend/s1.json' && previous !== null ? { value: previous } : { deny: 'missing' }))
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  const spendWrites = () => world.writes.filter(w => w.path.includes('/spick-spend/'))
  const lastDoc = (): SpendDoc | undefined => { const w = spendWrites().at(-1); return w ? JSON.parse(w.text) as SpendDoc : undefined }
  return { world, spendWrites, lastDoc }
}

test('a subagent turn, a CLI call and the main turn each write a row to ~/.claude/spick-spend/<session>.json, as the totals count them', { plugins: [probePlugin] }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  const { spendWrites, lastDoc } = spendWorld(on)
  const tools = gatedTools(on)
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  await $.session.start(START)
  await $.turn.start({ text: 'go', turnId: 't1' })

  const agent = $.tool.call({ ...agentCall('tu1', 'coder'), model: 'haiku', effort: 'high' })
  await tools.held('tu1')
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'p', description: 'd', subagentType: 'coder', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-haiku-5-5', background: false, fork: false })
  await $.turn.complete({ turnId: 'sub1', agentId: 'a1', ...DONE, usage: { ...USAGE, model: 'claude-haiku-5-5' } })
  tools.release('tu1')
  await agent

  const cli = $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'agy -p "look it up" --model gemini-3.8-flash --effort low' })
  await tools.held('b1')
  tools.release('b1')
  await cli
  await $.turn.complete({ turnId: 't1', ...DONE })

  // one write per row, each with every row so far, all to the one file
  expect(spendWrites().map(w => w.path)).toEqual(Array(3).fill('/h/.claude/spick-spend/s1.json'))
  const doc = lastDoc()!
  expect(doc).toMatchObject({ sessionId: 's1', cwd: '/repo', startedAt: new Date(1000).toISOString() })
  expect(doc.rows).toEqual([
    { at: new Date(1000).toISOString(), turnId: 'sub1', agentId: 'a1', lane: 'coder', model: 'claude-haiku-5-5', effort: 'high', inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: expect.any(Number) },
    { at: new Date(1000).toISOString(), turnId: 't1', lane: 'Gemini', model: 'gemini-3.8-flash', effort: 'low', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null },
    { at: new Date(1000).toISOString(), turnId: 't1', lane: 'main session', model: 'claude-sonnet-5-5', inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 3 },
  ])
  // the same numbers as the pane's totals
  const t = (await probe($)).totals!
  for (const r of doc.rows) {
    const lane = t[r.lane as string]!
    expect(r.inputTokens).toBe(lane.inputTokens)
    expect(r.outputTokens).toBe(lane.outputTokens)
    expect(r.costUsd).toBe(lane.costUsd)
  }
})

test('a turn with no usage (interrupted, refused, an API error) writes no row; a failing write leaves the totals alone', { plugins: [probePlugin] }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  const { world, spendWrites, lastDoc } = spendWorld(on)
  await $.session.start(START)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' })
  await $.turn.start({ text: 'go', turnId: 't2' })
  await $.turn.complete({ turnId: 't2', answer: '', durationMs: 1, isAborted: false, reason: 'refusal', refusal: { category: null, explanation: null } })
  await $.turn.start({ text: 'go', turnId: 't3' })
  await $.turn.complete({ turnId: 't3', answer: '', durationMs: 1, isAborted: false, reason: 'error' })
  expect(spendWrites()).toEqual([])
  expect((await probe($)).totals ?? {}).toEqual({})

  world.isWriteBroken = true
  await $.turn.start({ text: 'go', turnId: 't4' })
  await $.turn.complete({ turnId: 't4', ...DONE })
  expect((await probe($)).totals?.['main session']?.turns).toBe(1)
  // the row stays in memory and lands with the next write that goes through
  world.isWriteBroken = false
  await $.turn.start({ text: 'go', turnId: 't5' })
  await $.turn.complete({ turnId: 't5', ...DONE })
  expect(lastDoc()?.rows.map(r => r.turnId)).toEqual(['t4', 't5'])
})

test('a resumed session keeps the rows its file already holds', async ($, on) => {
  mock.clock(on, { now: 5000 })
  const old = JSON.stringify({ sessionId: 's1', cwd: '/old', startedAt: '2026-10-01T00:00:00.000Z', rows: [{ at: '2026-10-01T00:00:01.000Z', turnId: 't0', lane: 'main session', model: 'm', inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null }] })
  const { lastDoc } = spendWorld(on, old)
  await $.session.start(START)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', ...DONE })
  const doc = lastDoc()!
  expect(doc.startedAt).toBe('2026-10-01T00:00:00.000Z')
  expect(doc.cwd).toBe('/old')
  expect(doc.rows.map(r => r.turnId)).toEqual(['t0', 't1'])
})

test('/spick spend prints what spend.py prints for the last seven days; a failure is one spick: line', async ($, on) => {
  mock.clock(on)
  mock.env(on, { HOME: '/h' })
  const calls: string[][] = []
  let exitCode = 0
  on('process.run', async (_$, e) => {
    calls.push([...e.argv])
    return { value: exitCode === 0
      ? { exitCode, stdout: 'spick spend: last 7 days, by lane\nmain session  1\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      : { exitCode, stdout: '', stderr: '\nspend.py: boom\nmore\n', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  expect((await $.command.run({ command: 'spick', args: 'spend', ...RUN })).text).toBe('spick spend: last 7 days, by lane\nmain session  1')
  expect(calls).toEqual([['python3', '/h/.claude/skills/spick/scripts/spend.py', '--days', '7']])
  exitCode = 2
  expect((await $.command.run({ command: 'spick', args: 'spend', ...RUN })).text).toBe('spick: spend.py: boom')
})
