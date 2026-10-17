import { test, expect, mock } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'
import { LANES as LANE_ROWS, SCRIPT, fakeSetLane } from './fakelane'
import { BAND_BUTTON_CHROME, BAND_SWITCH_GAP } from './format'

const USAGE = { model: 'claude-sonnet-5-5', input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const BAND = { hasSurvey: false, isWorking: false, maxRows: 1, bodyColumns: 80, scroll: { offset: 0, bodyRows: 1 }, view: {} }
const WIDE = { ...BAND, bodyColumns: 100 }
// the kit's types carry no timers; the runner has them
const timers = globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }
const tick = () => new Promise<void>(r => timers.setTimeout(r, 1))
const RUN = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }
const PANE = { title: 'SPICK', isFocused: false, bodyColumns: 80, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }

// --- reading the pane as text: the drawn tree, one string per screen line ---------------------------------------------
type Drawn = string | { type?: string; props?: Record<string, unknown>; children?: unknown[] }
const numberOf = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
/**
 * A Box of a fixed width as a fixed-width terminal lays it out: its left padding, then its text cut to what is left
 * (an ellipsis last) and filled with spaces, to the right edge for `justifyContent: flex-end`. Any other Box: its text.
 */
const fitBox = (o: Exclude<Drawn, string>, text: string): string => {
  const width = numberOf(o.props?.width)
  if (width === undefined) return text
  const pad = numberOf(o.props?.paddingLeft) ?? 0
  const inner = Math.max(0, width - pad)
  const cut = text.length > inner ? text.slice(0, Math.max(0, inner - 1)) + '…' : text
  return ' '.repeat(pad) + (o.props?.justifyContent === 'flex-end' ? cut.padStart(inner) : cut.padEnd(inner))
}
/**
 * What a row shows inline, in `avail` columns: strings and Text joined; a plain Button as the engine draws it (`r: `
 * in front), else its label; a fixed-width Box padded to its width; a full-width Box with `space-between` its first
 * child at the left edge and the last at the right.
 */
const inlineText = (n: unknown, avail: number): string => {
  if (typeof n === 'string') return n
  const o = n as Exclude<Drawn, string>
  const parts = (o.children ?? []).map(c => inlineText(c, avail))
  const kids = parts.join('')
  if (o.type === 'Button') return (o.props?.plain && o.props.hotkey ? `${String(o.props.hotkey)}: ` : '') + (kids || String(o.props?.label ?? ''))
  if (o.type === 'Input') return String(o.props?.label ?? '') + String(o.props?.placeholder ?? '')
  if (o.type === 'Box' && o.props?.width === '100%' && o.props.justifyContent === 'space-between' && parts.length > 1) {
    const [first, ...rest] = parts
    const last = rest.join('')
    return first + ' '.repeat(Math.max(1, avail - first!.length - last.length)) + last
  }
  if (o.type === 'Box') return fitBox(o, kids)
  return kids
}
/**
 * A row Box is one line (trailing spaces cut), a column Box with marginTop is a blank line then its children, anything
 * else is one line. `avail` is the columns inside the Boxes above, their horizontal padding taken off.
 */
function drawnLines(n: unknown, avail: number, out: string[] = []): string[] {
  const o = n as Exclude<Drawn, string>
  if (typeof n === 'string') out.push(n)
  else if (o.type === 'Box' && o.props?.flexDirection === 'row') out.push(inlineText(o, avail).trimEnd())
  else if (o.type === 'Box') {
    if (o.props?.marginTop) out.push('')
    const inner = avail - 2 * (numberOf(o.props?.paddingX) ?? 0)
    for (const c of o.children ?? []) drawnLines(c, inner, out)
  } else out.push(inlineText(o, avail).trimEnd())
  return out
}
type Mounted = { drawn: () => Promise<unknown> }
/** the band as its one screen line, laid out as the pane's lines are (the band has no padding) */
const bandOf = async (ui: Mounted, columns: number) => drawnLines(await ui.drawn(), columns)[0] ?? ''
/** the pane's bodyColumns per mount; a mount not made by mountPane uses PANE's */
const columnsOf = new WeakMap<object, number>()
const linesOf = async (ui: Mounted, columns = columnsOf.get(ui) ?? PANE.bodyColumns) => drawnLines(await ui.drawn(), columns)
/** a Text's look as the tests compare it: a desktop adds `weight: 'semibold'` to bold text by itself, left out here */
const look = (props: Record<string, unknown>): Record<string, unknown> => {
  const { weight: _, ...rest } = props
  return rest
}
const mountPane = async ($: Engine, surface: 'terminal' | 'desktop' | 'mobile' = 'terminal', columns = 80, rows = 40) => {
  const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'Pane', requestId: 'spick', props: { ...PANE, bodyColumns: columns, scroll: { offset: 0, bodyRows: rows } }, viewport: { columns, rows } })
  columnsOf.set(ui, columns)
  return ui
}
/** a key press as the person makes it: the Button that holds the hotkey now (a switch's moves to the next value) */
const pressHotkey = async (ui: Awaited<ReturnType<typeof mountPane>>, hotkey: string) => {
  const b = (await ui.findAll({ type: 'Button' })).find(x => x.props.hotkey === hotkey)
  expect(b).toBeDefined()
  await ui.press({ key: String(b!.props.key) })
}
const paneLinesAt = async ($: Engine, columns = 80, surface: 'terminal' | 'desktop' | 'mobile' = 'terminal') => {
  const ui = await mountPane($, surface, columns)
  const out = await linesOf(ui)
  await ui.unmount()
  return out
}

for (const surface of ['terminal', 'desktop'] as const) {
  /** the band's start as the test tools lay it out: the wordmark, the surface's gap, the routing value */
  const head = (v: string) => `SPICK${' '.repeat(BAND_SWITCH_GAP[surface])}${v}`

  test(`band draws the last turn, dim, on ${surface}`, async ($, on) => {
    const clock = mock.clock(on, { now: 1000 })
    on('turn.start', async ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', async ($, e) => ({ text: e.answer }))
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await clock.advance(2500)
    await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 2500, isAborted: false, reason: 'answer', usage: USAGE })

    const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'AbovePrompt', props: BAND })
    const texts = await ui.findAll({ type: 'Text' })
    const line = await bandOf(ui, BAND.bodyColumns)
    expect(line.startsWith('SPICK')).toBe(true)
    expect(line).toContain('Idle')
    expect(line).toContain('last turn:')
    // the routing switch after the wordmark: the setting (the session model unknown: on, nothing more to say)
    expect(line).toBe(`${head('on')}   Idle · last turn: main session`)
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
    const line = await bandOf(ui, WIDE.bodyColumns)
    expect(line.startsWith('SPICK')).toBe(true)
    expect(line).toContain('Working')
    // the hint keeps its tier (100 columns) and its place at the right edge, the switch beside the wordmark
    expect(line).toMatch(new RegExp(`^${head('on')} {3}Working · 0s +/spick for details$`))
    expect(line).toHaveLength(WIDE.bodyColumns)
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
    const line = await bandOf(await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'AbovePrompt', props: { ...BAND, bodyColumns: 120 } }), 120)
    expect(line).toBe(`${head('on')}   Idle · last turn: main session`)
    expect(line).not.toMatch(/[▰▱%]|claude|codex|quota|took|effort/)
  })

  test(`band shows nothing on the right when idle with no provider known on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1000 })
    on('turn.start', async ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', async ($, e) => ({ text: e.answer }))
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 0, isAborted: false, reason: 'answer', usage: USAGE })
    const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'AbovePrompt', props: { ...BAND, bodyColumns: 120 } })
    expect(await bandOf(ui, 120)).toBe(`${head('on')}   Idle · last turn: main session`)
  })

  test(`pane draws the sections and toggles the band from the title row on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1000 })
    on('turn.start', async ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', async ($, e) => ({ text: e.answer }))
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 0, isAborted: false, reason: 'answer', usage: USAGE })

    const ui = await mountPane($, surface)
    const all = await linesOf(ui)
    // turn.start refreshed the quota (nothing readable in the test, so no provider has data)
    for (const want of [/^SPICK {2}routing off · b: band shown +x: close$/, /^Routing {6}● on {2}r: /, /^Review {7}● auto {2}v: /, /^Lanes {5}Gemini {5}● on {2}g: /, /^Usage /, /^Quota {5}unknown$/, /^ {10}q: refresh · read just now$/, /^Recent /]) {
      expect(all.some(l => want.test(l))).toBe(true)
    }
    // one lane: no total row; the head row carries the column heads
    expect(all.some(l => /\btotal\b/.test(l))).toBe(false)
    expect(all.some(l => /^Usage {5}\s+turns {2}at API rates$/.test(l))).toBe(true)
    expect(all.some(l => /^ {10}main session +1 +\$3\.00$/.test(l))).toBe(true)
    expect(all.some(l => /^Recent {4}\d\d:\d\d {2}main session/.test(l))).toBe(true)
    expect(all.some(l => /\byou\b/.test(l))).toBe(false)
    // no tagline, price note, refreshed word, nor grok/gemini rows beyond the Lanes section's own
    expect(all.join('\n')).not.toMatch(/stop pick|list pric|refreshed|not a bill|This session|Controls|Close|Refresh/)
    expect((await ui.find({ type: 'Text', text: 'unknown' }))?.props).toMatchObject({ color: 'subtle' })
    // the band toggle sits in the title row, a plain Button with hotkey b
    expect(await ui.find({ type: 'Button', key: 'band' })).toMatchObject({ props: { plain: true, hotkey: 'b' }, text: 'band shown' })
    await ui.press({ key: 'band' })
    expect((await linesOf(ui))[0]).toMatch(/^SPICK {2}routing off · b: band hidden +x: close$/)
  })

  test(`pane hides Recent without turns and says not read before the first read on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1000 })
    const all = await paneLinesAt($, 80, surface)
    expect(all.some(l => l.startsWith('Recent'))).toBe(false)
    expect(all.some(l => l.includes('no turns yet'))).toBe(false)
    expect(all).toContain('Quota     q: refresh · not read')
    expect(all.some(l => /^Quota/.test(l) && l.includes('unknown'))).toBe(false)
    expect(all.some(l => l.includes('just now') || l.includes('m ago'))).toBe(false)
    expect(all).toContain('Usage     none yet')
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

    let all = await paneLinesAt($, 100, surface)
    for (let i = 0; i < 50 && !all.some(l => l.startsWith('Quota     claude')); i++) { await tick(); all = await paneLinesAt($, 100, surface) }
    expect(all.some(l => /^ {10}total +2 /.test(l))).toBe(true)
    expect(all).toContain('Quota     claude  5h ▰▱▱▱▱▱▱▱▱▱   5%   7d ▰▰▰▰▰▰▰▰▰▱  85%')
    expect(all.some(l => l.includes('codex'))).toBe(false)
    expect(all.includes('          unknown')).toBe(false)
    // narrow: five-cell bars, the label on its own line
    const narrow = await paneLinesAt($, 60, surface)
    expect(narrow).toContain('  claude  5h ▱▱▱▱▱   5%   7d ▰▰▰▰▱  85%')
    expect(narrow).toContain('Quota')
  })

  test(`pane Buttons are all plain, with the eleven hotkeys, each once, and no chrome, on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1000 })
    mock.store(on)
    mock.env(on, { HOME: '/h' })
    fakeSetLane(on)
    on('session.model', async () => ({ value: 'claude-haiku-5-5' }))
    on('fs.write', async () => ({ value: undefined }))
    on('session.start', async ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    await $.command.run({ command: 'spick', args: 'lane codex off', ...RUN })

    const ui = await mountPane($, surface)
    const buttons = await ui.findAll({ type: 'Button' })
    // each value of a switch is a Button of its own (routing on force off, review auto off, gate on off, guard on off, a lane on off)
    expect(buttons.map(b => b.props.key)).toEqual(['band', 'close', 'routing-on', 'routing-force', 'routing-off', 'review-auto', 'review-off', 'gate-on', 'gate-off', 'guard-on', 'guard-off',
      'lane-gemini-on', 'lane-gemini-off', 'lane-grok-on', 'lane-grok-off', 'lane-codex-on', 'lane-codex-off', 'edit-lanes', 'refresh'])
    for (const b of buttons) expect(b.props.plain).toBe(true)
    // eleven hotkeys, each once: a switch's sits on the value it moves to (routing on -> force, review auto -> off, gate on
    // -> off, guard on -> off, a lane that is on -> off, Codex, off -> on)
    const keys = buttons.map(b => b.props.hotkey as string | undefined).filter((k): k is string => k !== undefined)
    expect([...keys].sort()).toEqual(['b', 'c', 'd', 'e', 'g', 'k', 'l', 'q', 'r', 'v', 'x'])
    expect(new Set(keys).size).toBe(keys.length)
    const hotkeyOf = async (key: string) => (await ui.find({ type: 'Button', key }))?.props.hotkey
    expect(await Promise.all(['close', 'band', 'routing-force', 'review-off', 'gate-off', 'guard-off', 'lane-gemini-off', 'lane-grok-off', 'lane-codex-on', 'edit-lanes', 'refresh'].map(hotkeyOf))).toEqual(['x', 'b', 'r', 'v', 'e', 'd', 'g', 'k', 'c', 'l', 'q'])
    expect((await ui.find({ type: 'Button', key: 'close' }))?.props.role).toBe('dismiss')
    // no pills, brackets or a help line of keys
    const text = (await linesOf(ui)).join('\n')
    expect(text).not.toMatch(/[◉\[\]]/)
    expect(text).not.toMatch(/\bkeys?\b/i)
    // codex was switched off through set_lane.py: off is in force, c moves it on
    expect(await linesOf(ui)).toContain('          Codex   c: ○ on     ● off')
    // off as routing, review, the gate, the guard, Gemini, Grok, Codex draw it: only Codex's is in force, bold
    expect((await ui.findAll({ type: 'Text', text: /^off$/ })).map(t => look(t.props))).toEqual([...Array.from({ length: 6 }, () => ({ color: 'subtle' })), { bold: true, color: 'subtle' }])
  })

  test(`r cycles routing on, force, off, on; v toggles review; d toggles the guard; g k c flip the lanes; a click sets the value; the value in force is bold in its colour, on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1000 })
    mock.store(on)
    mock.env(on, { HOME: '/h' })
    fakeSetLane(on)
    on('session.model', async () => ({ value: 'claude-haiku-5-5' }))
    on('fs.write', async () => ({ value: undefined }))
    on('session.start', async ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    await $.command.run({ command: 'spick', args: 'lane codex off', ...RUN })

    const ui = await mountPane($, surface)
    const lines = async () => linesOf(ui)
    // radio buttons: ● the value in force, ○ the others; the hotkey in front of the value it moves to
    expect(await lines()).toContain('Routing      ● on  r: ○ force     ○ off')
    expect(await lines()).toContain('             routes (Haiku 5.5 session)')
    expect(await lines()).toContain('Review       ● auto  v: ○ off')
    expect(await lines()).toContain('Gate         ● on  e: ○ off')
    expect(await lines()).toContain('Guard        ● on  d: ○ off')
    expect((await lines())[0]).toMatch(/^SPICK {2}routing on · /)
    expect((await ui.find({ type: 'Text', text: 'SPICK' }))?.props).toMatchObject({ bold: true, color: 'claude' })
    const props = async (re: RegExp) => (await ui.findAll({ type: 'Text', text: re })).map(t => look(t.props))
    // the value in force bold in its own colour (on green, force and review's auto brand, off subtle), the others
    // subtle; section labels bold. on: routing's, the gate's, the guard's, Gemini's, Grok's in force, Codex's not
    expect(await props(/^on$/)).toEqual([...Array.from({ length: 5 }, () => ({ bold: true, color: 'success' })), { color: 'subtle' }])
    expect(await props(/^force$/)).toEqual([{ color: 'subtle' }])
    expect(await props(/^auto$/)).toEqual([{ bold: true, color: 'claude' }])
    expect((await props(/^off$/))[0]).toEqual({ color: 'subtle' })
    expect((await ui.find({ type: 'Text', text: 'Routing' }))?.props).toMatchObject({ bold: true })
    // the glyph is the Button's whole label, which is what a desktop draws: ● in force, ○ not
    const glyphs = async () => (await ui.findAll({ type: 'Button' })).filter(b => /^(routing|review|gate|guard|lane)-/.test(String(b.props.key))).map(b => `${String(b.props.key)} ${String(b.props.label)}`)
    expect(await glyphs()).toEqual(['routing-on ●', 'routing-force ○', 'routing-off ○', 'review-auto ●', 'review-off ○', 'gate-on ●', 'gate-off ○', 'guard-on ●', 'guard-off ○',
      'lane-gemini-on ●', 'lane-gemini-off ○', 'lane-grok-on ●', 'lane-grok-off ○', 'lane-codex-on ○', 'lane-codex-off ●'])

    // r: on -> force -> off -> on, the hotkey moving on to the next value each time
    await pressHotkey(ui, 'r')
    expect(await lines()).toContain('Routing      ○ on     ● force  r: ○ off')
    expect(await lines()).toContain('             routes (forced)')
    expect((await props(/^force$/))[0]).toEqual({ bold: true, color: 'claude' })
    expect((await props(/^on$/))[0]).toEqual({ color: 'subtle' })
    await pressHotkey(ui, 'r')
    expect(await lines()).toContain('Routing   r: ○ on     ○ force     ● off')
    expect(await lines()).toContain('             routes nothing (switched off)')
    expect((await lines())[0]).toMatch(/^SPICK {2}routing off · /)
    expect(await props(/^routing off$/)).toEqual([{ color: 'warning' }])
    expect((await props(/^off$/))[0]).toEqual({ bold: true, color: 'subtle' })
    await pressHotkey(ui, 'r')
    expect(await lines()).toContain('             routes (Haiku 5.5 session)')
    // a click sets the value it is on, wherever the hotkey sits; on the value in force it changes nothing
    await ui.press({ key: 'routing-off' })
    expect(await lines()).toContain('             routes nothing (switched off)')
    await ui.press({ key: 'routing-off' })
    expect(await lines()).toContain('             routes nothing (switched off)')
    await ui.press({ key: 'routing-on' })
    expect(await lines()).toContain('             routes (Haiku 5.5 session)')
    // v: auto <-> off
    await pressHotkey(ui, 'v')
    expect(await lines()).toContain('Review    v: ○ auto     ● off')
    expect((await props(/^off$/))[1]).toEqual({ bold: true, color: 'subtle' })
    // review's auto is the only auto now
    expect((await props(/^auto$/))[0]).toEqual({ color: 'subtle' })
    await ui.press({ key: 'review-auto' })
    expect((await props(/^auto$/))[0]).toEqual({ bold: true, color: 'claude' })
    // d: the guard on <-> off
    await pressHotkey(ui, 'd')
    expect(await lines()).toContain('Guard     d: ○ on     ● off')
    await ui.press({ key: 'guard-on' })
    expect(await lines()).toContain('Guard        ● on  d: ○ off')
    // a lane: the name a label, on and off its radio buttons, through set_lane.py
    expect(await lines()).toContain('Lanes     Gemini     ● on  g: ○ off')
    await pressHotkey(ui, 'g')
    expect(await lines()).toContain('Lanes     Gemini  g: ○ on     ● off')
    await ui.press({ key: 'lane-gemini-on' })
    expect(await lines()).toContain('Lanes     Gemini     ● on  g: ○ off')
    await pressHotkey(ui, 'c')
    expect(await lines()).toContain('          Codex      ● on  c: ○ off')

    // narrow: the label on its own line, the explanation under the values
    await ui.unmount()
    const narrow = await paneLinesAt($, 60, surface)
    expect(narrow.slice(narrow.indexOf('Routing'), narrow.indexOf('Routing') + 3)).toEqual(['Routing', '     ● on  r: ○ force     ○ off', '     routes (Haiku 5.5 session)'])
  })

  test(`the band's routing switch reads the setting and a click moves it on, on -> force -> off -> on, on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1000 })
    mock.store(on)
    on('turn.start', async ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', async ($, e) => ({ text: e.answer }))
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 0, isAborted: false, reason: 'answer', usage: USAGE })

    const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'AbovePrompt', props: BAND })
    expect(await bandOf(ui, 80)).toBe(`${head('on')}   Idle · last turn: main session`)
    // one plain Button, no hotkey (the pane's r is the pane's); a desktop draws its label: the setting
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.map(b => b.props.key)).toEqual(['band-routing'])
    expect(buttons[0]?.props).toMatchObject({ plain: true, label: 'on', dimColor: false })
    expect(buttons[0]?.props.hotkey).toBeUndefined()
    const value = async (text: string) => look((await ui.find({ type: 'Text', text: new RegExp(`^${text}$`) }))!.props)
    expect(await value('on')).toEqual({ bold: true, color: 'success', wrap: 'truncate-end' })

    // a click moves it on, as /spick on|force|off: the band and the pane both read it
    await ui.press({ key: 'band-routing' })
    expect(await bandOf(ui, 80)).toBe(`${head('force')}   Idle · last turn: main session`)
    expect(await value('force')).toEqual({ bold: true, color: 'claude', wrap: 'truncate-end' })
    expect(await paneLinesAt($, 80, surface)).toContain('Routing      ○ on     ● force  r: ○ off')
    await ui.press({ key: 'band-routing' })
    expect(await bandOf(ui, 80)).toBe(`${head('off')}   Idle · last turn: main session`)
    expect(await value('off')).toEqual({ bold: true, color: 'subtle', wrap: 'truncate-end' })
    // routing off: drawn dim as well, since a desktop draws the label without its colour
    expect((await ui.find({ type: 'Button', key: 'band-routing' }))?.props).toMatchObject({ label: 'off', dimColor: true })
    await ui.press({ key: 'band-routing' })
    expect(await bandOf(ui, 80)).toBe(`${head('on')}   Idle · last turn: main session`)

    // a narrow band keeps the switch; the sentence gives way around it
    const narrow = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'AbovePrompt', props: { ...BAND, bodyColumns: 36 } })
    const line = await bandOf(narrow, 36)
    expect(line.startsWith(head('on'))).toBe(true)
    expect(line.length).toBeLessThanOrEqual(36)
  })

  test(`on, on a model that is not Haiku, reads on (not Haiku) on the band, the note in the warning colour, drawn dim, on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1000 })
    mock.store(on)
    on('session.model', async () => ({ value: 'claude-opus-5-5' }))
    on('fs.write', async () => ({ value: undefined }))
    on('session.start', async ($, e) => ({ cwd: e.cwd }))
    on('turn.start', async ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', async ($, e) => ({ text: e.answer }))
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 0, isAborted: false, reason: 'answer', usage: USAGE })

    const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'AbovePrompt', props: BAND })
    expect(await bandOf(ui, 80)).toMatch(new RegExp(`^${head('on')} \\(not Haiku\\) {3}Idle · last turn: `))
    expect((await ui.find({ type: 'Text', text: ' (not Haiku)' }))?.props).toMatchObject({ color: 'warning' })
    expect((await ui.find({ type: 'Button', key: 'band-routing' }))?.props).toMatchObject({ label: 'on', dimColor: true })
    // the Button holds the value alone; the note is drawn beside it, not inside it
    const routingButton = (await ui.find({ type: 'Button', key: 'band-routing' }))!
    expect(routingButton.children.map(c => inlineText(c, 80))).toEqual(['on'])
    expect((routingButton.children[0] as Exclude<Drawn, string>).type).toBe('Text')
    expect(routingButton.children.map(c => inlineText(c, 80)).join('')).not.toContain(' (not Haiku)')
    // the wordmark does not say off as well
    expect((await ui.findAll({ type: 'Text', text: /^ off$/ }))).toEqual([])
    // force routes here: no note, not dim
    await ui.press({ key: 'band-routing' })
    expect(await bandOf(ui, 80)).toMatch(new RegExp(`^${head('force')} {3}Idle · last turn: `))
    expect((await ui.find({ type: 'Button', key: 'band-routing' }))?.props).toMatchObject({ label: 'force', dimColor: false })
  })

  test(`before the first turn the band is the wordmark and the switch, on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1000 })
    mock.store(on)
    const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'AbovePrompt', props: BAND })
    expect(await bandOf(ui, 80)).toBe(head('on'))
    await ui.press({ key: 'band-routing' })
    expect(await bandOf(ui, 80)).toBe(head('force'))
  })
}

// --- many concurrent subagents ------------------------------------------------

const bgCall = (id: string, subagent_type = 'coder') =>
  ({ tool: 'Agent' as const, tool_use_id: id, prompt: 'p', description: 'd', run_in_background: true, subagent_type, model: 'sonnet' as const })
const bgSpawn = (id: string) =>
  ({ tool_use_id: id, prompt: 'p', description: 'd', subagentType: 'coder', provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'claude-opus-5-5', background: true, fork: false })
const SUB_DONE = { answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' as const, usage: USAGE }

function agentHooks(on: Parameters<TestBody>[1]) {
  const clock = mock.clock(on, { now: 1000 })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('agent.spawn', async (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `a-${e.tool_use_id}` }))
  on('tool.call', async () => ({ result: {} as never }))
  on('prompt.submit', async (_$, e) => ({ text: e.text, context: e.context }))
  return clock
}

/** n background coders, one second apart, then the main turn completes; the clock ends at 1000 + n * 1000 */
async function spawnCoders($: Engine, clock: { advance: (ms: number) => Promise<void> }, n: number) {
  await $.turn.start({ text: 'go', turnId: 't1' })
  for (let i = 1; i <= n; i++) {
    await clock.advance(1000)
    await $.tool.call(bgCall(`bg${i}`))
    await $.agent.spawn(bgSpawn(`bg${i}`))
  }
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 0, isAborted: false, reason: 'answer', usage: USAGE })
}

const bandLine = async ($: Engine) => {
  const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface: 'terminal', component: 'AbovePrompt', props: WIDE })
  const line = await bandOf(ui, WIDE.bodyColumns)
  await ui.unmount()
  return line
}
// The band fits its columns with the switch's frame counted. The test tools cannot measure a native desktop
// Button's width: BAND_BUTTON_CHROME stands in for it, so this checks the reservation, not the desktop's paint.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`a working coder's band fits 36 and 60 columns with the switch's frame counted, on ${surface}`, async ($, on) => {
    const clock = agentHooks(on)
    await spawnCoders($, clock, 1)
    await clock.advance(4000)
    await $.tool.call({ tool: 'Read' as const, tool_use_id: 'r1', file_path: '/repo/a.py' })
    for (const columns of [36, 60]) {
      const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface, component: 'AbovePrompt', props: { ...BAND, bodyColumns: columns } })
      const line = await bandOf(ui, columns)
      await ui.unmount()
      expect(line).toContain('coder')
      expect(line.length + BAND_BUTTON_CHROME[surface]).toBeLessThanOrEqual(columns)
    }
  })
}

const paneTexts = async ($: Engine) => paneLinesAt($, 80)
const hasRunning = (lines: string[]) => lines.some(l => l.startsWith('Running'))

test('the band shows the main loop\'s last prompt size; a Haiku session past 80k gets the warning, active and idle; Sonnet never', async ($, on) => {
  mock.clock(on, { now: 1000 })
  let promptSize = 0
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const,
      usage: { model: e.model, input_tokens: 200, output_tokens: 50, cache_read_input_tokens: promptSize - 1200, cache_creation_input_tokens: 1000 } }
  })
  const W = { ...BAND, bodyColumns: 120 }
  const band = async () => {
    const ui = await $.ui.mount({ plugin: 'spick-dashboard', surface: 'terminal', component: 'AbovePrompt', props: W })
    const line = await bandOf(ui, W.bodyColumns)
    await ui.unmount()
    return line
  }
  const step = async (id: string, model: string, size: number) => {
    promptSize = size
    for await (const _ of $.turn.step({ turnId: id, index: 0, model, effort: 'medium', messageCount: 1 })) { /* drain */ }
  }
  await $.turn.start({ text: 'go', turnId: 't1' })
  await step('t1', 'claude-haiku-5-5', 42_000)
  expect(await band()).toContain('ctx 42k')
  expect(await band()).not.toContain('Haiku bills')
  await step('t1', 'claude-haiku-5-5', 85_000)
  const hot = await band()
  expect(hot).toContain('ctx 85k')
  expect(hot).toMatch(/context 85k: Haiku bills 5x above 100k; \/clear or delegate$/)
  // idle after the turn: the warning stays where the user decides on /clear
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer', usage: USAGE })
  expect(await band()).toContain('context 85k: Haiku bills 5x above 100k')
  // the same size on Sonnet: the size, no warning
  await $.turn.start({ text: 'go', turnId: 't2' })
  await step('t2', 'claude-sonnet-5-5', 150_000)
  const sonnet = await band()
  expect(sonnet).toContain('ctx 150k')
  expect(sonnet).not.toContain('Haiku bills')
})

test('12 concurrent coders: the band reads coder ×12 with the oldest one\'s time; the pane lists 5 rows and "and 7 more"', async ($, on) => {
  const clock = agentHooks(on)
  await spawnCoders($, clock, 12)
  await clock.advance(190_000)
  await $.tool.call({ tool: 'Read' as const, tool_use_id: 'r1', file_path: '/repo/a.py' })   // a tick: the clock is now 203000

  // the oldest coder began at 2000: 201s
  const line = await bandLine($)
  expect(line.startsWith('SPICK on   coder ×12 working · Sonnet 5.5 · 3m 21s')).toBe(true)
  expect(line).not.toContain('agent ')
  expect(line).not.toContain('Idle')

  const all = await paneTexts($)
  expect(hasRunning(all)).toBe(true)
  const rows = all.filter(l => /^(Running {3}| {10})coder +Sonnet 5\.5 +\d+m \d+s$/.test(l))
  expect(rows).toHaveLength(5)
  expect(rows[0]).toBe('Running   coder  Sonnet 5.5  3m 21s')
  expect(rows[4]).toBe('          coder  Sonnet 5.5  3m 17s')
  expect(all).toContain('          and 7 more')
  // the section sits between Lanes and Usage, set apart by a blank line each side
  const at = all.indexOf(rows[0]!)
  expect(all[at - 1]).toBe('')
  expect(all.findIndex(l => l.startsWith('Lanes'))).toBeLessThan(at)
  expect(all.findIndex(l => l.startsWith('Usage'))).toBeGreaterThan(at + 5)
})

test('one background coder: the band reads exactly as before (no ×1), the pane has one row and no "more"', async ($, on) => {
  const clock = agentHooks(on)
  await spawnCoders($, clock, 1)
  await clock.advance(4000)
  await $.tool.call({ tool: 'Read' as const, tool_use_id: 'r1', file_path: '/repo/a.py' })

  expect(await bandLine($)).toMatch(/^SPICK on {3}coder is working · Sonnet 5\.5 · 5s +\/spick for details$/)
  const all = await paneTexts($)
  expect(hasRunning(all)).toBe(true)
  expect(all.filter(l => /^Running {3}coder +Sonnet 5\.5 +4s$/.test(l))).toHaveLength(1)
  expect(all.some(l => l.trim().startsWith('and '))).toBe(false)
})

test('the pane has no Running section while nothing runs, and loses it when the last agent finishes', async ($, on) => {
  const clock = agentHooks(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(hasRunning(await paneTexts($))).toBe(false)
  await spawnCoders($, clock, 1).catch(() => undefined)
  expect(hasRunning(await paneTexts($))).toBe(true)
  await $.turn.complete({ turnId: 'sub', agentId: 'a-bg1', ...SUB_DONE })
  expect(hasRunning(await paneTexts($))).toBe(false)
  expect(await bandLine($)).toContain('Idle')
})

test('a subagent with no completion signal for 30 minutes leaves the running state, reads "timed out" in the pane, and goes at the next prompt', async ($, on) => {
  const clock = agentHooks(on)
  await spawnCoders($, clock, 1)
  await clock.advance(29 * 60_000)
  await $.tool.call({ tool: 'Read' as const, tool_use_id: 'r1', file_path: '/repo/a.py' })
  // 29 minutes: still running
  expect(await bandLine($)).toContain('coder is working')

  await clock.advance(2 * 60_000)
  await $.tool.call({ tool: 'Read' as const, tool_use_id: 'r2', file_path: '/repo/a.py' })
  // 31 minutes: off the band, on in the pane with the reason
  expect(await bandLine($)).toContain('Idle')
  let all = await paneTexts($)
  expect(hasRunning(all)).toBe(true)
  expect(all).toContain('Running   coder  Sonnet 5.5  timed out, no completion signal')

  // the next prompt drops it
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  all = await paneTexts($)
  expect(hasRunning(all)).toBe(false)
  expect(all.some(t => t.includes('timed out'))).toBe(false)
})

test('a subagent that finishes after its timeout loses its "timed out" row', async ($, on) => {
  const clock = agentHooks(on)
  await spawnCoders($, clock, 1)
  await clock.advance(31 * 60_000)
  await $.tool.call({ tool: 'Read' as const, tool_use_id: 'r1', file_path: '/repo/a.py' })
  expect((await paneTexts($)).some(t => t.includes('timed out'))).toBe(true)
  await $.turn.complete({ turnId: 'sub', agentId: 'a-bg1', ...SUB_DONE })
  expect((await paneTexts($)).some(t => t.includes('timed out'))).toBe(false)
})

// --- the pane at 80 columns, against the design's example ---------------------------------------------------------------

const EXAMPLE_80 = [
  'SPICK  routing on · b: band shown                                     x: close',
  '',
  'Routing      ● on  r: ○ force     ○ off',
  '             routes (Haiku 5.5 session)',
  'Review       ● auto  v: ○ off',
  'Gate         ● on  e: ○ off',
  'Guard        ● on  d: ○ off',
  '',
  'Lanes     Gemini     ● on  g: ○ off',
  '          Grok       ● on  k: ○ off',
  '          Codex      ● on  c: ○ off',
  '          l: edit lanes · every field, every declared lane',
  '',
  'Usage                   turns  at API rates',
  '          main session     52         $0.45',
  '          coder            13         $9.39',
  '          planner           4         $3.79',
  '          deep              1         $0.46',
  '          total            70        $14.09',
  '',
  'Quota     claude  5h ▰▰▱▱▱▱▱▱▱▱  19%   7d ▰▱▱▱▱▱▱▱▱▱   9%',
  '          codex   7d ▰▰▰▰▰▰▰▰▱▱  80%',
  '          q: refresh · read just now',
  '',
  'Recent    14:52  coder         Sonnet 5.5  high    3m 41s',
  '          14:47  main session  Haiku 5.5   low         6s',
  '          14:40  planner       Opus 5.5    high     2m 5s',
  // the duration column is right-aligned to the widest value (six characters); the design's sketch of this row is one column off
  '          14:31  deep          Opus 5.5    high    1m 52s',
  '          14:22  coder         Sonnet 5.5  medium  4m 10s',
]

const HAIKU = 'claude-haiku-5-5'
const free = (model: string) => ({ model, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
const big = (model: string, input_tokens: number) => ({ ...free(model), input_tokens })
const localTime = (h: number, m: number) => new Date(2026, 9, 14, h, m).getTime()

/**
 * Five main turns (the Recent rows), then the extra completes that bring the lane totals to the design's figures,
 * the quota files, and /spick to read the lanes: everything the design's example pane shows.
 */
async function exampleWorld($: Engine, on: Parameters<TestBody>[1], tags = true) {
  const clock = mock.clock(on, { now: localTime(14, 22) })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  const rows = LANE_ROWS.map(r => (r.id === 'gemini' ? { ...r, tags: ['search', 'long-context', 'multimodal', 'image'] }
    : r.id === 'codex' ? { ...r, tags: ['code', 'review', 'image'] } : r))
  fakeSetLane(on, tags ? rows : LANE_ROWS.map(r => ({ ...r, tags: [] })))
  const claudeJson = JSON.stringify({ cachedUsageUtilization: { utilization: { five_hour: { utilization: 19 }, seven_day: { utilization: 9 } } } })
  const codexLine = JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 80, window_minutes: 10080 } } } })
  const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 1, mtimeMs: 1, isLink: false })
  on('fs.read', async (_$, e) => ({ value: e.path === '/h/.claude.json' ? claudeJson : codexLine }))
  on('fs.list', async (_$, e) => {
    const depth = e.path.split('/').length - '/h/.codex/sessions'.split('/').length
    return { value: depth < 3 ? [entry(String(depth), 'dir')] : [entry('s.jsonl', 'file')] }
  })
  on('fs.write', async () => ({ value: undefined }))
  on('session.model', async () => ({ value: HAIKU }))
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('tool.call', async () => ({ result: {} as never }))
  on('agent.spawn', async (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `a-${e.tool_use_id}` }))

  let now = localTime(14, 22)
  let n = 0
  /** one main turn at hh:mm that lasts `ms`; a delegate takes the row (its lane, model and effort), else the main session does */
  const turn = async (h: number, m: number, ms: number, delegate?: { type: string; model: 'sonnet' | 'opus'; effort: 'medium' | 'high' }, main?: { effort: 'low' }) => {
    await clock.advance(localTime(h, m) - now)
    now = localTime(h, m)
    const id = `t${++n}`
    await $.turn.start({ text: 'go', turnId: id })
    for await (const _ of $.turn.step({ turnId: id, index: 0, model: HAIKU, effort: main?.effort ?? 'medium', messageCount: 1 })) { /* drain */ }
    if (delegate) {
      await $.tool.call({ tool: 'Agent' as const, tool_use_id: `ag${n}`, prompt: 'p', description: 'd', run_in_background: false, subagent_type: delegate.type, model: delegate.model, effort: delegate.effort })
    }
    await clock.advance(ms)
    now += ms
    await $.turn.complete({ turnId: id, answer: 'ok', durationMs: ms, isAborted: false, reason: 'answer', usage: free(HAIKU) })
  }
  await turn(14, 22, 250_000, { type: 'coder', model: 'sonnet', effort: 'medium' })
  await turn(14, 31, 112_000, { type: 'deep', model: 'opus', effort: 'high' })
  await turn(14, 40, 125_000, { type: 'planner', model: 'opus', effort: 'high' })
  await turn(14, 47, 6_000, undefined, { effort: 'low' })
  await turn(14, 52, 221_000, { type: 'coder', model: 'sonnet', effort: 'high' })

  // the rest of the lane totals: main session 52 turns in all (5 above), coder 13, planner 4, deep 1
  const done = { answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' as const }
  for (let i = 0; i < 46; i++) await $.turn.complete({ turnId: 'x', ...done, usage: free(HAIKU) })
  await $.turn.complete({ turnId: 'x', ...done, usage: big(HAIKU, 4_500_000) })       // $0.45
  const sub = async (type: string, usages: ReturnType<typeof free>[]) => {
    // an agent's lane is forgotten when it completes: one spawn per completion
    for (const [i, usage] of usages.entries()) {
      await $.agent.spawn({ tool_use_id: `sp-${type}-${i}`, prompt: 'p', description: 'd', subagentType: type, provider: { plugin: 'engine', tier: 'core' as const }, parentModel: HAIKU, background: false, fork: false })
      await $.turn.complete({ turnId: 'sub', agentId: `a-sp-${type}-${i}`, ...done, usage })
    }
  }
  await sub('coder', [...Array.from({ length: 12 }, () => free('claude-sonnet-5-5')), big('claude-sonnet-5-5', 4_695_000)])   // $9.39
  await sub('planner', [...Array.from({ length: 3 }, () => free('claude-opus-5-5')), big('claude-opus-5-5', 947_500)])           // $3.79
  await sub('deep', [big('claude-opus-5-5', 115_000)])                                                                          // $0.46
  // /spick reads the quota and the lanes; the pane is not placed (no surface in the test), the state is what counts
  await $.command.run({ command: 'spick', args: '', ...RUN })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane at 80 columns reads exactly as the design's example on ${surface}`, async ($, on) => {
    await exampleWorld($, on)
    const ui = await mountPane($, surface, 80, 40)
    const lines = await linesOf(ui)
    expect(lines).toEqual(EXAMPLE_80)
    // colours: SPICK, the selected value and a lane that is on in brand bold; the rest subtle
    expect((await ui.find({ type: 'Text', text: 'SPICK' }))?.props).toMatchObject({ bold: true, color: 'claude' })
    // on: routing's, the gate's, the guard's and the three lanes', all in force
    expect((await ui.findAll({ type: 'Text', text: /^on$/ })).map(t => look(t.props))).toEqual(Array.from({ length: 6 }, () => ({ bold: true, color: 'success' })))
    // no tags on the main pane: the lanes page lists them
    expect(await ui.find({ type: 'Text', text: /x-data/ })).toBeUndefined()
    // the column heads are cells of their own, subtle
    for (const head of [/^turns$/, /^at API rates$/]) expect((await ui.find({ type: 'Text', text: head }))?.props).toMatchObject({ color: 'subtle' })
    expect((await ui.find({ type: 'Text', text: 'Usage' }))?.props).toMatchObject({ bold: true })
    expect((await ui.find({ type: 'Text', text: 'routing on' }))?.props).toMatchObject({ color: 'subtle' })
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(78)
  })
}

test('the pane at 45 columns keeps every line inside 43 columns, with the label on its own line, five-cell bars and no effort column', async ($, on) => {
  await exampleWorld($, on)
  const lines = await paneLinesAt($, 45)
  for (const l of lines) expect(l.length).toBeLessThanOrEqual(43)
  for (const label of ['Routing', 'Review', 'Lanes', 'Usage', 'Quota', 'Recent']) expect(lines).toContain(label)
  expect(lines).toContain('  Gemini     ● on  g: ○ off')
  expect(lines).toContain('  claude  5h ▰▱▱▱▱  19%   7d ▱▱▱▱▱   9%')
  const at = lines.indexOf('Recent')
  expect(lines.slice(at + 1)).toEqual([
    '  14:52  coder         Sonnet 5.5  3m 41s',
    '  14:47  main session  Haiku 5.5       6s',
    '  14:40  planner       Opus 5.5     2m 5s',
    '  14:31  deep          Opus 5.5    1m 52s',
    '  14:22  coder         Sonnet 5.5  4m 10s',
  ])
})

test('eight turns show five Recent rows on a narrow pane, all eight that fit on a wide one', async ($, on) => {
  const clock = mock.clock(on, { now: localTime(10, 0) })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  for (let i = 0; i < 8; i++) {
    await $.turn.start({ text: 'go', turnId: `t${i}` })
    await clock.advance(60_000)
    await $.turn.complete({ turnId: `t${i}`, answer: 'ok', durationMs: 60_000, isAborted: false, reason: 'answer', usage: free(HAIKU) })
  }
  const count = (lines: string[]) => lines.filter(l => /\d\d:\d\d {2}main session/.test(l)).length
  expect(count(await paneLinesAt($, 45))).toBe(5)
  expect(count(await paneLinesAt($, 80))).toBe(8)
})

// --- lane switches and the lanes page: spick.json is written by set_lane.py, nothing here runs a process while drawing ---

const LANE_PANE = { plugin: 'spick-dashboard', component: 'Pane' as const, requestId: 'spick', props: PANE, viewport: { columns: 82, rows: 30 } }
const lanesWorld = (on: Parameters<TestBody>[1], rows?: Parameters<typeof fakeSetLane>[1]) => {
  mock.clock(on, { now: 1000 })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  const closes: string[] = []
  const toasts: string[] = []
  on('ui.close', async (_$, e) => { closes.push(e.id); return { value: undefined } })
  on('ui.toast', async (_$, e) => { toasts.push(e.text); return { value: undefined } })
  return { fake: fakeSetLane(on, rows), closes, toasts }
}
const WRITE = (id: string, field: string, value: string) => ['python3', SCRIPT, '--id', id, '--field', field, '--value', value]

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a Controls lane button writes enabled through set_lane.py, then reads the lanes again, on ${surface}`, async ($, on) => {
    const { fake, toasts } = lanesWorld(on)
    const ui = await $.ui.mount({ ...LANE_PANE, surface })
    // drawing ran no process
    expect(fake.calls).toEqual([])
    const button = async (key: string) => (await ui.find({ type: 'Button', key }))?.props
    // on in force (not read yet: on), k on the off Button
    expect(await button('lane-grok-off')).toMatchObject({ plain: true, hotkey: 'k' })
    expect(await button('lane-grok-on')).toMatchObject({ plain: true })
    expect((await button('lane-grok-on'))?.hotkey).toBeUndefined()
    expect(await linesOf(ui)).toContain('          Grok       ● on  k: ○ off')

    await ui.press({ key: 'lane-grok-off' })
    expect(fake.calls).toEqual([['python3', SCRIPT, '--list'], WRITE('grok', 'enabled', 'no'), ['python3', SCRIPT, '--list']])
    expect(fake.rows.find(r => r.id === 'grok')?.enabled).toBe(false)
    expect(await linesOf(ui)).toContain('          Grok    k: ○ on     ● off')
    // a click on the value in force runs nothing
    const calls = fake.calls.length
    await ui.press({ key: 'lane-grok-off' })
    expect(fake.calls).toHaveLength(calls)
    await ui.press({ key: 'lane-grok-on' })
    expect(fake.writes().at(-1)).toEqual(WRITE('grok', 'enabled', 'yes'))
    expect(await linesOf(ui)).toContain('          Grok       ● on  k: ○ off')
    expect(toasts).toEqual([])
  })

  test(`a refused Controls toggle toasts the first stderr line and leaves the row as it was on ${surface}`, async ($, on) => {
    const { fake, toasts } = lanesWorld(on, [{ id: 'gemini', name: 'Gemini', enabled: true, tags: [], data: null, notes: null, kind: null }])
    const ui = await $.ui.mount({ ...LANE_PANE, surface })
    await ui.press({ key: 'lane-codex-off' })
    expect(fake.writes()).toEqual([WRITE('codex', 'enabled', 'no')])
    expect(toasts).toEqual(['spick: set_lane: unknown lane id codex; to add a new lane use add_lane.py'])
    expect(await linesOf(ui)).toContain('          Codex      ● on  c: ○ off')
  })

  test(`every Button on the main pane is plain with its own hotkey, l opens the lanes page, drawing runs no process, on ${surface}`, async ($, on) => {
    const { fake } = lanesWorld(on)
    const ui = await $.ui.mount({ ...LANE_PANE, surface })
    const buttons = await ui.findAll({ type: 'Button' })
    // band, close, routing's three, review's two, the gate's two, the guard's two, each lane's two, edit lanes, refresh
    expect(buttons).toHaveLength(19)
    for (const b of buttons) expect(b.props.plain).toBe(true)
    const keys = buttons.map(b => b.props.hotkey).filter(Boolean)
    expect([...keys].sort()).toEqual(['b', 'c', 'd', 'e', 'g', 'k', 'l', 'q', 'r', 'v', 'x'])
    expect(new Set(keys).size).toBe(keys.length)
    expect(await ui.find({ type: 'Button', key: 'edit-lanes' })).toMatchObject({ props: { plain: true, hotkey: 'l' } })
    // the Edit lanes row is the last row of the Lanes section
    expect(await linesOf(ui)).toContain('          l: edit lanes · every field, every declared lane')
    expect(fake.calls).toEqual([])

    await ui.press({ key: 'edit-lanes' })
    expect(fake.calls).toEqual([['python3', SCRIPT, '--list']])
    expect((await linesOf(ui))[0]).toMatch(/^SPICK {2}lanes +back {2}close$/)
    expect(await ui.find({ type: 'Button', key: 'routing-on' })).toBeUndefined()
    // redrawing the page ran nothing more
    await ui.find({ type: 'Button', key: 'back' })
    expect(fake.calls).toHaveLength(1)
  })

  test(`the lanes page lists every lane, disabled ones too; no Button has a hotkey; Back returns, on ${surface}`, async ($, on) => {
    const { fake } = lanesWorld(on)
    fake.rows.find(r => r.id === 'codex')!.enabled = false
    const ui = await $.ui.mount({ ...LANE_PANE, surface })
    await ui.press({ key: 'edit-lanes' })
    const lines = await linesOf(ui)
    expect(lines[0]).toBe('SPICK  lanes' + ' '.repeat(80 - 2 - 23) + 'back  close')
    // the table: the section label and the subtle column heads share a row, the lanes sit under the heads
    expect(lines.some(l => /^Lanes {5}lane +tags +data +enabled$/.test(l))).toBe(true)
    for (const head of [/^lane$/, /^tags$/, /^data$/, /^enabled$/]) expect((await ui.find({ type: 'Text', text: head }))?.props).toMatchObject({ color: 'subtle' })
    expect(lines.some(l => /^ {10}gemini +search +public +yes$/.test(l))).toBe(true)
    expect(lines.some(l => /^ {10}grok +x-data +public +yes$/.test(l))).toBe(true)
    expect(lines.some(l => /^ {10}codex +code +code +no$/.test(l))).toBe(true)
    expect(lines.some(l => /^ {10}openrouter +gateway +text +yes$/.test(l))).toBe(true)
    // the Edit row holds the Input, the field help takes two subtle lines
    const edit = lines.findIndex(l => l.startsWith('Edit      > '))
    expect(edit).toBeGreaterThan(-1)
    expect(lines.slice(edit + 1, edit + 3)).toEqual([
      ' '.repeat(10) + 'name tags data enabled notes kind base_url api model max_tokens',
      ' '.repeat(10) + 'key_ref meter_type meter_preset health_url · enabled yes|no',
    ])
    expect((await ui.find({ type: 'Text', text: /^name tags data/ }))?.props).toMatchObject({ color: 'subtle' })
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.map(b => b.props.key)).toEqual(['back', 'close'])
    for (const b of buttons) expect(b.props).toMatchObject({ plain: true }), expect(b.props.hotkey).toBeUndefined()
    expect(await ui.find({ type: 'Input' })).toBeDefined()
    expect(lines).not.toContain('To change a lane, type /spick lane <lane> <field> <value> in the prompt.')

    await ui.press({ key: 'back' })
    expect((await linesOf(ui)).some(l => l.startsWith('Routing      ● on  r: '))).toBe(true)
    expect(await linesOf(ui)).toContain('          Codex   c: ○ on     ● off')
  })

  test(`typing in the lanes page Input does not press anything: x does not close the pane, on ${surface}`, async ($, on) => {
    const { fake, closes } = lanesWorld(on)
    const ui = await $.ui.mount({ ...LANE_PANE, surface })
    await ui.press({ key: 'edit-lanes' })
    for (const ch of ['x', 'l', 'g', 'b']) await ui.input({ key: 'lane-edit-0', text: ch, kind: 'change' })
    expect(closes).toEqual([])
    expect(fake.writes()).toEqual([])
    expect(await ui.find({ type: 'Button', key: 'close' })).toBeDefined()
    expect(await ui.find({ type: 'Input', key: 'lane-edit-0' })).toBeDefined()
    // Close still closes
    await ui.press({ key: 'close' })
    expect(closes).toEqual(['spick'])
  })

  test(`the Input applies "<lane> <field> <value>" through set_lane.py and shows the Changed or Refused line on ${surface}`, async ($, on) => {
    const { fake } = lanesWorld(on)
    const ui = await $.ui.mount({ ...LANE_PANE, surface })
    await ui.press({ key: 'edit-lanes' })
    const texts = async () => linesOf(ui)

    await ui.input({ key: 'lane-edit-0', text: 'openrouter tags gateway,cheap' })
    expect(fake.writes()).toEqual([WRITE('openrouter', 'tags', 'gateway,cheap')])
    let all = await texts()
    expect(all).toContain('Changed   openrouter tags: gateway -> gateway,cheap. Backup: spick.json.bak.')
    expect(all.some(t => /^ {10}openrouter +gateway, cheap +text +yes$/.test(t))).toBe(true)
    expect(all.some(l => l.startsWith('Refused'))).toBe(false)
    // the field was cleared: a new Input stands in its place
    expect(await ui.find({ type: 'Input', key: 'lane-edit-0' })).toBeUndefined()
    expect(await ui.find({ type: 'Input', key: 'lane-edit-1' })).toBeDefined()

    // a refusal keeps the last good change, shows the first stderr line in the error colour, and keeps the text in the field
    await ui.input({ key: 'lane-edit-1', text: 'nope tags a' })
    all = await texts()
    expect(all).toContain('Refused   set_lane: unknown lane id nope; to add a new lane use add_lane.py')
    expect((await ui.find({ type: 'Text', text: /^set_lane: unknown lane id nope/ }))?.props).toMatchObject({ color: 'error' })
    expect(all).toContain('Changed   openrouter tags: gateway -> gateway,cheap. Backup: spick.json.bak.')
    expect(await ui.find({ type: 'Input', key: 'lane-edit-1' })).toBeDefined()
    // text that is not "<lane> <field> <value>" never reaches the script
    const writes = fake.writes().length
    await ui.input({ key: 'lane-edit-1', text: 'openrouter' })
    expect(await texts()).toContain('Refused   type <lane> <field> <value>')
    expect(fake.writes()).toHaveLength(writes)
    // on|off works here too; notes keep their case
    await ui.input({ key: 'lane-edit-1', text: 'openrouter off' })
    expect(fake.writes().at(-1)).toEqual(WRITE('openrouter', 'enabled', 'no'))
    await ui.input({ key: 'lane-edit-2', text: 'grok notes Keep Case Here' })
    expect(fake.writes().at(-1)).toEqual(WRITE('grok', 'notes', 'Keep Case Here'))
  })

  test(`the lanes page fits 80 columns, long ids and tag lists included, on ${surface}`, async ($, on) => {
    const long = { id: 'a-very-long-lane-identifier-in-use', name: 'Long', enabled: true, tags: ['alpha-tag', 'bravo-tag', 'charlie-tag', 'delta-tag', 'echo-tag', 'foxtrot-tag', 'golf-tag', 'hotel-tag'], data: null, notes: null, kind: 'relay' }
    const { fake } = lanesWorld(on, [...LANE_ROWS, long])
    const ui = await $.ui.mount({ ...LANE_PANE, surface, props: { ...PANE, bodyColumns: 80 }, viewport: { columns: 80, rows: 30 } })
    await ui.press({ key: 'edit-lanes' })
    await ui.input({ key: 'lane-edit-0', text: 'openrouter tags gateway,cheap' })
    const lines = await linesOf(ui)
    // 80 columns less the pane's one-column padding on each side
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(78)
    expect(lines.some(l => l.startsWith(' '.repeat(10) + 'a-very-long-lan…') && l.includes('+') && /unset +yes$/.test(l))).toBe(true)
    expect(fake.rows).toHaveLength(5)
  })

  test(`the lanes page on a narrow pane puts labels on their own line and keeps every line inside 43 columns on ${surface}`, async ($, on) => {
    const { fake } = lanesWorld(on)
    fake.rows.push({ id: 'a-very-long-lane-identifier-in-use', name: 'Long', enabled: true, tags: ['alpha-tag', 'bravo-tag', 'charlie-tag'], data: null, notes: null, kind: 'relay' })
    const ui = await $.ui.mount({ ...LANE_PANE, surface, props: { ...PANE, bodyColumns: 45 }, viewport: { columns: 45, rows: 40 } })
    await ui.press({ key: 'edit-lanes' })
    await ui.input({ key: 'lane-edit-0', text: 'openrouter tags gateway,cheap' })
    await ui.input({ key: 'lane-edit-1', text: 'nope tags a' })
    const lines = await linesOf(ui, 45)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(43)
    for (const label of ['Lanes', 'Edit', 'Changed', 'Refused']) expect(lines).toContain(label)
    expect(lines.some(l => /^ {2}lane +tags +data +on$/.test(l))).toBe(true)
  })
}

test('on mobile the lanes page has no Input, only the line that says what to type; its Buttons have no hotkeys either', async ($, on) => {
  const { fake } = lanesWorld(on)
  const ui = await $.ui.mount({ ...LANE_PANE, surface: 'mobile' })
  await ui.press({ key: 'edit-lanes' })
  expect(await ui.findAll({ type: 'Input' })).toEqual([])
  const lines = await linesOf(ui)
  expect(lines).toContain('Edit      To change a lane, type /spick lane <lane> <field> <value> in the prompt.')
  expect(lines.some(l => /^ {10}gemini +search +public +yes$/.test(l))).toBe(true)
  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.map(b => b.props.key)).toEqual(['back', 'close'])
  for (const b of buttons) expect(b.props.hotkey).toBeUndefined()
  expect(fake.writes()).toEqual([])
})
