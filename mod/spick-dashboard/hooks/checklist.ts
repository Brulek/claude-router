import type { Controls, LaneKey, Review, Routing } from '../types'
import { modelName } from './format'

export const DEFAULT_CONTROLS: Controls = { routing: 'auto', review: 'auto', lanes: { gemini: true, grok: true, codex: true }, manualModel: false }
export const LANE_KEYS: readonly LaneKey[] = ['gemini', 'grok', 'codex']
export const LANE_NAMES: Record<LaneKey, string> = { gemini: 'Gemini', grok: 'Grok', codex: 'Codex' }

// `labelLine` is false while the status band shows (it records who worked): then no sentence asks for the label line.
const OFF_HEAD = 'Spick routing is off for this session: do the work yourself, do not dispatch coder/planner/deep by the Spick table, do not route to Gemini/Grok/Codex; '
export const offSentence = (labelLine: boolean): string =>
  OFF_HEAD + (labelLine ? 'still end with the label line.' : 'the status band shows who worked, so print no label line.')
export const reviewOffNote = (labelLine: boolean): string =>
  labelLine ? 'Codex review is off: skip the review step and write `Review: off` in the label line.' : 'Codex review is off: skip the review step.'
export const laneOffNote = (lane: LaneKey): string =>
  `${LANE_NAMES[lane]} lane is off: use the fallback chain.${lane === 'grok' ? ' X data has no fallback: say so.' : ''}`
export const NO_LABEL_LINE = 'Reply starts with the deliverable; the status band shows who worked, so print no label line.'

/** True where an AbovePrompt band is drawn: terminal and desktop. */
export const drawsBand = (surfaces: readonly string[]): boolean => surfaces.some(s => s === 'terminal' || s === 'desktop')

/** prompt origins that are deliveries, not someone asking for work: no checklist */
const DELIVERIES = new Set(['task-notification', 'peer', 'peer-send-message', 'projects-relay', 'observer', 'observer-activity'])
export const isDelivery = (kind: string): boolean => DELIVERIES.has(kind)

/** the toast a manual model pick raises */
export const MANUAL_TOAST = 'spick: routing off (model selected manually) · /spick on to resume'

export type Effective = { on: boolean; why: string }

/**
 * Whether routing applies this session, and the reason the pane prints beside the switch.
 * `auto` is on only while the session model is Haiku; a manual model pick turns it off for the session.
 */
export function effectiveRouting(c: Controls, sessionModel: string): Effective {
  if (c.manualModel) return { on: false, why: 'off (model selected manually)' }
  if (c.routing === 'off') return { on: false, why: 'off (forced)' }
  if (c.routing === 'on') return { on: true, why: 'on (forced)' }
  if (/haiku/i.test(sessionModel)) return { on: true, why: `on (${modelName(sessionModel)} session)` }
  return { on: false, why: sessionModel ? `off (${modelName(sessionModel)} is not Haiku)` : 'off (session model unknown)' }
}

/**
 * The one context block attached to each prompt: the three-question triage checklist
 * (lanes that are off left out, their notes and the review note appended) while routing
 * is effectively on, the off sentence while it is off. `quotaLine`, when given, is appended
 * as the last line (plain facts from the quota cache; see quotaline.ts).
 */
export function checklist(c: Controls, sessionModel: string, labelLine: boolean, quotaLine?: string): string {
  if (!effectiveRouting(c, sessionModel).on) return offSentence(labelLine)
  // the label example names the session's own model (forced on may run on any)
  const main = sessionModel ? modelName(sessionModel) : 'Haiku 5.5'
  const { gemini, grok, codex } = c.lanes
  const search = gemini ? 'web lookup -> Gemini (agy)' : grok ? 'web lookup -> Grok' : 'web lookup -> Agent(deep) with WebSearch'
  const xData = grok ? '; X data -> Grok' : ''
  const review = c.review === 'off' ? 'Review: off' : codex ? 'Review: Codex gpt-6-astra (medium)' : 'Review: skipped'
  const who = c.review !== 'off' && codex ? 'every participant, reviewer included, carries its own model and effort' : 'every participant carries its own model and effort'
  const lines = [
    '[spick triage - answer all three before the first tool call]',
    '1. Plan mode? 3+ files, irreversible/wide action, ambiguous ask, greenfield build, or user asked for a plan -> call EnterPlanMode now, then dispatch planner inside it (no such tool in headless mode: plan inline and stop before editing).',
    `2. Lane? chores -> you; code change beyond a one-liner -> Agent(coder), never edit source yourself; plan/design -> Agent(planner); hard/decision/formal writing -> Agent(deep); ${search}${xData}. Pick an effort for every delegate.`,
    '3. Goal-shaped? machine-checkable finish (tests green, build ok, exit 0) that needs several edit-run cycles -> hand the user one `/goal <check command>; stop after 10 attempts` line; you cannot start it yourself.',
    labelLine
      ? `Reply starts with the deliverable; end with the label line: no delegate -> \`[Model: ${main} | Effort: medium]\`; with delegates -> \`[Model: ${main} (medium) → coder Sonnet 5.5 (high) | ${review}]\` — ${who}. Never write \`→ none\` or \`→ 无\`.`
      : NO_LABEL_LINE,
  ]
  for (const k of LANE_KEYS) if (!c.lanes[k]) lines.push(laneOffNote(k))
  if (c.review === 'off') lines.push(reviewOffNote(labelLine))
  if (quotaLine) lines.push(quotaLine)
  return lines.join('\n')
}

/** a stored routing value, or the default when absent or malformed */
export function parseRouting(v: unknown): Routing {
  return v === 'on' || v === 'off' || v === 'auto' ? v : DEFAULT_CONTROLS.routing
}
export function parseReview(v: unknown): Review {
  return v === 'off' || v === 'auto' ? v : DEFAULT_CONTROLS.review
}
/** `spick:lanes` is a JSON string; a missing or malformed lane stays on */
export function parseLanes(v: unknown): Controls['lanes'] {
  const out = { ...DEFAULT_CONTROLS.lanes }
  if (typeof v !== 'string') return out
  try {
    const o = JSON.parse(v) as unknown
    if (o && typeof o === 'object') for (const k of LANE_KEYS) {
      const b = (o as Record<string, unknown>)[k]
      if (typeof b === 'boolean') out[k] = b
    }
  } catch {}
  return out
}

/** what `/spick <args>` asks for, parsed; `usage` for anything else */
export type SpickCommand =
  | { kind: 'open' }
  | { kind: 'routing'; value: Routing }
  | { kind: 'review'; value: Review }
  | { kind: 'lane'; lane: LaneKey; on: boolean }
  | { kind: 'band'; hidden: boolean }
  | { kind: 'quota' }
  | { kind: 'usage' }

export const ARGUMENT_HINT = '[on|off|auto|review on|off|lane <gemini|grok|codex> on|off|hide|show|quota]'
export const USAGE = `spick: usage /spick ${ARGUMENT_HINT}`

export function parseSpick(args: string): SpickCommand {
  const w = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const [a, b, c] = w
  if (w.length === 0) return { kind: 'open' }
  if (w.length === 1 && (a === 'on' || a === 'off' || a === 'auto')) return { kind: 'routing', value: a }
  if (w.length === 1 && (a === 'hide' || a === 'show')) return { kind: 'band', hidden: a === 'hide' }
  if (w.length === 1 && a === 'quota') return { kind: 'quota' }
  if (w.length === 2 && a === 'review' && (b === 'on' || b === 'off')) return { kind: 'review', value: b === 'on' ? 'auto' : 'off' }
  if (w.length === 3 && a === 'lane' && (b === 'gemini' || b === 'grok' || b === 'codex') && (c === 'on' || c === 'off')) return { kind: 'lane', lane: b, on: c === 'on' }
  return { kind: 'usage' }
}
