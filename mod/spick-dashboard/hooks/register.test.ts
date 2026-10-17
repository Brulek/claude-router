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
/** a tool result with a report in it: an Agent call's relay, or a review CLI's output that reads as a report (gate.ts isReport) */
const REPORT = 'Findings: the two error paths differ in how they surface a missing file. '.repeat(4)
const ANSWERED = { result: {} as never, text: REPORT }
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

test('an Agent call of coder, planner or deep with no effort runs at the default from spick.json, else the rules\' default', async ($, on) => {
  mock.clock(on, { now: 1000 })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  let cfg = JSON.stringify({ efforts: { coder: { default: 'high' } } })
  on('fs.read', async (_$, e) => (e.path === '/h/.claude/spick.json' ? { value: cfg } : { deny: 'missing' }))
  const seen: Record<string, unknown> = {}
  on('tool.call', async ($, e) => { seen[e.tool_use_id] = (e as { effort?: unknown }).effort; return { result: {} as never } })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/repo', surface: 'terminal' as const, isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(agentCall('c1', 'coder'))
  await $.tool.call(agentCall('p1', 'planner'))
  await $.tool.call(agentCall('d1', 'deep'))
  await $.tool.call({ ...agentCall('d2', 'deep'), effort: 'max' })
  await $.tool.call(agentCall('x1', 'Explore'))
  expect(seen).toEqual({ c1: 'high', p1: 'high', d1: 'medium', d2: 'max', x1: undefined })
  cfg = 'not json'
  await $.session.start({ cwd: '/repo', surface: 'terminal' as const, isInteractive: true })
  await $.tool.call(agentCall('c3', 'coder'))
  expect(seen.c3).toBe('medium')
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
// on, in a session that is not Haiku: the off sentence also says /spick force exists
const OFF_NOT_HAIKU = OFF + ' (`/spick force` routes on any model; a forced session still sends code to `coder` so the main context stays small)'
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
  on('session.id', async () => ({ value: 's1' }))
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
  expect(world.writes).toEqual([{ path: '/h/.claude/spick/mod-active/s1', text: new Date(1000).toISOString() }])

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
  expect(await contextOf($)).toEqual([OFF_NOT_HAIKU])
  expect((await $.command.run({ command: 'spick', args: 'on', ...RUN })).text).toBe('spick: routing on · routes nothing (Fable 5.1 is not Haiku)')
  expect((await $.command.run({ command: 'spick', args: 'force', ...RUN })).text).toBe('spick: routing force')
  expect(isChecklist(await contextOf($))).toBe(true)
  expect((await $.command.run({ command: 'spick', args: 'auto', ...RUN })).text).toBe('spick: routing on · routes nothing (Fable 5.1 is not Haiku)')
  expect(await contextOf($)).toEqual([OFF_NOT_HAIKU])
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

test('CLAUDE_CONFIG_DIR moves the marker, the quota cache and spick.json; HOME is then not used for them', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-13T15:34:00Z') })
  mock.store(on)
  mock.env(on, { HOME: '/h', CLAUDE_CONFIG_DIR: '/cfg' })
  const world = session(on)
  const reads: string[] = []
  const cache = '{"written_at":"2026-10-13T15:30:00Z","providers":[{"provider":"codex","plan":"Pro Lite","sampled_at":"2026-10-13T15:29:00Z","windows":[{"name":"7d","used_pct":53,"resets_at":"2026-10-20T05:38:29Z","reset":false}]}]}'
  on('fs.read', async (_$, e) => { reads.push(e.path); return e.path === '/cfg/spick/quota.json' ? { value: cache } : { deny: 'missing' } })
  await $.session.start(START)
  await until(() => world.writes.length > 0)
  expect(world.writes.map(w => w.path)).toEqual(['/cfg/spick/mod-active/s1'])
  expect(((await contextOf($))[0] ?? '').split('\n').at(-1)).toBe('Quota (cache 4m old): codex Pro Lite: 7d 53% (resets in 6d).')
  expect(reads).toContain('/cfg/spick.json')
  expect(reads.filter(r => r.startsWith('/h/'))).toEqual([])
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
  expect(await answer('details')).toBe('spick: usage /spick [on|force|off|review on|off|verdicts keep|deep|gate on|off|guard on|off|lane <id> [<field> <value>]|hide|show|quota|spend|audit]')
  expect(await answer('lane glm')).toBe('spick: unknown lane id glm')
  expect(await answer('hide')).toBe('spick: band hidden · /spick show restores it')
  expect(await answer('show')).toBe('spick: band shown')
  for (const args of ['on', 'force', 'off', 'auto', 'review on', 'review off', 'verdicts deep', 'verdicts keep', 'gate off', 'gate on', 'guard off', 'guard on', 'lane grok on', 'lane codex off', 'lane claude off', 'lane grok', 'lane openrouter notes Two words', 'lane grok tags', 'hide', 'show', 'quota', 'what']) {
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
  expect(text).toBe('spick: routing on, routes (Haiku 5.5 session); review auto; verdicts keep; gate on; guard on; lanes: Gemini on, Grok on, Codex off, openrouter on; band shown; quota unknown (no local data for claude or codex).')
  expect(text).not.toContain('\n')
})

test('the quota line from the cache file is the checklist\'s last line; with no cache the line is left out', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-13T15:34:00Z') })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  session(on)
  let cache: string | null = '{"written_at":"2026-10-13T15:30:00Z","providers":[{"provider":"codex","plan":"Pro Lite","sampled_at":"2026-10-13T15:29:00Z","windows":[{"name":"7d","used_pct":53,"resets_at":"2026-10-20T05:38:29Z","reset":false}]}]}'
  on('fs.read', async (_$, e) => (e.path === '/h/.claude/spick/quota.json' && cache !== null ? { value: cache } : { deny: 'missing' }))
  await $.session.start(START)
  const withLine = await contextOf($)
  expect(withLine.length).toBe(1)
  expect((withLine[0] ?? '').split('\n').at(-1)).toBe('Quota (cache 4m old): codex Pro Lite: 7d 53% (resets in 6d).')
  cache = null
  const without = await contextOf($)
  expect(isChecklist(without)).toBe(true)
  expect(without[0]).not.toContain('Quota')
})

test('a cold quota cache leaves the lanes to spick.json: everything disabled reads "no outside lane is enabled"; no spick.json either is the built-in bullet', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-13T15:34:00Z') })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  session(on)
  let spickJson: string | null = JSON.stringify({ lanes: { gemini: false, grok: false, codex: false }, lane_registry: { gemini: { enabled: false }, grok: { enabled: false }, codex: { enabled: false } } })
  // no quota.json at all: the cache is cold
  on('fs.read', async (_$, e) => (e.path === '/h/.claude/spick.json' && spickJson !== null ? { value: spickJson } : { deny: 'missing' }))
  await $.session.start(START)
  const none = (await contextOf($))[0] ?? ''
  expect(none).toContain('no outside lane is enabled: do not call Gemini, Grok or Codex')
  // one lane on: the registry wording with the Lanes line from the config
  spickJson = JSON.stringify({ lane_registry: { gemini: { enabled: false }, grok: { enabled: false } } })
  const one = (await contextOf($))[0] ?? ''
  expect(one).not.toContain('no outside lane is enabled')
  expect(one).toContain('Lanes (user-declared; data = most that may be sent): codex code,review,image data:code')
  // neither file: the built-in bullet
  spickJson = null
  const builtin = (await contextOf($))[0] ?? ''
  expect(builtin).not.toContain('no outside lane is enabled')
  expect(builtin).not.toContain('Lanes (user-declared')
})

test('registry lanes with facts and no windows reach the checklist with their facts; one with neither reads unknown', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-13T15:34:00Z') })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  session(on)
  const lane = (id: string, facts: string) => `{"provider":"${id}","plan":null,"sampled_at":"2026-10-13T15:29:50Z","windows":[],"facts":${facts}}`
  const cache = `{"written_at":"2026-10-13T15:30:00Z","providers":[${lane('deepseek', '["balance 12.40 CNY"]')},${lane('kimi', '["balance 3.00 CNY"]')},${lane('openrouter', '["used 3.20 of 10.00 USD"]')},${lane('proxy', '[]')}]}`
  on('fs.read', async (_$, e) => (e.path === '/h/.claude/spick/quota.json' ? { value: cache } : { deny: 'missing' }))
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
  on('fs.read', async (_$, e) => (e.path === '/h/.claude/spick/quota.json' ? { value: cache } : { deny: 'missing' }))
  await $.session.start(START)
  const lines = ((await contextOf($))[0] ?? '').split('\n')
  // item 2 is a block of eight lines (head, six bullets, tail); the registry swaps its lane bullet
  expect(lines.slice(2, 10).join('\n')).toContain("   - an outside lane's task -> the Lanes line, by tag")
  expect(lines.slice(2, 10).join('\n')).not.toContain('Gemini (agy)')
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
  const at = lines.findIndex(l => l.startsWith('   Hint (keywords in this prompt, not a verdict): judgement words (对比, 差距) -> size the material: small -> you, with a `Kept:` line; large or high-stakes -> Agent(deep)'))
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
  expect(r.block).toContain('spick gate: this prompt was hinted as a verdict (对比, 差距) and no deep run completed this turn')
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
  on('tool.call', async () => ANSWERED)
  await $.session.start(START)
  const turn = async (id: string, text: string) => { await $.prompt.submit({ ...PROMPT, text }); await $.turn.start({ text, turnId: id }) }
  const stop = async (msg: string) => (await $.classic.Stop({ ...GATE_STOP, last_assistant_message: msg })).block
  // delegated to deep: no gate
  await turn('t1', VERDICT)
  await $.tool.call({ ...agentCall('a1', 'deep'), model: 'opus', effort: 'high' })
  expect(await stop(LONG_REPLY)).toBeUndefined()
  await $.turn.complete({ turnId: 't1', ...DONE })
  // a review prompt reviewed by Codex: no gate
  await turn('t2', 'review this diff please')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'git diff | codex exec --sandbox read-only "Review this diff"' })
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

test('the gate asks for the role the hint names: deep that finished or still runs satisfies it; a coder, a search lane, a refused or failed deep does not', async ($, on) => {
  mock.clock(on, { now: 1000 })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  session(on)
  on('classic.Stop', async () => ({}))
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('agent.spawn', async ($, e) => ({ model: 'claude-opus-5-5', agentId: `ag-${e.tool_use_id}` }))
  const holds = new Map<string, () => void>()
  on('tool.call', async ($, e) => {
    if (e.tool_use_id.startsWith('refused')) return { deny: 'not allowed' }
    if (e.tool_use_id.startsWith('failed')) return { isError: true as const, result: 'boom', text: 'boom' }
    if (e.tool_use_id.startsWith('empty')) return { result: {} as never, text: '' }
    if (e.tool_use_id.startsWith('hold')) await new Promise<void>(r => holds.set(e.tool_use_id, r))
    if (e.tool_use_id.startsWith('short')) return { result: {} as never, text: 'Usage: codex exec [OPTIONS] [PROMPT]' }
    if (e.tool_use_id.startsWith('brief')) return { result: {} as never, text: 'No issues found in this diff.\n' }
    return ANSWERED
  })
  await $.session.start(START)
  const turn = async (id: string, text = VERDICT) => { await $.prompt.submit({ ...PROMPT, text }); await $.turn.start({ text, turnId: id }) }
  const stop = async () => (await $.classic.Stop({ ...GATE_STOP, last_assistant_message: LONG_REPLY })).block
  const spawn = (id: string, background: boolean) => $.agent.spawn({ tool_use_id: id, prompt: 'p', description: 'd', subagentType: 'deep', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-haiku-5-5', background, fork: false })
  const cases: [string, () => Promise<unknown>, boolean][] = [
    ['a coder', () => $.tool.call({ ...agentCall('c1', 'coder') }), true],
    ['a search lane', () => $.tool.call({ tool: 'Bash', tool_use_id: 's1', command: 'agy -p "why" --model gemini-3.8-flash' }), true],
    ['a refused deep', () => $.tool.call({ ...agentCall('refused1', 'deep') }), true],
    ['a failed deep', () => $.tool.call({ ...agentCall('failed1', 'deep') }), true],
    ['a background deep still running', async () => { await spawn('bg1', true); await $.tool.call({ ...agentCall('bg1', 'deep'), run_in_background: true }) }, false],
    ['a background deep that died before stop', async () => {
      await spawn('bg2', true)
      await $.tool.call({ ...agentCall('bg2', 'deep'), run_in_background: true })
      await $.turn.complete({ turnId: 'sub', agentId: 'ag-bg2', answer: '', durationMs: 1, isAborted: false, reason: 'error' })
    }, true],
    ['a foreground deep whose subagent answered', async () => {
      await spawn('fg1', false)
      await $.turn.complete({ turnId: 'sub', agentId: 'ag-fg1', ...DONE })
      await $.tool.call({ ...agentCall('fg1', 'deep') })
    }, false],
    // no completion event before the call returned: the call's own result decides
    ['a foreground deep with no completion event that returned a report', () => $.tool.call({ ...agentCall('fg2', 'deep') }), false],
    ['a foreground deep with no completion event that returned nothing', () => $.tool.call({ ...agentCall('empty1', 'deep') }), true],
    // the engine's order: the call starts, its subagent spawns and ends, then the call returns
    ['a foreground deep whose subagent errored, though the call returned text', async () => {
      const call = $.tool.call({ ...agentCall('hold3', 'deep') })
      while (!holds.has('hold3')) await tick()
      await spawn('hold3', false)
      await $.turn.complete({ turnId: 'sub', agentId: 'ag-hold3', answer: '', durationMs: 1, isAborted: false, reason: 'error' })
      holds.get('hold3')!()
      await call
    }, true],
  ]
  for (const [i, [name, act, gated]] of cases.entries()) {
    await turn(`t${i}`)
    await act()
    const block = await stop()
    expect([name, block === undefined ? 'quiet' : block.includes('no deep run completed') ? 'gated' : block]).toEqual([name, gated ? 'gated' : 'quiet'])
    await $.turn.complete({ turnId: `t${i}`, ...DONE })
  }
  // a review prompt: deep satisfies it; a search lane does not, and the reason names the review lane
  await turn('r1', 'review this diff please')
  await $.tool.call({ ...agentCall('d9', 'deep') })
  expect(await stop()).toBeUndefined()
  await $.turn.complete({ turnId: 'r1', ...DONE })
  await turn('r2', 'review this diff please')
  await $.tool.call({ tool: 'Bash', tool_use_id: 's9', command: 'agy -p "check"' })
  expect(await stop()).toContain('hinted as a review (review) and no review lane call returned cleanly and no deep run completed')
  await $.turn.complete({ turnId: 'r2', ...DONE })
  // a review CLI call counts only as the line's one command, run for real, with real output
  const reviews: [string, string, boolean][] = [
    ['a single codex review', 'codex exec --sandbox read-only "Review this diff" < /dev/null', false],
    ['the diff piped into it', 'git diff | codex exec --sandbox read-only "审查这个改动"', false],
    ['a chain that may skip it', 'true || codex exec "review"', true],
    ['a chain after it', 'codex exec "review the diff"; true', true],
    ['its output piped away', 'codex exec "review the diff" | tail -1', true],
    ['a question about the program', 'codex exec --help review', true],
  ]
  for (const [i, [name, command, gated]] of reviews.entries()) {
    await turn(`v${i}`, 'review this diff please')
    await $.tool.call({ tool: 'Bash', tool_use_id: `v${i}`, command })
    const block = await stop()
    expect([name, block === undefined ? 'quiet' : 'gated']).toEqual([name, gated ? 'gated' : 'quiet'])
    await $.turn.complete({ turnId: `v${i}`, ...DONE })
  }
  // a clean review may be short: it still counts
  await turn('w0', 'review this diff please')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'brief1', command: 'codex exec "review the diff" < /dev/null' })
  expect(await stop()).toBeUndefined()
  await $.turn.complete({ turnId: 'w0', ...DONE })
  // a review that printed a usage line only, and one that failed
  await turn('w1', 'review this diff please')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'short1', command: 'codex exec "review the diff" < /dev/null' })
  expect(await stop()).toContain('spick gate')
  await $.turn.complete({ turnId: 'w1', ...DONE })
  await turn('w2', 'review this diff please')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'failed9', command: 'codex exec "review the diff" < /dev/null' })
  expect(await stop()).toContain('spick gate')
})

test('a review lane from the registry, named by a quoted --lane, satisfies a review hint', async ($, on) => {
  mock.clock(on, { now: 1000 })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  session(on)
  const cache = '{"written_at":"2026-10-13T15:30:00Z","providers":[],"registry":true,"lanes":[{"id":"rev","kind":"api-key","tags":["review"],"data":"code"},{"id":"glm","kind":"api-key","tags":["cheap"],"data":"text"}]}'
  on('fs.read', async (_$, e) => (e.path === '/h/.claude/spick/quota.json' ? { value: cache } : { deny: 'missing' }))
  on('classic.Stop', async () => ({}))
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('tool.call', async () => ANSWERED)
  await $.session.start(START)
  const cases: [string, boolean][] = [
    ['python3 ~/.claude/skills/spick/scripts/invoke.py --lane "rev" --prompt-file /tmp/p.txt', false],
    ["python3 invoke.py --lane='rev' --prompt-file /tmp/p.txt", false],
    ['python3 invoke.py --lane rev --prompt-file /tmp/p.txt', false],
    // a lane without the review tag is no review
    ['python3 invoke.py --lane "glm" --prompt-file /tmp/p.txt', true],
  ]
  for (const [i, [command, gated]] of cases.entries()) {
    await $.prompt.submit({ ...PROMPT, text: 'review this diff please' })
    await $.turn.start({ text: 'review this diff please', turnId: `t${i}` })
    await $.tool.call({ tool: 'Bash', tool_use_id: `b${i}`, command })
    const block = (await $.classic.Stop({ ...GATE_STOP, last_assistant_message: LONG_REPLY })).block
    expect([command, block === undefined ? 'quiet' : 'gated']).toEqual([command, gated ? 'gated' : 'quiet'])
    await $.turn.complete({ turnId: `t${i}`, ...DONE })
  }
})

test('each gate firing and what became of it is in the turn record\'s gateEvents; design words are never gated', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-16T10:00:00Z') })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  const world = session(on)
  const lines = () => (world.writes.filter(w => w.path === '/h/.claude/spick/turns/s1.jsonl').at(-1)?.text ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as { turnId: string; gateEvents: { kind: string; words: string[]; outcome: string }[]; gate: unknown; kept: string | null })
  on('fs.read', async (_$, e) => { const w = world.writes.filter(x => x.path === e.path).at(-1); return w ? { value: w.text } : { deny: 'missing' } })
  on('classic.Stop', async () => ({}))
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('tool.call', async () => ANSWERED)
  await $.session.start(START)
  const turn = async (id: string, text: string) => { await $.prompt.submit({ ...PROMPT, text }); await $.turn.start({ text, turnId: id }) }
  const stop = async (msg: string, active = false) => (await $.classic.Stop({ stop_hook_active: active as false, last_assistant_message: msg })).block
  // sent back, then kept with a Kept: line
  await turn('t1', VERDICT)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'diff a b' })
  expect(await stop(LONG_REPLY)).toContain('spick gate')
  expect(await stop(LONG_REPLY + '\nKept: the deliverable is a diff.', true)).toBeUndefined()
  // a third stop of the same turn records nothing more
  await stop(LONG_REPLY + '\nKept: again.', true)
  await $.turn.complete({ turnId: 't1', ...DONE, answer: LONG_REPLY + '\nKept: the deliverable is a diff.' })
  expect(lines()[0]?.gateEvents).toEqual([
    { at: '2026-10-16T10:00:00.000Z', kind: 'judgement', words: ['为什么'], outcome: 'sent-back' },
    { at: '2026-10-16T10:00:00.000Z', kind: 'judgement', words: ['为什么'], outcome: 'kept' },
  ])
  expect(lines()[0]).toMatchObject({ gate: { kind: 'judgement', outcome: 'kept' }, kept: 'Kept: the deliverable is a diff.' })
  // sent back, then delegated to deep
  await turn('t2', 'review this diff please')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'git diff' })
  expect(await stop(LONG_REPLY)).toContain('spick gate')
  await $.tool.call({ ...agentCall('a2', 'deep'), model: 'opus', effort: 'medium' })
  await stop(LONG_REPLY, true)
  await $.turn.complete({ turnId: 't2', ...DONE })
  expect(lines()[1]?.gateEvents.map(g => [g.kind, g.outcome])).toEqual([['review', 'sent-back'], ['review', 'delegated']])
  // design words alone: a Hint line, never a send-back, nothing recorded
  await turn('t3', '这个功能怎么设计，where is the design doc')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b3', command: 'ls docs' })
  expect(await stop(LONG_REPLY)).toBeUndefined()
  await $.turn.complete({ turnId: 't3', ...DONE })
  expect(lines()[2]).toMatchObject({ turnId: 't3', gateEvents: [], gate: null, kept: null })
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

test('/spick verdicts deep is remembered; under it a Kept: verdict is sent back once and the checklist says deep; keep restores the escape', async ($, on) => {
  mock.clock(on)
  const held = new Map<string, unknown>()
  on('store.get', async (_$, e) => ({ value: held.get(e.key) }))
  on('store.set', async (_$, e) => { held.set(e.key, e.value); return { value: undefined } })
  mock.env(on, { HOME: '/h' })
  const world = session(on)
  on('classic.Stop', async () => ({}))
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('tool.call', async () => ANSWERED)
  await $.session.start(START)
  expect((await $.command.run({ command: 'spick', args: 'verdicts deep', ...RUN })).text).toBe('spick: verdicts deep')
  expect(held.get('spick:verdicts')).toBe('deep')
  // the next session reads it back: the checklist's verdict bullet and the Hint phrase say deep, the rest is unchanged
  await $.session.start(START)
  const block = ((await $.prompt.submit({ ...PROMPT, text: VERDICT })).context ?? []).join('\n')
  expect(block).toContain('small material too -> Agent(deep): this session sends every verdict to deep; a `Kept:` line does not excuse one.')
  expect(block).not.toContain('small material (a few files, under ~200 lines) -> you')
  expect(block).toContain('judgement words (为什么) -> Agent(deep), whatever the size')
  expect(block).toContain('or a one-file edit or fix -> you.')
  expect(block).not.toContain('a kept verdict needs a `Kept:` line')
  // a judgement hint kept with a Kept: line is sent back once, and the reason offers deep alone
  await $.turn.start({ text: VERDICT, turnId: 't1' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'diff a b' })
  const r = await $.classic.Stop({ ...GATE_STOP, last_assistant_message: LONG_REPLY + '\nKept: the deliverable is a diff.' })
  expect(r.block).toContain('spick gate: this prompt was hinted as a verdict (为什么) and no deep run completed this turn')
  expect(r.block).toContain('Verdicts go to deep this session (/spick verdicts deep), so a `Kept:` line does not excuse it: dispatch Agent(deep)')
  expect(r.block).not.toContain('Do one of two things')
  expect(world.toasts).toContain('spick: gate — verdict kept by the triage session; sent back once')
  expect((await $.classic.Stop({ stop_hook_active: true, last_assistant_message: LONG_REPLY })).block).toBeUndefined()
  await $.turn.complete({ turnId: 't1', ...DONE })
  // a review hint with a Kept: line still passes under deep (the switch is about verdicts, not the review lane)
  await $.prompt.submit({ ...PROMPT, text: 'review this diff please' })
  await $.turn.start({ text: 'review this diff please', turnId: 't2' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'git diff' })
  expect((await $.classic.Stop({ ...GATE_STOP, last_assistant_message: LONG_REPLY + '\nKept: a plain lookup.' })).block).toBeUndefined()
  await $.turn.complete({ turnId: 't2', ...DONE })
  // a deep run satisfies it as ever
  await $.prompt.submit({ ...PROMPT, text: VERDICT })
  await $.turn.start({ text: VERDICT, turnId: 't3' })
  await $.tool.call({ ...agentCall('a3', 'deep'), model: 'opus', effort: 'medium' })
  expect((await $.classic.Stop({ ...GATE_STOP, last_assistant_message: LONG_REPLY })).block).toBeUndefined()
  await $.turn.complete({ turnId: 't3', ...DONE })
  // keep restores the escape and the default text
  expect((await $.command.run({ command: 'spick', args: 'verdicts keep', ...RUN })).text).toBe('spick: verdicts keep')
  expect(held.get('spick:verdicts')).toBe('keep')
  const back = ((await $.prompt.submit({ ...PROMPT, text: VERDICT })).context ?? []).join('\n')
  expect(back).toContain('small material (a few files, under ~200 lines) -> you, with a `Kept:` line')
  expect(back).toContain('judgement words (为什么) -> size the material')
  await $.turn.start({ text: VERDICT, turnId: 't4' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b4', command: 'diff a b' })
  expect((await $.classic.Stop({ ...GATE_STOP, last_assistant_message: LONG_REPLY + '\nKept: the deliverable is a diff.' })).block).toBeUndefined()
  await $.turn.complete({ turnId: 't4', ...DONE })
  expect(world.toasts.filter(t => t.startsWith('spick: gate')).length).toBe(1)
})

// --- the guard: an edit cap per turn for the main session, a check before the turn ends -----------------------------
const edit = (id: string, file_path: string, agentId?: string) =>
  ({ tool: 'Edit' as const, tool_use_id: id, file_path, old_string: 'a', new_string: 'b', ...(agentId ? { agentId } : {}) })
const write = (id: string, file_path: string) => ({ tool: 'Write' as const, tool_use_id: id, file_path, content: 'x' })
const notebook = (id: string, notebook_path: string) => ({ tool: 'NotebookEdit' as const, tool_use_id: id, notebook_path, new_source: 'x' })
const bash = (id: string, command: string, agentId?: string) => ({ tool: 'Bash' as const, tool_use_id: id, command, ...(agentId ? { agentId } : {}) })
const CHECKED = 'Done; the tests pass.'

/** a session for the guard's tests: the model given, every tool call answered, the edits that reached the tool recorded */
async function guardWorld($: Engine, on: Parameters<TestBody>[1], model = 'claude-haiku-5-5', spickJson: string | null = null) {
  mock.clock(on, { now: 1000 })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  const world = session(on, model)
  on('fs.read', async (_$, e) => (e.path === '/h/.claude/spick.json' && spickJson !== null ? { value: spickJson } : { deny: 'missing' }))
  const ran: string[] = []
  /** Bash commands (or tool_use_ids) that end in an error result, and commands (or tool_use_ids) held until the test releases them */
  const failing = new Set<string>()
  const held = new Map<string, Promise<void>>()
  on('classic.Stop', async () => ({}))
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('tool.call', async ($, e) => {
    const p = (e as { file_path?: string; notebook_path?: string }).file_path ?? (e as { notebook_path?: string }).notebook_path
    if (p) ran.push(p)
    await held.get(e.tool_use_id)
    if (failing.has(e.tool_use_id)) return { isError: true as const, result: 'String to replace not found', text: 'String to replace not found' }
    const command = (e as { command?: string }).command
    if (command !== undefined) {
      await held.get(command)
      if (failing.has(command)) return { isError: true as const, result: 'Exit code 1', text: 'Exit code 1\nFAILED test_a.py::test_x' }
    }
    return { result: {} as never }
  })
  await $.session.start(START)
  const turn = async (id: string, text = 'tidy the module') => { await $.prompt.submit({ ...PROMPT, text }); await $.turn.start({ text, turnId: id }) }
  const stop = async (msg = CHECKED) => (await $.classic.Stop({ ...GATE_STOP, last_assistant_message: msg })).block
  const run = async (args: string) => (await $.command.run({ command: 'spick', args, ...RUN })).text
  return { world, ran, turn, stop, run, failing, held }
}

test('the guard refuses the main session\'s second distinct source file in a turn, naming the first, with a toast and an edit cap note', { plugins: [probePlugin] }, async ($, on) => {
  const { world, ran, turn } = await guardWorld($, on)
  await turn('t1')
  expect((await $.tool.call(edit('e1', '/repo/a.py'))).deny).toBeUndefined()
  const r = await $.tool.call(edit('e2', '/repo/b.ts'))
  expect(r.deny).toContain('spick guard: the triage session already edited /repo/a.py itself this turn')
  expect(r.deny).toContain('Agent(coder)')
  // the refused edit never reached the tool; a Write and a NotebookEdit to a new file are refused alike
  expect(ran).toEqual(['/repo/a.py'])
  expect((await $.tool.call(write('w3', '/repo/e.swift'))).deny).toContain('spick guard')
  expect((await $.tool.call(notebook('n4', '/repo/f.ipynb'))).deny).toContain('spick guard')
  expect(world.toasts.filter(t => t.startsWith('spick: guard — edit cap: one source file per turn')).length).toBe(3)
  expect((await probe($)).current?.note).toEqual({ kind: 'error', text: 'edit cap' })
  // the cap is per turn: the next turn starts again
  await $.turn.complete({ turnId: 't1', ...DONE })
  await turn('t2')
  expect((await $.tool.call(edit('e5', '/repo/b.ts'))).deny).toBeUndefined()
})

test('the guard lets through the file already edited, a subagent\'s edits, and paths that are not source', async ($, on) => {
  const { ran, turn } = await guardWorld($, on)
  await turn('t1')
  await $.tool.call(edit('e1', '/repo/a.py'))
  // the same file a second, third time: still the one
  expect((await $.tool.call(edit('e2', '/repo/a.py'))).deny).toBeUndefined()
  expect((await $.tool.call(write('w3', '/repo/a.py'))).deny).toBeUndefined()
  // a subagent's edits never count against the main session's cap
  for (const f of ['/repo/d.py', '/repo/e.py', '/repo/f.py', '/repo/g.py']) expect((await $.tool.call(edit(`s-${f}`, f, 'a1'))).deny).toBeUndefined()
  // notes, data and a leading .claude/ are not source
  for (const f of ['/repo/README.md', '/repo/data.csv', '/repo/notes.txt', '/repo/.claude/settings.local.py']) expect((await $.tool.call(edit(`n-${f}`, f))).deny).toBeUndefined()
  expect(ran).toHaveLength(11)
})

test('a worktree under .claude/worktrees/ is source: its second file is refused (regression: v1 skipped any .claude/ path)', async ($, on) => {
  const { turn } = await guardWorld($, on)
  await turn('t1')
  expect((await $.tool.call(edit('e1', '/repo/.claude/worktrees/x/src/a.py'))).deny).toBeUndefined()
  expect((await $.tool.call(edit('e2', '/repo/.claude/worktrees/x/src/b.py'))).deny).toContain('spick guard')
  // json, yaml and toml count as source too
  await $.turn.complete({ turnId: 't1', ...DONE })
  await turn('t2')
  await $.tool.call(edit('e3', '/repo/pyproject.toml'))
  expect((await $.tool.call(edit('e4', '/repo/.github/workflows/ci.yml'))).deny).toContain('spick guard')
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
  expect(await four('t2')).toBe(3)
  expect(await run('off')).toBe('spick: routing off')
  expect(await four('t3')).toBe(0)
  await run('on')
  // routing on in an Opus session routes nothing, so the guard stays out of the way
  world.model = 'claude-opus-5-5'
  expect(await four('t4')).toBe(0)
  // forced routing on Opus: the guard applies
  await run('force')
  expect(await four('t5')).toBe(3)
})

test('a turn that edited source and ran no check is sent back once at stop, with a toast; the next stop passes', async ($, on) => {
  const { world, turn, stop } = await guardWorld($, on)
  await turn('t1')
  await $.tool.call(edit('e1', '/repo/a.py'))
  const block = await stop()
  expect(block).toContain('spick guard: source files were edited this turn (/repo/a.py) and no check passed after the last edit')
  expect(block).toContain('`Unchecked:`')
  expect(block).toContain('`/goal <check command>; stop after 10 attempts`')
  expect(world.toasts).toContain('spick: guard — source edited, no passing check after it; sent back once')
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

test('a check counts only when it passed and came after the last source edit, with none landing while it ran', async ($, on) => {
  const { turn, stop, failing, held } = await guardWorld($, on)
  // a failing check (an error result) does not count; the same check passing afterwards does
  failing.add('pytest -q')
  await turn('t1')
  await $.tool.call(edit('e1', '/repo/a.py'))
  await $.tool.call(bash('b1', 'pytest -q'))
  expect(await stop()).toContain('spick guard')
  await $.turn.complete({ turnId: 't1', ...DONE })
  failing.clear()
  await turn('t2')
  await $.tool.call(edit('e2', '/repo/a.py'))
  await $.tool.call(bash('b2', 'pytest -q'))
  expect(await stop()).toBeUndefined()
  await $.turn.complete({ turnId: 't2', ...DONE })
  // a check before the last edit does not cover it
  await turn('t3')
  await $.tool.call(edit('e3', '/repo/a.py'))
  await $.tool.call(bash('b3', 'pytest -q'))
  await $.tool.call(edit('e4', '/repo/a.py'))
  expect(await stop()).toContain('spick guard')
  await $.turn.complete({ turnId: 't3', ...DONE })
  // an edit (a subagent's) that lands while the check runs leaves the turn unchecked
  await turn('t4')
  await $.tool.call(edit('e5', '/repo/a.py'))
  let release = () => {}
  held.set('npm test', new Promise<void>(r => { release = r }))
  const check = $.tool.call(bash('b4', 'npm test'))
  await tick()
  await $.tool.call(edit('e6', '/repo/b.py', 'a1'))
  release()
  await check
  expect(await stop()).toContain('spick guard')
  await $.turn.complete({ turnId: 't4', ...DONE })
})

test('a check binds to completed edits: one started while an edit was in flight, or with one finishing while it ran, does not cover the turn', async ($, on) => {
  const { turn, stop, failing, held } = await guardWorld($, on)
  const hold = (key: string) => { let release = () => {}; held.set(key, new Promise<void>(r => { release = r })); return () => release() }
  // the edit is still in flight when the check starts and ends: the check proves nothing about it
  await turn('t1')
  const freeE1 = hold('e1')
  const e1 = $.tool.call(edit('e1', '/repo/a.py'))
  await tick()
  await $.tool.call(bash('b1', 'pytest -q'))
  freeE1()
  await e1
  expect(await stop()).toContain('spick guard')
  await $.turn.complete({ turnId: 't1', ...DONE })
  // the edit finishes while the check runs
  await turn('t2')
  const freeE2 = hold('e2')
  const e2 = $.tool.call(edit('e2', '/repo/a.py'))
  await tick()
  const freeB2 = hold('b2')
  const b2 = $.tool.call(bash('b2', 'pytest -q'))
  await tick()
  freeE2()
  await e2
  freeB2()
  await b2
  expect(await stop()).toContain('spick guard')
  await $.turn.complete({ turnId: 't2', ...DONE })
  // an edit that failed changed nothing: no check is owed, and its file leaves the cap so another file goes through
  await turn('t3')
  failing.add('e3')
  await $.tool.call(edit('e3', '/repo/a.py'))
  expect(await stop()).toBeUndefined()
  expect((await $.tool.call(edit('e4', '/repo/b.py'))).deny).toBeUndefined()
  await $.tool.call(bash('b4', 'pytest -q'))
  expect(await stop()).toBeUndefined()
  await $.turn.complete({ turnId: 't3', ...DONE })
})

test('the main loop\'s second failure of the same check carries one escalation line; a different check, a pass or a subagent\'s does not', async ($, on) => {
  const { turn, failing } = await guardWorld($, on)
  const ESC = 'spick: this check failed 2 times this turn'
  const ctx = async (id: string, command: string, agentId?: string) => ((await $.tool.call(bash(id, command, agentId))) as { context?: readonly string[] }).context ?? []
  failing.add('pytest -q tests/a.py')
  failing.add('pytest tests/a.py -x')
  failing.add('pytest tests/b.py')
  await turn('t1')
  expect(await ctx('b1', 'pytest -q tests/a.py')).toEqual([])
  // another target fails once: no line
  expect(await ctx('b2', 'pytest tests/b.py')).toEqual([])
  // a subagent's failures of the same check do not count for the main session
  expect(await ctx('b3', 'pytest -q tests/a.py', 'a1')).toEqual([])
  // the same check (flags aside) fails a second time: the line rides on that result
  const second = await ctx('b4', 'pytest tests/a.py -x')
  expect(second.length).toBe(1)
  expect(second[0]).toContain(`${ESC} (pytest tests/a.py -x)`)
  // once per turn
  expect(await ctx('b5', 'pytest -q tests/a.py')).toEqual([])
  await $.turn.complete({ turnId: 't1', ...DONE })
  // a new turn counts from zero
  await turn('t2')
  expect(await ctx('b6', 'pytest -q tests/a.py')).toEqual([])
})

test('a runner named in an argument, a masked exit status or a version query is no check at stop', async ($, on) => {
  const { turn, stop } = await guardWorld($, on)
  for (const [i, c] of ['echo pytest', 'grep pytest README', 'pytest || true', 'pytest --version', 'true || pytest', 'pytest; true', 'pytest | cat', 'npm test | tail -5'].entries()) {
    await turn(`t${i}`)
    await $.tool.call(edit(`e${i}`, '/repo/a.py'))
    await $.tool.call(bash(`b${i}`, c))
    expect(await stop()).toContain('spick guard')
    await $.turn.complete({ turnId: `t${i}`, ...DONE })
  }
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

test('a check command the project declares in spick.json counts; a pattern that does not compile is ignored with one toast', async ($, on) => {
  const cfg = JSON.stringify({ version: 1, guard: { check_commands: ['^just check\\b', '(broken'] } })
  const { world, turn, stop } = await guardWorld($, on, 'claude-haiku-5-5', cfg)
  expect(world.toasts.filter(t => t.startsWith('spick: guard.check_commands')))
    .toEqual(['spick: guard.check_commands — ignored 1 pattern(s) that do not compile: (broken'])
  await turn('t1')
  await $.tool.call(edit('e1', '/repo/a.py'))
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'just check --all' })
  expect(await stop(LONG_REPLY)).toBeUndefined()
  await $.turn.complete({ turnId: 't1', ...DONE })
  // a command neither built in nor declared leaves the turn unchecked
  await turn('t2')
  await $.tool.call(edit('e2', '/repo/b.py'))
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'just fmt' })
  expect(await stop(LONG_REPLY)).toContain('spick guard')
})

test('the gate and the guard\'s check send a turn back once between them, with both reasons in the one block', async ($, on) => {
  const { world, turn, stop } = await guardWorld($, on)
  await turn('t1', VERDICT)
  await $.tool.call(edit('e1', '/repo/a.py'))
  const block = await stop(LONG_REPLY)
  expect(block).toContain('spick gate')
  expect(block).toContain('spick guard: source files were edited this turn (/repo/a.py)')
  expect(block).toContain('spick sends a turn back once')
  // the second stop of the turn: neither sends it back again
  expect(await stop(LONG_REPLY)).toBeUndefined()
  expect(world.toasts.filter(t => t.startsWith('spick: guard')).length).toBe(1)
  expect(world.toasts.filter(t => t.startsWith('spick: gate')).length).toBe(1)
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

// --- the turn record: one file per session under <state>/turns/ -----------------------------------------------------

type Line = Record<string, unknown> & { turnId: string; delegates: Record<string, unknown>[] }

/** a session whose id is s1 and whose HOME is /h; every fs.write recorded (never the real file) and served back to reads */
function recordWorld(on: Parameters<TestBody>[1], previous: string | null = null) {
  const world = { writes: [] as { path: string; text: string }[], isWriteBroken: false }
  mock.env(on, { HOME: '/h' })
  mock.store(on)
  on('session.id', async () => ({ value: 's1' }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('fs.write', async ($, e) => { if (world.isWriteBroken) return { deny: 'read-only' }; world.writes.push({ path: e.path, text: e.text }); return { value: undefined } })
  on('fs.read', async ($, e) => {
    const w = world.writes.filter(x => x.path === e.path).at(-1)
    if (w) return { value: w.text }
    return e.path === '/h/.claude/spick/turns/s1.jsonl' && previous !== null ? { value: previous } : { deny: 'missing' }
  })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('prompt.submit', async ($, e) => ({ text: e.text, context: e.context }))
  const turnWrites = () => world.writes.filter(w => w.path.includes('/spick/turns/'))
  const lines = (): Line[] => (turnWrites().at(-1)?.text ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Line)
  return { world, turnWrites, lines }
}

test('a main turn writes one line to <state>/turns/<session>.jsonl: delegates with status and usage, edits, checks, usage, context', { plugins: [probePlugin] }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  const { turnWrites, lines } = recordWorld(on)
  const tools = gatedTools(on)
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: { model: e.model, input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2000 } }
  })
  await $.session.start(START)
  await $.prompt.submit({ text: 'fix the bug in a.py', wait: false, origin: { kind: 'composer' as const } })
  await $.turn.start({ text: 'fix the bug in a.py', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', effort: 'medium', messageCount: 1 })) { /* drain */ }

  const agent = $.tool.call({ ...agentCall('tu1', 'coder'), model: 'haiku', effort: 'high' })
  await tools.held('tu1')
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'p', description: 'd', subagentType: 'coder', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-haiku-5-5', background: false, fork: false })
  const sub = $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/repo/b.py', old_string: 'a', new_string: 'b', agentId: 'a1' })
  await tools.held('e1')
  tools.release('e1')
  await sub
  await $.turn.complete({ turnId: 'sub1', agentId: 'a1', ...DONE, usage: { ...USAGE, model: 'claude-haiku-5-5' } })
  tools.release('tu1')
  await agent
  const edit = $.tool.call({ tool: 'Edit', tool_use_id: 'e2', file_path: '/repo/a.py', old_string: 'a', new_string: 'b' })
  await tools.held('e2')
  tools.release('e2')
  await edit
  const cli = $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'agy -p "look it up" --model gemini-3.8-flash --effort low' })
  await tools.held('b1')
  tools.release('b1')
  await cli
  const check = $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'cd /repo && python3 -m pytest -q' })
  await tools.held('b2')
  tools.release('b2')
  await check
  await $.turn.complete({ turnId: 't1', ...DONE, durationMs: 9000 })

  expect(turnWrites().map(w => w.path)).toEqual(['/h/.claude/spick/turns/s1.jsonl'])
  const [line] = lines()
  expect(line).toMatchObject({
    schemaVersion: 2, at: new Date(1000).toISOString(), sessionId: 's1', turnId: 't1', cwd: '/repo', mainModel: 'claude-sonnet-5-5', routing: 'on',
    hint: ['code'], kept: null, gate: null, gateEvents: [],
    edits: { main: 1, agents: 1, files: ['/repo/b.py', '/repo/a.py'] },
    check: { ran: true, passed: true, afterLastEdit: true, command: 'python3 -m pytest -q' },
    escalation: null,
    usage: { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0, costUsd: 3 },
    context: { lastInput: 42_100 }, ms: 9000,
  })
  expect(line!.delegates).toEqual([
    { id: 'tu1', lane: 'coder', model: 'claude-haiku-5-5', effort: 'high', status: 'completed', ok: true, confirmedBy: 'turn.complete', startedAt: new Date(1000).toISOString(), ms: 0,
      usage: { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0, costUsd: expect.any(Number) }, costUsd: expect.any(Number) },
    { id: 'b1', lane: 'Gemini', model: 'gemini-3.8-flash', effort: 'low', status: 'completed', ok: true, outputChars: 0, isReport: false, startedAt: new Date(1000).toISOString(), ms: 0, usage: null, costUsd: null },
  ])
  expect((line as { agentUsage: { input: number } }).agentUsage.input).toBe(1_000_000)
  expect((line as { checks: unknown[] }).checks).toEqual([{ command: 'python3 -m pytest -q', startedAt: new Date(1000).toISOString(), finishedAt: new Date(1000).toISOString(), exitOk: true, editsDuring: 0, afterLastEdit: true }])
  // the pane's totals still count every turn
  expect((await probe($)).totals?.coder?.inputTokens).toBe(1_000_000)
})

test('a background agent that finishes after its main turn\'s line adds a late line with the same turnId and its usage', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const { lines } = recordWorld(on)
  on('tool.call', async () => ({ result: {} as never }))
  on('agent.spawn', async () => ({ model: 'claude-opus-5-5', agentId: 'bg' }))
  await $.session.start(START)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'p', description: 'd', subagentType: 'deep', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-haiku-5-5', background: true, fork: false })
  await $.tool.call({ ...agentCall('tu1', 'deep'), run_in_background: true })
  await $.turn.complete({ turnId: 't1', ...DONE })
  expect(lines()[0]?.delegates[0]).toMatchObject({ id: 'tu1', lane: 'deep', status: 'running', ok: false, ms: null, usage: null })
  await $.turn.complete({ turnId: 'sub', agentId: 'bg', ...DONE, usage: { ...USAGE, model: 'claude-opus-5-5' } })
  const late = lines()[1] as Record<string, unknown> & { delegate: Record<string, unknown> }
  expect(late).toMatchObject({ schemaVersion: 2, late: true, sessionId: 's1', turnId: 't1' })
  expect(late.delegate).toMatchObject({ id: 'tu1', lane: 'deep', status: 'completed', ok: true, usage: { input: 1_000_000, output: 100_000 } })
})

test('a subagent\'s own turn.start does not reset the main turn: its delegate, hint and turn id survive into the record', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const { lines } = recordWorld(on)
  on('tool.call', async () => ({ result: {} as never }))
  on('agent.spawn', async () => ({ model: 'claude-opus-5-5', agentId: 'bg' }))
  await $.session.start(START)
  await $.prompt.submit({ text: '请给出一个备份方案设计', wait: false, origin: { kind: 'composer' as const } })
  await $.turn.start({ text: '请给出一个备份方案设计', turnId: 't1' })
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'p', description: 'd', subagentType: 'planner', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-haiku-5-5', background: true, fork: false })
  await $.tool.call({ ...agentCall('tu1', 'planner'), run_in_background: true })
  // the planner's loop starts a turn of its own; the engine reports it with the agent's id
  await $.turn.start({ text: 'p', turnId: 'sub', agentId: 'bg' })
  await $.turn.complete({ turnId: 't1', ...DONE })
  const [line] = lines()
  expect(line).toMatchObject({ turnId: 't1', hint: ['design'] })
  expect(line!.delegates).toHaveLength(1)
  expect(line!.delegates[0]).toMatchObject({ id: 'tu1', lane: 'planner', status: 'running', ok: false })
  // the planner's end still reaches the main turn's line as a late line
  await $.turn.complete({ turnId: 'sub', agentId: 'bg', ...DONE, usage: { ...USAGE, model: 'claude-opus-5-5' } })
  expect(lines()[1]).toMatchObject({ late: true, turnId: 't1', delegate: { id: 'tu1', lane: 'planner', status: 'completed', ok: true } })
})

test('a delegate started inside a subagent is recorded for the main turn, with its parent; its usage lands on it', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const { lines } = recordWorld(on)
  const tools = gatedTools(on)
  on('agent.spawn', async ($, e) => ({ model: e.subagentType === 'deep' ? 'claude-opus-5-5' : 'claude-sonnet-5-5', agentId: `ag-${e.tool_use_id}` }))
  const spawn = (id: string, type: string) => $.agent.spawn({ tool_use_id: id, prompt: 'p', description: 'd', subagentType: type, provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-haiku-5-5', background: false, fork: false })
  await $.session.start(START)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const coder = $.tool.call({ ...agentCall('c1', 'coder'), effort: 'high' })
  await tools.held('c1')
  await spawn('c1', 'coder')
  // inside the coder: a deep call and a Gemini call
  const deep = $.tool.call({ ...agentCall('d1', 'deep'), agentId: 'ag-c1' })
  await tools.held('d1')
  await spawn('d1', 'deep')
  await $.turn.complete({ turnId: 'sub-d', agentId: 'ag-d1', ...DONE, usage: { ...USAGE, model: 'claude-opus-5-5' } })
  tools.release('d1')
  await deep
  const cli = $.tool.call({ tool: 'Bash', tool_use_id: 'g1', command: 'agy -p "look it up"', agentId: 'ag-c1' })
  await tools.held('g1')
  tools.release('g1')
  await cli
  await $.turn.complete({ turnId: 'sub-c', agentId: 'ag-c1', ...DONE })
  tools.release('c1')
  await coder
  await $.turn.complete({ turnId: 't1', ...DONE })
  const ds = lines()[0]!.delegates
  expect(ds.map(d => [d.id, d.lane, d.status, (d as { parent?: string }).parent ?? null])).toEqual([
    ['c1', 'coder', 'completed', null], ['d1', 'deep', 'completed', 'ag-c1'], ['g1', 'Gemini', 'completed', 'ag-c1'],
  ])
  expect(ds[1]).toMatchObject({ confirmedBy: 'turn.complete', usage: { input: 1_000_000, output: 100_000 } })
  expect((lines()[0] as { agentUsage: { input: number } }).agentUsage.input).toBe(2_000_000)
})

test('a delegate with no completion signal for 30 minutes reads timed-out; when it completes later a late line carries its usage', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const { lines } = recordWorld(on)
  on('tool.call', async () => ({ result: {} as never }))
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'slow' }))
  await $.session.start(START)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'p', description: 'd', subagentType: 'coder', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-haiku-5-5', background: true, fork: false })
  await $.tool.call({ ...agentCall('tu1', 'coder'), run_in_background: true })
  await clock.advance(31 * 60_000)
  // any tool call sweeps the stale ones
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'ls' })
  await $.turn.complete({ turnId: 't1', ...DONE })
  expect(lines()[0]?.delegates[0]).toMatchObject({ id: 'tu1', lane: 'coder', status: 'timed-out', ok: false, usage: null })
  // it finishes after all: the index entry was kept, so its usage lands on a late line of t1
  await $.turn.complete({ turnId: 'sub', agentId: 'slow', ...DONE, usage: { ...USAGE, model: 'claude-sonnet-5-5' } })
  const late = lines()[1] as Record<string, unknown> & { delegate: Record<string, unknown> }
  expect(late).toMatchObject({ late: true, turnId: 't1' })
  expect(late.delegate).toMatchObject({ id: 'tu1', status: 'completed', ok: true, confirmedBy: 'turn.complete', usage: { input: 1_000_000 } })
})

test('a failed check, then the second failure, are in the record with the escalation and whether a coder followed', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const { lines } = recordWorld(on)
  on('tool.call', async ($, e) => (e.tool === 'Bash' && e.command.startsWith('pytest') ? { isError: true as const, result: 'Exit code 1', text: 'Exit code 1' } : { result: {} as never }))
  await $.session.start(START)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/repo/a.py', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'pytest -q' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'pytest -q' })
  await $.tool.call({ ...agentCall('c1', 'coder'), effort: 'high' })
  await $.turn.complete({ turnId: 't1', ...DONE })
  expect(lines()[0]).toMatchObject({ check: { ran: true, passed: false, afterLastEdit: true, command: 'pytest -q' }, escalation: { command: 'pytest -q', followed: true } })
})

test('a turn with no usage still writes its line, usage null; a failing write keeps the line for the next; a resumed file is appended to', async ($, on) => {
  mock.clock(on, { now: 5000 })
  const old = '{"schemaVersion":2,"turnId":"t0"}\n'
  const { world, turnWrites, lines } = recordWorld(on, old)
  await $.session.start(START)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' })
  expect(lines().map(l => [l.turnId, l.usage])).toEqual([['t0', undefined], ['t1', null]])
  world.isWriteBroken = true
  await $.turn.start({ text: 'go', turnId: 't2' })
  await $.turn.complete({ turnId: 't2', ...DONE })
  expect(turnWrites().length).toBe(1)
  world.isWriteBroken = false
  await $.turn.start({ text: 'go', turnId: 't3' })
  await $.turn.complete({ turnId: 't3', ...DONE })
  expect(lines().map(l => l.turnId)).toEqual(['t0', 't1', 't2', 't3'])
})

test('/spick audit prints what audit.py prints for the last seven days; a failure is one spick: line', async ($, on) => {
  mock.clock(on)
  mock.env(on, { HOME: '/h' })
  const calls: string[][] = []
  let exitCode = 0
  on('process.run', async (_$, e) => {
    calls.push([...e.argv])
    return { value: exitCode === 0
      ? { exitCode, stdout: 'spick audit: last 7 days, 3 turns\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      : { exitCode, stdout: '', stderr: 'audit.py: boom\n', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  expect((await $.command.run({ command: 'spick', args: 'audit', ...RUN })).text).toBe('spick audit: last 7 days, 3 turns')
  expect(calls).toEqual([['python3', '/h/.claude/skills/spick/scripts/audit.py', '--days', '7']])
  exitCode = 2
  expect((await $.command.run({ command: 'spick', args: 'audit', ...RUN })).text).toBe('spick: audit.py: boom')
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
