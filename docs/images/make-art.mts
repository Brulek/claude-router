// Generates the README art as SVG from the mod's real band and table code.
// Run from the repo root: node --experimental-strip-types docs/images/make-art.mts
// (Node 22.6+). checklist.ts is imported without an extension elsewhere, so the pane
// text below is hard-coded to match what the mod shows.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { bandSegments, quotaCells, recentLines, usageLines, BAND_SWITCH_GAP, HOTKEY_W, LABEL_W, MAIN_LANE } from '../../mod/spick-dashboard/hooks/format.ts'
import type { BandView, Seg } from '../../mod/spick-dashboard/hooks/format.ts'

const OUT = fileURLToPath(new URL('.', import.meta.url))
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif'
const SERIF = 'Georgia, "Times New Roman", "Noto Serif", serif'
/** Claude's light palette: warm paper, terracotta brand, Claude Code's light-theme status colours */
const C = {
  paper: '#FAF9F5', // card background (Claude off-white)
  sand: '#F0EEE6', // band bars; a warmer take on the band's #F0F0EF in the desktop app
  rule: '#E0DDD4', // card stroke
  ink: '#191919', // headings, lane names (bold)
  inkSoft: '#3D3D3A', // plain band text, subtitle
  muted: '#87867F', // dim text (the desktop's "Idle" measures #898781)
  brand: '#D77757', // Claude Code's theme colour `claude`, rgb(215,119,87)
  success: '#2C7A39', // Claude Code light theme: success
  warning: '#966C1E', // Claude Code light theme: warning
  error: '#AB2B3F', // Claude Code light theme: error
}
/**
 * A switch's value in force, in its own colour. Copied from VALUE_COLORS in
 * mod/spick-dashboard/hooks/register.tsx:458 (on success, force and auto claude, off subtle);
 * register.tsx pulls in the mod runtime, so it cannot be imported here.
 */
const VALUE_COLORS: Record<string, string> = { on: C.success, force: C.brand, auto: C.brand, off: C.muted }
const CELL = 9 // monospace column width in px at 15px font size
const X0 = 24
const gx = (col: number) => X0 + col * CELL

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const num = (n: number) => String(Math.round(n * 100) / 100)

type Style = { fill: string; bold?: boolean }
const styleOf = (s: Seg['style']): Style => {
  switch (s) {
    case 'brand': return { fill: C.brand, bold: true }
    case 'lane': return { fill: C.ink, bold: true }
    case 'dim': return { fill: C.muted }
    case 'warning': return { fill: C.warning }
    case 'error': return { fill: C.error }
    default: return { fill: C.inkSoft }
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

/**
 * a band line: the wordmark, one column, the routing switch's value (bold, in its VALUE_COLORS colour), the rest of
 * the left group; the right group ends at `columns`. The order is register.tsx's band (left[0], switch, left.slice(1)).
 */
function band(v: BandView, columns: number, y: number, routing = 'on'): { svg: string; plain: string } {
  const { left, right } = bandSegments(v, columns, BAND_SWITCH_GAP.terminal + routing.length)
  const out: string[] = []
  const runs: [string, Style][] = [
    [left[0]!.text, styleOf(left[0]!.style)],
    [' '.repeat(BAND_SWITCH_GAP.terminal), styleOf('plain')],
    [routing, { fill: VALUE_COLORS[routing] ?? C.brand, bold: true }],
    ...left.slice(1).map(s => [s.text, styleOf(s.style)] as [string, Style]),
  ]
  let col = 0
  for (const [t, st] of runs) { out.push(mono(col, y, t, st)); col += [...t].length }
  let plain = runs.map(r => r[0]).join('')
  if (right.length) {
    col = columns - widthOf(right)
    for (const s of right) { out.push(mono(col, y, s.text, styleOf(s.style))); col += [...s.text].length }
    plain = plain.padEnd(columns - widthOf(right)) + right.map(s => s.text).join('')
  }
  return { svg: out.join(''), plain }
}

const card = (w: number, h: number) => `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="16" fill="${C.paper}" stroke="${C.rule}"/>`
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

// ---- hero.svg (880x260)
{
  const b = band(views[1]!.view, COLUMNS, 202)
  const body = [
    `<text x="24" y="42" font-family='${MONO}' font-size="13" font-weight="700" fill="${C.brand}">SPICK</text>`,
    `<text x="24" y="92" font-family='${SERIF}' font-size="36" fill="${C.ink}">Stop picking, just start.</text>`,
    `<text x="24" y="126" font-family='${SANS}' font-size="16" fill="${C.inkSoft}">Haiku triages each prompt; Sonnet, Opus, Gemini, Grok or Codex does the work.</text>`,
    `<rect x="12" y="174" width="856" height="48" rx="10" fill="${C.sand}"/>`,
    b.svg,
  ].join('\n')
  writeFileSync(OUT + 'hero.svg', wrap(880, 260, 'Spick: the dashboard band while the coder subagent works', body))
  console.log('hero   ', b.plain)
}

// ---- band-states.svg (880x430)
{
  const parts: string[] = []
  views.forEach((v, i) => {
    const top = 18 + i * 68
    const b = band(v.view, COLUMNS, top + 49)
    parts.push(`<text x="24" y="${top + 14}" font-family='${SANS}' font-size="12" fill="${C.muted}">${esc(v.caption)}</text>`)
    parts.push(`<rect x="12" y="${top + 22}" width="856" height="40" rx="10" fill="${C.sand}"/>`)
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
  const T: Style = { fill: C.inkSoft }
  const D: Style = { fill: C.muted }
  const B: Style = { fill: C.brand, bold: true }
  const L: Style = { fill: C.ink, bold: true }
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
  /**
   * radio buttons as register.tsx draws them: ● the value in force, ○ the others; the hotkey sits in front of the
   * value it moves to (the next one, wrapping), the others keep its room empty; the value in force bold in its colour
   */
  const radio = (all: string[], inForce: string, hotkey: string): Run[] => {
    const next = all[(all.indexOf(inForce) + 1) % all.length]
    return all.flatMap((v, i): Run[] => [
      ...(i > 0 ? [pad(2)] : []),
      v === next ? key(hotkey) : pad(HOTKEY_W),
      v === inForce ? ['●', { fill: C.ink }] : ['○', D],
      pad(1),
      [v, v === inForce ? { fill: VALUE_COLORS[v] ?? C.brand, bold: true } : D],
    ])
  }
  put(label('Routing'), ...radio(['on', 'force', 'off'], 'on', 'r'))
  put(none, pad(HOTKEY_W), ['routes (Haiku 5.5 session)', D])
  put(label('Review'), ...radio(['auto', 'off'], 'auto', 'v'))
  put(label('Gate'), ...radio(['on', 'off'], 'on', 'e'))
  put(label('Guard'), ...radio(['on', 'off'], 'on', 'd'))
  blank()
  const names: [string, string][] = [['g', 'Gemini'], ['k', 'Grok'], ['c', 'Codex']]
  const nameW = Math.max(...names.map(n => n[1].length))
  names.forEach(([k, name], i) => {
    put(i === 0 ? label('Lanes') : none, [name.padEnd(nameW + 2), T], ...radio(['on', 'off'], 'on', k))
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
