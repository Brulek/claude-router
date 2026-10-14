// Generates the README art as SVG from the mod's real band and table code.
// Run from the repo root: node --experimental-strip-types docs/images/make-art.mts
// (Node 22.6+). checklist.ts is imported without an extension elsewhere, so the pane
// text below is hard-coded to match what the mod shows.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { bandSegments, quotaCells, recentLines, tagLine, usageLines, HOTKEY_W, LABEL_W, MAIN_LANE } from '../../mod/spick-dashboard/hooks/format.ts'
import type { BandView, Seg } from '../../mod/spick-dashboard/hooks/format.ts'

const OUT = fileURLToPath(new URL('.', import.meta.url))
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif'
const C = { bg: '#0d1117', line: '#30363d', text: '#e6edf3', subtle: '#8b949e', brand: '#d77757', warning: '#d29922', error: '#f85149', well: '#010409', panel: '#161b22' }
const CELL = 9 // monospace column width in px at 15px font size
const X0 = 24
const gx = (col: number) => X0 + col * CELL

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const num = (n: number) => String(Math.round(n * 100) / 100)

type Style = { fill: string; bold?: boolean }
const styleOf = (s: Seg['style']): Style => {
  switch (s) {
    case 'brand': return { fill: C.brand, bold: true }
    case 'lane': return { fill: C.text, bold: true }
    case 'dim': return { fill: C.subtle }
    case 'warning': return { fill: C.warning }
    case 'error': return { fill: C.error }
    default: return { fill: C.text }
  }
}

/** one monospace run on the grid: leading spaces move the column, text is trimmed */
function mono(col: number, y: number, text: string, st: Style, size = 15): string {
  const lead = text.length - text.trimStart().length
  const t = text.trim()
  if (!t) return ''
  return `<text x="${gx(col + lead)}" y="${y}" font-family='${MONO}' font-size="${size}" fill="${st.fill}"${st.bold ? ' font-weight="700"' : ''} xml:space="preserve">${esc(t)}</text>`
}

const widthOf = (segs: Seg[]) => segs.reduce((n, s) => n + [...s.text].length, 0)

/** a band line: left group from column 0, right group ending at `columns` */
function band(v: BandView, columns: number, y: number): { svg: string; plain: string } {
  const { left, right } = bandSegments(v, columns)
  const out: string[] = []
  let col = 0
  for (const s of left) { out.push(mono(col, y, s.text, styleOf(s.style))); col += [...s.text].length }
  let plain = left.map(s => s.text).join('')
  if (right.length) {
    col = columns - widthOf(right)
    for (const s of right) { out.push(mono(col, y, s.text, styleOf(s.style))); col += [...s.text].length }
    plain = plain.padEnd(columns - widthOf(right)) + right.map(s => s.text).join('')
  }
  return { svg: out.join(''), plain }
}

const card = (w: number, h: number) => `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="${C.bg}" stroke="${C.line}"/>`
const wrap = (w: number, h: number, title: string, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">\n<title>${esc(title)}</title>\n${card(w, h)}\n${body}\n</svg>\n`

const COLUMNS = 90
const views: { caption: string; view: BandView }[] = [
  { caption: 'main session working', view: { lane: MAIN_LANE, model: 'Haiku 5.5', agents: 0, isIdle: false, durationMs: 12_000 } },
  { caption: 'subagent', view: { lane: 'coder', model: 'Sonnet 5.5', agents: 1, isIdle: false, durationMs: 44_000, mainModel: 'Haiku 5.5' } },
  { caption: 'outside CLI', view: { lane: 'Gemini', model: 'gemini-3.8-flash', agents: 1, isIdle: false, durationMs: 31_000, mainModel: 'Haiku 5.5' } },
  { caption: 'Codex review', view: { lane: 'Codex', model: '', agents: 1, isIdle: false, isReview: true, durationMs: 65_000, mainModel: 'Haiku 5.5', note: { kind: 'warning', text: 'review: codex' } } },
  { caption: 'Haiku edited a source file', view: { lane: MAIN_LANE, model: 'Haiku 5.5', agents: 0, isIdle: false, durationMs: 8_000, note: { kind: 'error', text: 'edited src/lru.py' } } },
  { caption: 'idle', view: { lane: 'coder', model: 'Sonnet 5.5', agents: 0, isIdle: true } },
]

// ---- hero.svg (880x220)
{
  const b = band(views[1]!.view, COLUMNS, 177)
  const body = [
    `<text x="24" y="66" font-family='${SANS}' font-size="28" font-weight="700" fill="${C.text}">Stop picking, just start.</text>`,
    `<text x="24" y="98" font-family='${SANS}' font-size="15" fill="${C.subtle}">Haiku triages each prompt; Sonnet, Opus, Gemini, Grok or Codex does the work.</text>`,
    `<rect x="12.5" y="130.5" width="855" height="62" rx="8" fill="${C.well}" stroke="${C.line}"/>`,
    `<circle cx="30" cy="146" r="3.5" fill="${C.error}"/><circle cx="44" cy="146" r="3.5" fill="${C.warning}"/><circle cx="58" cy="146" r="3.5" fill="#3fb950"/>`,
    b.svg,
  ].join('\n')
  writeFileSync(OUT + 'hero.svg', wrap(880, 220, 'Spick: the dashboard band while the coder subagent works', body))
  console.log('hero   ', b.plain)
}

// ---- band-states.svg (880x430)
{
  const parts: string[] = []
  views.forEach((v, i) => {
    const top = 18 + i * 68
    const b = band(v.view, COLUMNS, top + 49)
    parts.push(`<text x="24" y="${top + 14}" font-family='${SANS}' font-size="12" fill="${C.subtle}">${esc(v.caption)}</text>`)
    parts.push(`<rect x="12.5" y="${top + 22.5}" width="855" height="38" rx="6" fill="${C.well}" stroke="${C.line}"/>`)
    parts.push(b.svg)
    console.log('state  ', b.plain)
  })
  writeFileSync(OUT + 'band-states.svg', wrap(880, 430, 'Spick dashboard band in six states', parts.join('\n')))
}

// ---- pane.svg: the 80-column pane as plain text, from the mod's own layout helpers
{
  const P = { x0: 24, step: 21, top: 40 }
  const runs: string[] = []
  const lines: string[] = []
  type Run = [text: string, style: Style]
  const T: Style = { fill: C.text }
  const D: Style = { fill: C.subtle }
  const B: Style = { fill: C.brand, bold: true }
  const L: Style = { fill: C.text, bold: true }
  /** one line of runs from column 0 of the content (the pane pads one column on each side) */
  let row = 0
  const put = (...rs: Run[]) => {
    let col = 1
    for (const [t, st] of rs) {
      const lead = t.length - t.trimStart().length
      if (t.trim()) runs.push(`<text x="${P.x0 + (col + lead) * CELL}" y="${P.top + row * P.step}" font-family='${MONO}' font-size="15" fill="${st.fill}"${st.bold ? ' font-weight="700"' : ''} xml:space="preserve">${esc(t.trim())}</text>`)
      col += [...t].length
    }
    lines.push(rs.map(r => r[0]).join(''))
    row++
  }
  const blank = () => { lines.push(''); row++ }
  const key = (k: string): Run => [k + ': ', B]
  const pad = (n: number): Run => [' '.repeat(n), T]
  const label = (name: string): Run => [name.padEnd(LABEL_W), L]
  const none = pad(LABEL_W)

  const W = 78
  const left = 'SPICK  routing on · b: band shown'
  put(['SPICK', B], ['  routing on · ', D], key('b'), ['band shown', D], pad(W - left.length - 8), key('x'), ['close', T])
  blank()
  put(label('Routing'), key('r'), ['auto', B], [' · on · off', D])
  put(none, pad(HOTKEY_W), ['on (Haiku 5.5 session)', D])
  put(label('Review'), key('v'), ['auto', B], [' · off', D])
  blank()
  const tags: Record<string, string[]> = { gemini: ['search', 'long-context', 'multimodal', 'image'], grok: ['x-data'], codex: ['code', 'review', 'image'] }
  const names: [string, string, string][] = [['g', 'Gemini', 'gemini'], ['k', 'Grok', 'grok'], ['c', 'Codex', 'codex']]
  names.forEach(([k, name, id], i) => {
    put(i === 0 ? label('Lanes') : none, key(k), [name.padEnd(6) + '  ', T], ['on', B], ['   ' + tagLine(tags[id]!, W - LABEL_W - HOTKEY_W - 6 - 2 - 3 - 2), D])
  })
  put(none, key('l'), ['edit lanes', T], [' · every field, every declared lane', D])
  blank()
  const t = (turns: number, costUsd: number) => ({ turns, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd })
  const usage = usageLines([['main session', t(52, 0.45)], ['coder', t(13, 9.39)], ['planner', t(4, 3.79)], ['deep', t(1, 0.46)]])
  usage.forEach((l, i) => put(i === 0 ? label('Usage') : none, [l, i === 0 ? D : T]))
  blank()
  const q = [['claude', quotaCells({ fiveHour: 19, sevenDay: 9 }, 10)], ['codex', quotaCells({ sevenDay: 80 }, 10)]] as const
  q.forEach(([name, cells], i) => put(i === 0 ? label('Quota') : none, [name.padEnd(8) + cells.join('   '), T]))
  put(none, key('q'), ['refresh', T], [' · read just now', D])
  blank()
  const at = (h: number, m: number) => new Date(2026, 9, 14, h, m).getTime()
  const turn = (h: number, m: number, lane: string, model: string, effort: string, secs: number) =>
    ({ turnId: `${h}${m}`, startedAt: at(h, m), endedAt: at(h, m) + secs * 1000, lane, model, effort, agents: 0 })
  const recent = recentLines([
    turn(14, 52, 'coder', 'Sonnet 5.5', 'high', 221), turn(14, 47, MAIN_LANE, 'Haiku 5.5', 'low', 6), turn(14, 40, 'planner', 'Opus 5.5', 'high', 125),
    turn(14, 31, 'deep', 'Opus 5.5', 'high', 112), turn(14, 22, 'coder', 'Sonnet 5.5', 'medium', 250),
  ], false)
  recent.forEach((l, i) => {
    const clock = l.slice(0, 5)
    put(i === 0 ? label('Recent') : none, [clock, D], [l.slice(5), T])
  })
  const h = P.top + row * P.step + 4
  writeFileSync(OUT + 'pane.svg', wrap(768, h, 'Spick dashboard pane: switches, lanes, usage, quota and recent turns', runs.join('\n')))
  for (const l of lines) console.log('pane   ', l)
}
