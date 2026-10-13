import { test, expect, mock } from 'claude-code/testing'

const USAGE = { model: 'claude-sonnet-5-5', input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const BAND = { hasSurvey: false, isWorking: false, maxRows: 1, bodyColumns: 80, scroll: { offset: 0, bodyRows: 1 }, view: {} }
const WIDE = { ...BAND, bodyColumns: 100 }
// the kit's types carry no timers; the runner has them
const timers = globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }
const tick = () => new Promise<void>(r => timers.setTimeout(r, 1))
const PANE = { title: 'Spick', isFocused: false, bodyColumns: 80, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`band draws the last turn, dim, on ${surface}`, async ($, on) => {
    const clock = mock.clock(on, { now: 1000 })
    on('turn.start', async ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', async ($, e) => ({ text: e.answer }))
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await clock.advance(2500)
    await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 2500, isAborted: false, reason: 'answer', usage: USAGE })

    const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'AbovePrompt', props: BAND })
    const texts = await ui.findAll({ type: 'Text' })
    const line = texts.map(t => t.text).join('')
    expect(line.startsWith('spick')).toBe(true)
    expect(line).toContain('Idle')
    expect(line).toContain('last turn:')
    expect(line).toBe('spick   Idle · last turn: main session · took 3s')
    expect(texts[0]?.props).toMatchObject({ bold: true, color: 'claude' })
    expect(texts.slice(1).every(t => t.props.wrap === 'truncate-end')).toBe(true)
    expect(line).not.toContain('/spick for details')
    expect(line).not.toContain('you')
  })

  test(`band reads Working and the hint while the main session works on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1000 })
    on('turn.start', async ($, e) => ({ turnId: e.turnId }))
    await $.turn.start({ text: 'hi', turnId: 't1' })

    const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'AbovePrompt', props: WIDE })
    const texts = await ui.findAll({ type: 'Text' })
    const line = texts.map(t => t.text).join('')
    expect(line.startsWith('spick')).toBe(true)
    expect(line).toContain('Working')
    expect(line).toContain('/spick for details')
    expect(line).toBe('spick   Working · 0s/spick for details')
    expect((await ui.find({ type: 'Text', text: 'Working' }))?.props).toMatchObject({ bold: true, wrap: 'truncate-end' })
    expect((await ui.find({ type: 'Text', text: '/spick for details' }))?.props).toMatchObject({ color: 'subtle' })
  })

  test(`band colors only the file name of a breach on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1000 })
    on('turn.start', async ($, e) => ({ turnId: e.turnId }))
    on('turn.step', async function* ($, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
    })
    on('tool.call', async () => ({ result: {} as never }))
    await $.turn.start({ text: 'hi', turnId: 't1' })
    const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', effort: 'low', messageCount: 1 })
    for await (const _ of step) { /* drain */ }
    await $.tool.call({ tool: 'Edit', tool_use_id: 'tu1', file_path: '/repo/src/lru.py', old_string: 'a', new_string: 'b' })

    const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'AbovePrompt', props: BAND })
    const line = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
    expect(line).toContain('edited')
    expect(line).toContain('src/lru.py')
    expect(line).not.toContain('/spick for details')
    expect((await ui.findAll({ type: 'Text' })).find(t => t.text === 'src/lru.py')?.props).toMatchObject({ color: 'error', wrap: 'truncate-end' })
    expect((await ui.find({ type: 'Text', text: 'Working' }))?.props).toMatchObject({ bold: true })
    const lead = await ui.find({ type: 'Text', text: 'edited ' })
    expect(lead).toBeDefined()
    expect(lead?.props.color).toBeUndefined()
  })

  test(`band shows quota meters on the right when idle, a hot provider in warning, on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1000 })
    mock.env(on, { HOME: '/h' })
    const claudeJson = JSON.stringify({ cachedUsageUtilization: { utilization: { five_hour: { utilization: 5 }, seven_day: { utilization: 8 } } } })
    const codexLine = JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 83, window_minutes: 10080 } } } })
    const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 1, mtimeMs: 1, isLink: false })
    on('fs.read', async ($, e) => ({ value: e.path === '/h/.claude.json' ? claudeJson : codexLine }))
    // sessions/YYYY/MM/DD/s.jsonl: one directory per level, one file at the bottom
    on('fs.list', async ($, e) => {
      const depth = e.path.split('/').length - '/h/.codex/sessions'.split('/').length
      return { value: depth < 3 ? [entry(String(depth), 'dir')] : [entry('s.jsonl', 'file')] }
    })
    on('turn.start', async ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', async ($, e) => ({ text: e.answer }))
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 0, isAborted: false, reason: 'answer', usage: USAGE })

    // turn.start's quota read runs unawaited; draw again until the meters land
    const draw = async () => (await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'AbovePrompt', props: { ...BAND, bodyColumns: 120 } })).findAll({ type: 'Text' })
    let texts = await draw()
    for (let i = 0; i < 50 && !texts.some(t => t.text.startsWith('codex ')); i++) { await tick(); texts = await draw() }
    const line = texts.map(t => t.text).join('')
    expect(line).toBe('spick   Idle · last turn: main session · took 0s' + 'claude ▰▱▱▱▱▱▱▱▱▱ 8%   codex ▰▰▰▰▰▰▰▰▱▱ 83%')
    expect(line).not.toContain('quota:')
    expect(texts.find(t => t.text === 'claude ▰▱▱▱▱▱▱▱▱▱ 8%')?.props).toMatchObject({ color: 'subtle', wrap: 'truncate-end' })
    expect(texts.find(t => t.text === 'codex ▰▰▰▰▰▰▰▰▱▱ 83%')?.props).toMatchObject({ color: 'warning', wrap: 'truncate-end' })
  })

  test(`band shows nothing on the right when idle with no provider known on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1000 })
    on('turn.start', async ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', async ($, e) => ({ text: e.answer }))
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 0, isAborted: false, reason: 'answer', usage: USAGE })
    const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'AbovePrompt', props: { ...BAND, bodyColumns: 120 } })
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('')).toBe('spick   Idle · last turn: main session · took 0s')
  })

  test(`pane draws the three sections and toggles the band on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1000 })
    on('turn.start', async ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', async ($, e) => ({ text: e.answer }))
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 0, isAborted: false, reason: 'answer', usage: USAGE })

    const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'Pane', requestId: 'spick', props: PANE, viewport: { columns: 82, rows: 30 } })
    const all = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    // turn.start refreshed the quota (nothing readable in the test, so every source is unknown)
    for (const want of ['Spick', 'stop picking, just start', 'This session', 'Quota', 'refreshed 0m ago', 'Recent turns']) expect(all).toContain(want)
    expect(all).toContain('total             1      $3.00     list price, not a bill')
    expect(all.some(t => t.startsWith('main session'))).toBe(true)
    expect(all.some(t => /^\d\d:\d\d  main session/.test(t))).toBe(true)
    expect(all.some(t => /\byou\b/.test(t))).toBe(false)
    expect(all.some(t => t.startsWith('grok') && t.endsWith('unknown'))).toBe(true)
    // the Quota heading row spans the quota block, not the pane: here its own text, 'Quota' + 2 + 'refreshed 0m ago'
    expect((await ui.findAll({ type: 'Box' })).find(b => b.props.justifyContent === 'space-between' && b.text.startsWith('Quota'))?.props.width).toBe(23)
    expect((await ui.find({ type: 'Button', key: 'hide' }))?.props.label).toBe('Hide band')
    await ui.press({ key: 'hide' })
    expect((await ui.find({ type: 'Button', key: 'hide' }))?.props.label).toBe('Show band')
  })
}
