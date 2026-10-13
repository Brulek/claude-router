import { test, expect, mock } from 'claude-code/testing'

const USAGE = { model: 'claude-sonnet-5-5', input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const BAND = { hasSurvey: false, isWorking: false, maxRows: 1, bodyColumns: 80, scroll: { offset: 0, bodyRows: 1 }, view: {} }
const WIDE = { ...BAND, bodyColumns: 100 }
// the kit's types carry no timers; the runner has them
const timers = globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }
const tick = () => new Promise<void>(r => timers.setTimeout(r, 1))
const RUN = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }
const PANE = { title: 'SPICK', isFocused: false, bodyColumns: 80, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }

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
    expect(line.startsWith('SPICK')).toBe(true)
    expect(line).toContain('Idle')
    expect(line).toContain('last turn:')
    expect(line).toBe('SPICK   Idle · last turn: main session')
    expect(line).not.toContain('took')
    expect(line).not.toMatch(/\d+s/)
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
    expect(line.startsWith('SPICK')).toBe(true)
    expect(line).toContain('Working')
    expect(line).toContain('/spick for details')
    expect(line).toBe('SPICK   Working · 0s/spick for details')
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

  test(`band never shows quota, even with both providers known and one hot, on ${surface}`, async ($, on) => {
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

    // turn.start's quota read runs unawaited; wait until the pane sees the numbers, then draw the band
    const pane = async () => {
      const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'Pane', requestId: 'spick', props: PANE, viewport: { columns: 82, rows: 30 } })
      const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
      await ui.unmount()
      return texts
    }
    let all = await pane()
    for (let i = 0; i < 50 && !all.some(t => t.startsWith('codex')); i++) { await tick(); all = await pane() }
    expect(all.some(t => t.startsWith('codex'))).toBe(true)
    const texts = await (await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'AbovePrompt', props: { ...BAND, bodyColumns: 120 } })).findAll({ type: 'Text' })
    const line = texts.map(t => t.text).join('')
    expect(line).toBe('SPICK   Idle · last turn: main session')
    expect(line).not.toMatch(/[▰▱%]|claude|codex|quota|took|effort/)
  })

  test(`band shows nothing on the right when idle with no provider known on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1000 })
    on('turn.start', async ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', async ($, e) => ({ text: e.answer }))
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 0, isAborted: false, reason: 'answer', usage: USAGE })
    const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'AbovePrompt', props: { ...BAND, bodyColumns: 120 } })
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('')).toBe('SPICK   Idle · last turn: main session')
  })

  test(`pane draws the sections and toggles the band on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1000 })
    on('turn.start', async ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', async ($, e) => ({ text: e.answer }))
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 0, isAborted: false, reason: 'answer', usage: USAGE })

    const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'Pane', requestId: 'spick', props: PANE, viewport: { columns: 82, rows: 30 } })
    const all = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    // turn.start refreshed the quota (nothing readable in the test, so no provider has data)
    for (const want of ['SPICK', 'This session', 'Quota', 'just now', 'unknown', 'Recent turns']) expect(all).toContain(want)
    // one lane: no total row; the heading row carries the column headers
    expect(all.some(t => t.startsWith('total') || t.includes('  total'))).toBe(false)
    expect(all.some(t => t.includes('turns') && t.includes('est. cost'))).toBe(true)
    expect(all.some(t => /^ {2}main session +1 +\$3\.00$/.test(t))).toBe(true)
    expect(all.some(t => /^\d\d:\d\d  main session/.test(t))).toBe(true)
    expect(all.some(t => /\byou\b/.test(t))).toBe(false)
    // no tagline, price note, refreshed word, nor grok/gemini rows
    expect(all.join('\n')).not.toMatch(/stop pick|list pric|refreshed|not a bill|grok|gemini/)
    // only the one subtle unknown line, no per-provider rows
    expect(all.some(t => t.startsWith('claude') || t.startsWith('codex'))).toBe(false)
    expect((await ui.find({ type: 'Text', text: 'unknown' }))?.props).toMatchObject({ color: 'subtle' })
    // the Band button keeps the hide/show toggle
    expect((await ui.find({ type: 'Button', key: 'band' }))?.props.label).toBe('shown')
    await ui.press({ key: 'band' })
    expect((await ui.find({ type: 'Button', key: 'band' }))?.props.label).toBe('hidden')
  })

  test(`pane hides Recent turns without turns and says not read before the first read on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1000 })
    const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'Pane', requestId: 'spick', props: PANE, viewport: { columns: 82, rows: 30 } })
    const all = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(all).not.toContain('Recent turns')
    expect(all).not.toContain('no turns yet')
    expect(all).toContain('not read')
    expect(all).not.toContain('unknown')
    expect(all.some(t => t.includes('just now') || t.includes('m ago'))).toBe(false)
  })

  test(`pane shows a total row from two lanes, and quota rows only for providers with data, five-cell bars when narrow, on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1000 })
    mock.env(on, { HOME: '/h' })
    on('fs.read', async () => ({ value: JSON.stringify({ cachedUsageUtilization: { utilization: { five_hour: { utilization: 5 }, seven_day: { utilization: 85 } } } }) }))
    on('fs.list', async () => ({ value: [] }))
    on('turn.start', async ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', async ($, e) => ({ text: e.answer }))
    on('tool.call', async () => ({ result: {} as never }))
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'agy -p "x"' })
    await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 0, isAborted: false, reason: 'answer', usage: USAGE })

    const pane = async (columns: number) => {
      const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'Pane', requestId: 'spick', props: { ...PANE, bodyColumns: columns }, viewport: { columns, rows: 30 } })
      const texts = await ui.findAll({ type: 'Text' })
      await ui.unmount()
      return texts
    }
    let texts = await pane(100)
    let all = texts.map(t => t.text)
    for (let i = 0; i < 50 && !all.some(t => t.startsWith('claude')); i++) { await tick(); texts = await pane(100); all = texts.map(t => t.text) }
    expect(all.some(t => /^ {2}total +2 /.test(t))).toBe(true)
    expect(all.some(t => t.startsWith('claude'))).toBe(true)
    expect(all.some(t => t.startsWith('codex'))).toBe(false)
    expect(all).not.toContain('unknown')
    expect(all.some(t => t.startsWith('claude') && t.includes('5h  ▰▱▱▱▱▱▱▱▱▱   5%') && t.includes('7d  ▰▰▰▰▰▰▰▰▰▱  85%'))).toBe(true)
    // narrow: five-cell bars
    const narrow = (await pane(60)).map(t => t.text)
    expect(narrow.some(t => t.startsWith('claude') && t.includes('5h  ▱▱▱▱▱   5%') && t.includes('7d  ▰▰▰▰▱  85%'))).toBe(true)
  })

  test(`pane opens with the Controls section, Close in the title row and the routing note on its own line when narrow, on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1000 })
    mock.store(on)
    on('session.model', async () => ({ value: 'claude-haiku-5-5' }))
    on('fs.write', async () => ({ value: undefined }))
    on('session.start', async ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    await $.command.run({ command: 'spick', args: 'lane codex off', ...RUN })

    const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'Pane', requestId: 'spick', props: PANE, viewport: { columns: 82, rows: 30 } })
    const all = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(all.indexOf('Controls')).toBeGreaterThan(-1)
    expect(all.indexOf('Controls')).toBeLessThan(all.findIndex(t => t.startsWith('Quota')))
    for (const label of ['Routing   ', 'Review    ', 'Lanes     ', 'Band      ']) expect(all).toContain(label)
    expect(all).toContain('      on for this session (Haiku 5.5)')

    const button = async (key: string) => (await ui.find({ type: 'Button', key }))?.props
    // r and v sit on the value they move to: auto -> on, auto -> off
    expect(await button('routing-auto')).toMatchObject({ label: '◉ auto', variant: 'primary' })
    expect((await button('routing-auto'))?.hotkey).toBeUndefined()
    expect(await button('routing-on')).toMatchObject({ label: '○ on', variant: 'secondary', hotkey: 'r' })
    expect(await button('routing-off')).toMatchObject({ label: '○ off', variant: 'secondary' })
    expect(await button('review-auto')).toMatchObject({ label: '◉ auto', variant: 'primary' })
    expect(await button('review-off')).toMatchObject({ label: '○ off', variant: 'secondary', hotkey: 'v' })
    expect(await button('lane-gemini')).toMatchObject({ label: 'Gemini on', variant: 'primary', hotkey: 'g' })
    expect(await button('lane-grok')).toMatchObject({ label: 'Grok on', variant: 'primary', hotkey: 'k' })
    expect(await button('lane-codex')).toMatchObject({ label: 'Codex off', variant: 'secondary', hotkey: 'c' })
    expect(await button('band')).toMatchObject({ label: 'shown', hotkey: 'b' })
    expect(await button('refresh')).toMatchObject({ label: 'Refresh', hotkey: 'q' })
    expect(await button('close')).toMatchObject({ label: 'Close', hotkey: 'x', role: 'dismiss' })

    // SPICK left, Close right: the title row holds both
    const titleRow = (await ui.findAll({ type: 'Box' })).find(b => b.props.justifyContent === 'space-between' && b.text.startsWith('SPICK'))
    expect(titleRow).toBeDefined()
    expect(titleRow?.text).toContain('Close')
    // pressing the active value does nothing
    await ui.press({ key: 'routing-auto' })
    expect(await button('routing-auto')).toMatchObject({ label: '◉ auto', variant: 'primary' })
    // r's button sets on; r then moves to off, then back to auto
    await ui.press({ key: 'routing-on' })
    expect(await button('routing-on')).toMatchObject({ label: '◉ on', variant: 'primary' })
    expect((await button('routing-off'))?.hotkey).toBe('r')
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain('      on (forced)')
    await ui.press({ key: 'routing-off' })
    expect(await button('routing-off')).toMatchObject({ label: '◉ off', variant: 'primary' })
    expect((await button('routing-auto'))?.hotkey).toBe('r')
    // a button that is not the active one sets its own value directly
    await ui.press({ key: 'routing-on' })
    expect(await button('routing-on')).toMatchObject({ label: '◉ on', variant: 'primary' })
    // a lane toggles
    await ui.press({ key: 'lane-gemini' })
    expect(await button('lane-gemini')).toMatchObject({ label: 'Gemini off', variant: 'secondary' })
    // review: the active option does nothing, the other sets it and takes no hotkey
    await ui.press({ key: 'review-auto' })
    expect(await button('review-auto')).toMatchObject({ label: '◉ auto', variant: 'primary' })
    await ui.press({ key: 'review-off' })
    expect(await button('review-off')).toMatchObject({ label: '◉ off', variant: 'primary' })
    expect((await button('review-auto'))?.hotkey).toBe('v')

    // narrow: the explanation sits on its own line under the routing row
    await ui.unmount()
    const narrowUi = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'Pane', requestId: 'spick', props: { ...PANE, bodyColumns: 60 }, viewport: { columns: 60, rows: 30 } })
    expect((await narrowUi.findAll({ type: 'Text' })).map(t => t.text)).toContain('          on (forced)')

  })

  test(`band reads SPICK off while routing is off on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1000 })
    mock.store(on)
    on('turn.start', async ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', async ($, e) => ({ text: e.answer }))
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 0, isAborted: false, reason: 'answer', usage: USAGE })
    await $.command.run({ command: 'spick', args: 'off', ...RUN })

    const texts = await (await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'AbovePrompt', props: BAND })).findAll({ type: 'Text' })
    expect(texts.map(t => t.text).join('')).toBe('SPICK off   Idle · last turn: main session')
    expect(texts[0]).toMatchObject({ text: 'SPICK' })
    expect(texts[0]?.props).toMatchObject({ bold: true, color: 'claude' })
    expect(texts[1]).toMatchObject({ text: ' off' })
    expect(texts[1]?.props).toMatchObject({ color: 'warning' })

    // back on: the wordmark alone
    await $.command.run({ command: 'spick', args: 'on', ...RUN })
    const back = await (await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'AbovePrompt', props: BAND })).findAll({ type: 'Text' })
    expect(back.map(t => t.text).join('')).toBe('SPICK   Idle · last turn: main session')
  })
}
