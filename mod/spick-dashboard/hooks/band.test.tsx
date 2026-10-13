import { test, expect, mock } from 'claude-code/testing'

const USAGE = { model: 'claude-sonnet-5-5', input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const BAND = { hasSurvey: false, isWorking: false, maxRows: 1, bodyColumns: 80, scroll: { offset: 0, bodyRows: 1 }, view: {} }
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
    expect(line).toContain('spick')
    expect(line).toContain('last: you')
    expect(line).toBe('spick · last: you · 3s')
    expect(texts[0]?.props).toMatchObject({ bold: true, color: 'claude' })
    expect(line).not.toContain('/spick for details')
  })

  test(`band shows the active lane and the hint on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1000 })
    on('turn.start', async ($, e) => ({ turnId: e.turnId }))
    await $.turn.start({ text: 'hi', turnId: 't1' })

    const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'AbovePrompt', props: BAND })
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.map(t => t.text).join('')).toBe('spick · you/spick for details')
    expect((await ui.find({ type: 'Text', text: 'you' }))?.props).toMatchObject({ bold: true })
    expect((await ui.find({ type: 'Text', text: '/spick for details' }))?.props).toMatchObject({ color: 'subtle' })
  })

  test(`pane draws the three sections and toggles the band on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1000 })
    on('turn.start', async ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', async ($, e) => ({ text: e.answer }))
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 0, isAborted: false, reason: 'answer', usage: USAGE })

    const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'Pane', requestId: 'spick', props: PANE, viewport: { columns: 82, rows: 30 } })
    const all = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    for (const want of ['Spick', 'stop picking, just start', 'This session', 'Quota', 'not read yet', 'Recent turns']) expect(all).toContain(want)
    expect(all).toContain('total      1      $3.00     list price, not a bill')
    expect(all.some(t => t.startsWith('grok') && t.endsWith('unknown'))).toBe(true)
    expect((await ui.find({ type: 'Button', key: 'hide' }))?.props.label).toBe('Hide band')
    await ui.press({ key: 'hide' })
    expect((await ui.find({ type: 'Button', key: 'hide' }))?.props.label).toBe('Show band')
  })
}
