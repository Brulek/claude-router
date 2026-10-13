// Generates the README art as SVG from the mod's real band and table code.
// Run from the repo root: node --experimental-strip-types docs/images/make-art.mts
// (Node 22.6+). checklist.ts is imported without an extension elsewhere, so the pane
// text below is hard-coded to match what the mod shows.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { bandSegments, table, MAIN_LANE } from '../../mod/spick-dashboard/hooks/format.ts'
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

// ---- pane.svg (720x400)
{
  const p: string[] = []
  const Y = (n: number) => n
  // title row
  p.push(mono(0, 44, 'SPICK', styleOf('brand'), 17))
  p.push(`<rect x="${720 - 24 - 72}" y="26.5" width="72" height="26" rx="6" fill="${C.panel}" stroke="${C.line}"/>`)
  p.push(`<text x="${720 - 24 - 36}" y="44" text-anchor="middle" font-family='${MONO}' font-size="15" fill="${C.text}">Close</text>`)

  p.push(mono(0, 92, 'Controls', { fill: C.text, bold: true }))

  const radio = (col: number, y: number, label: string, on: boolean): number => {
    const w = (label.length + 4) * CELL
    const x = gx(col)
    p.push(`<rect x="${x + 0.5}" y="${y - 17.5}" width="${w - 1}" height="25" rx="6" fill="${on ? '#2b1d17' : C.panel}" stroke="${on ? C.brand : C.line}"/>`)
    p.push(`<circle cx="${x + 15}" cy="${y - 5}" r="5" fill="none" stroke="${on ? C.brand : C.subtle}" stroke-width="1.5"/>`)
    if (on) p.push(`<circle cx="${x + 15}" cy="${y - 5}" r="2.6" fill="${C.brand}"/>`)
    p.push(mono(col + 3, y, label, { fill: C.text }))
    return col + label.length + 4 + 1
  }
  const plain = (col: number, y: number, label: string, on: boolean): number => {
    const w = (label.length + 2) * CELL
    const x = gx(col)
    p.push(`<rect x="${x + 0.5}" y="${y - 17.5}" width="${w - 1}" height="25" rx="6" fill="${on ? '#2b1d17' : C.panel}" stroke="${on ? C.brand : C.line}"/>`)
    p.push(mono(col + 1, y, label, { fill: C.text }))
    return col + label.length + 2 + 1
  }
  const LABEL = 2, BTN = 12
  const rows = [
    { y: 128, name: 'Routing' }, { y: 160, name: 'Review' }, { y: 192, name: 'Lanes' }, { y: 224, name: 'Band' },
  ]
  for (const r of rows) p.push(mono(LABEL, r.y, r.name, { fill: C.text }))
  let c = radio(BTN, 128, 'auto', true); c = radio(c, 128, 'on', false); c = radio(c, 128, 'off', false)
  p.push(mono(c + 1, 128, 'on for this session (Haiku 5.5)', styleOf('dim')))
  c = radio(BTN, 160, 'auto', true); radio(c, 160, 'off', false)
  c = plain(BTN, 192, 'Gemini on', true); c = plain(c, 192, 'Grok on', true); plain(c, 192, 'Codex on', true)
  plain(BTN, 224, 'shown', true)

  p.push(mono(0, 266, 'Recent turns', { fill: C.text, bold: true }))
  const data = [
    ['12:41', 'coder', 'Sonnet 5.5', 'medium', '44s'],
    ['12:40', 'Gemini', 'gemini-3.8-flash', '', '31s'],
    ['12:39', 'planner', 'Opus 5.5', 'high', '1m 12s'],
    ['12:38', 'main session', 'Haiku 5.5', 'medium', '6s'],
  ]
  const align: ('l' | 'r')[] = ['l', 'l', 'l', 'l', 'r']
  const lines = table(data, align)
  const widths = data[0]!.map((_, i) => Math.max(...data.map(r => r[i]!.length)))
  lines.forEach((line, ri) => {
    let off = 0
    widths.forEach((w, ci) => {
      const cell = line.slice(off, off + w)
      p.push(mono(LABEL + off, 298 + ri * 26, cell, ci === 0 || ci === 4 ? styleOf('dim') : { fill: C.text }))
      off += w + 2
    })
    console.log('pane   ', line)
  })
  writeFileSync(OUT + 'pane.svg', wrap(720, 400, 'Spick dashboard pane: Controls and Recent turns', p.join('\n')))
}
