import { test, expect, mock } from 'claude-code/testing'
import type { Engine, Plugin, TestBody } from 'claude-code/testing'
import type { LaneTotals, TurnRecord } from '../types'

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
  expect((await $.command.run({ command: 'spick', args: 'on', ...RUN })).text).toBe('spick: routing on')
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

test('auto on a model that is not Haiku is off', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  session(on, 'claude-fable-5-1')
  await $.session.start(START)
  expect(await contextOf($)).toEqual([OFF])
  expect((await $.command.run({ command: 'spick', args: 'auto', ...RUN })).text).toBe('spick: routing auto · off (Fable 5.1 is not Haiku)')
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

test('a /model that changed nothing, then /spick on: the next prompt raises no toast and routing stays on', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const world = session(on)
  await $.session.start(START)
  await $.command.run({ command: 'model', args: '', ...RUN })
  expect((await $.command.run({ command: 'spick', args: 'on', ...RUN })).text).toBe('spick: routing on')
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

test('/spick lane gemini off persists to the store and the next session.start reads it back', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  session(on)
  await $.session.start(START)
  expect((await $.command.run({ command: 'spick', args: 'lane gemini off', ...RUN })).text).toBe('spick: Gemini lane off')
  expect((await $.command.run({ command: 'spick', args: 'review off', ...RUN })).text).toBe('spick: review off')

  // a new session: the state starts from the store, so only what was written comes back
  await $.session.start(START)
  const block = (await contextOf($))[0] ?? ''
  expect(block).toContain('Gemini lane is off: use the fallback chain.')
  expect(block).toContain('web lookup -> Grok')
  expect(block).toContain('Codex review is off: skip the review step.')
})

test('session.start reads the three stored choices', async ($, on) => {
  mock.clock(on)
  mock.store(on, { 'spick:routing': 'off', 'spick:review': 'auto', 'spick:lanes': JSON.stringify({ gemini: true, grok: false, codex: true }) })
  session(on)
  await $.session.start(START)
  expect(await contextOf($)).toEqual([OFF])
  await $.command.run({ command: 'spick', args: 'on', ...RUN })
  expect((await contextOf($))[0]).toContain('Grok lane is off: use the fallback chain. X data has no fallback: say so.')
})

test('/model by the user turns routing off for the session with one toast; /spick auto restores', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const world = session(on)
  await $.session.start(START)
  expect(isChecklist(await contextOf($))).toBe(true)

  expect((await $.command.run({ command: 'model', args: 'opus', ...RUN })).text).toBe('model set')
  expect(world.toasts).toEqual(['spick: routing off (model selected manually) · /spick on to resume'])
  expect(await contextOf($)).toEqual([OFF])
  // a second pick: still off, no second toast
  await $.command.run({ command: 'model', args: 'fable', ...RUN })
  expect(world.toasts).toHaveLength(1)

  await $.command.run({ command: 'model', args: 'haiku', ...RUN })
  expect((await $.command.run({ command: 'spick', args: 'auto', ...RUN })).text).toBe('spick: routing auto · on (Haiku 5.5 session)')
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
  expect(world.toasts).toEqual(['spick: routing off (model selected manually) · /spick on to resume'])
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
  expect(world.toasts).toEqual(['spick: routing off (model selected manually) · /spick on to resume'])
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
  session(on)
  await $.session.start(START)
  const answer = async (args: string) => (await $.command.run({ command: 'spick', args, ...RUN })).text ?? ''
  expect(await answer('lane claude off')).toBe('spick: usage /spick [on|off|auto|review on|off|lane <gemini|grok|codex> on|off|hide|show|quota]')
  expect(await answer('hide')).toBe('spick: band hidden · /spick show restores it')
  expect(await answer('show')).toBe('spick: band shown')
  for (const args of ['on', 'off', 'auto', 'review on', 'review off', 'lane grok on', 'lane codex off', 'hide', 'show', 'quota', 'what']) {
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
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.command.run({ command: 'spick', args: 'lane codex off', ...RUN })
  const text = (await $.command.run({ command: 'spick', args: '', ...RUN })).text ?? ''
  expect(text).toBe('spick: routing auto, on (Haiku 5.5 session); review auto; lanes: Gemini on, Grok on, Codex off; band shown; quota unknown (no local data for claude or codex).')
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

test('lanes in the cache switch line 2 to the capability wording and add the Lanes line; /spick lane takes a registered id', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-13T15:34:00Z') })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  session(on)
  const cache = '{"written_at":"2026-10-13T15:30:00Z","providers":[{"provider":"glm","facts":["no meter (declared plan only)"]}],"lanes":[{"id":"glm","kind":"api-key","tags":["cheap"],"data":"text"}]}'
  on('fs.read', async (_$, e) => (e.path === '/h/.claude/spick-quota.json' ? { value: cache } : { deny: 'missing' }))
  await $.session.start(START)
  const lines = ((await contextOf($))[0] ?? '').split('\n')
  expect(lines[2]).toContain('a task an outside lane is tagged for')
  expect(lines.at(-2)).toBe('Lanes (user-declared; data = most that may be sent): glm cheap data:text · glm is a third-party service: sending content to it carries a data-leak risk.')
  expect(lines.at(-1)).toBe('Quota (cache 4m old): glm: no meter (declared plan only).')
  expect((await $.command.run({ command: 'spick', args: 'lane glm off', ...RUN })).text).toBe('spick: glm lane off')
  expect(((await contextOf($))[0] ?? '').split('\n').at(-2)).toBe('glm lane is off for this session')
})
