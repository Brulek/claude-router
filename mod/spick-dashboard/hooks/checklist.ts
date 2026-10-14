import type { Controls, LaneInfo, Review, Routing } from '../types'
import { modelName } from './format'
import { lanesLine } from './quotaline'

export const DEFAULT_CONTROLS: Controls = { routing: 'auto', review: 'auto', manualModel: false }
/** the three built-in lanes the Controls row has a button for; the rest are edited on the lanes page or with /spick lane */
export const LANE_KEYS: readonly string[] = ['gemini', 'grok', 'codex']
export const LANE_NAMES: Record<string, string> = { gemini: 'Gemini', grok: 'Grok', codex: 'Codex' }

// `labelLine` is false while the status band shows (it records who worked): then no sentence asks for the label line.
const OFF_HEAD = 'Spick routing is off for this session: do the work yourself, do not dispatch coder/planner/deep by the Spick table, do not route to Gemini/Grok/Codex; '
export const offSentence = (labelLine: boolean): string =>
  OFF_HEAD + (labelLine ? 'still end with the label line.' : 'the status band shows who worked, so print no label line.')
export const reviewOffNote = (labelLine: boolean): string =>
  labelLine ? 'Codex review is off: skip the review step and write `Review: off` in the label line.' : 'Codex review is off: skip the review step.'
export const laneName = (lane: string): string => LANE_NAMES[lane] ?? lane
/** checklist line 2 when the user declared lane_registry: same words as scripts/triage-hook.sh */
export const REGISTRY_LANE_LINE = "2. Lane? chores -> you; a change that needs a decision (layout, API, algorithm, data shape, which file) -> Agent(planner) first, then Agent(coder) with the plan; other code change beyond a one-liner -> Agent(coder), never edit source yourself; plan/design -> Agent(planner); hard/decision/formal writing -> Agent(deep); a task an outside lane is tagged for -> pick from the Lanes line by its tags; never send anything above a lane's data: level. Pick an effort for every delegate. A brief carries no design of your own: once it starts saying how (use X, then Y), stop and dispatch planner."
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
 * while routing is effectively on, the off sentence while it is off. `quotaLine`, when given,
 * is appended as the last line (plain facts from the quota cache; see quotaline.ts). `lanes`,
 * when the cache carries them (the user declared lane_registry), switches line 2 to the capability
 * wording and prints the Lanes line before the quota line. The cache lists the enabled lanes only,
 * so a lane switched off (in spick.json, by /spick lane <id> enabled no, or a Controls button) is
 * simply absent: no note, the same text the bash hook prints. Without a registry every lane is on.
 */
export function checklist(c: Controls, sessionModel: string, labelLine: boolean, quotaLine?: string, lanes?: readonly LaneInfo[]): string {
  if (!effectiveRouting(c, sessionModel).on) return offSentence(labelLine)
  // the label example names the session's own model (forced on may run on any)
  const main = sessionModel ? modelName(sessionModel) : 'Haiku 5.5'
  const declared = lanes ?? []
  const registry = declared.length > 0
  const codex = !registry || declared.some(l => l.id === 'codex')
  const review = c.review === 'off' ? 'Review: off' : codex ? 'Review: Codex gpt-6-astra (medium)' : 'Review: skipped'
  const who = c.review !== 'off' && codex ? 'every participant, reviewer included, carries its own model and effort' : 'every participant carries its own model and effort'
  const lines = [
    '[spick triage - answer all three before the first tool call]',
    '1. Plan mode? 3+ files, irreversible/wide action, ambiguous ask, greenfield build, or user asked for a plan -> call EnterPlanMode now, then dispatch planner inside it (no such tool in headless mode: plan inline and stop before editing).',
    registry ? REGISTRY_LANE_LINE : '2. Lane? chores -> you; a change that needs a decision (layout, API, algorithm, data shape, which file) -> Agent(planner) first, then Agent(coder) with the plan; other code change beyond a one-liner -> Agent(coder), never edit source yourself; plan/design -> Agent(planner); hard/decision/formal writing -> Agent(deep); web lookup -> Gemini (agy); X data -> Grok. Pick an effort for every delegate. A brief carries no design of your own: once it starts saying how (use X, then Y), stop and dispatch planner.',
    '3. Goal-shaped? machine-checkable finish (tests green, build ok, exit 0) that needs several edit-run cycles -> hand the user one `/goal <check command>; stop after 10 attempts` line; you cannot start it yourself.',
    labelLine
      ? `Reply starts with the deliverable; end with the label line: no delegate -> \`[Model: ${main} | Effort: medium]\`; with delegates -> \`[Model: ${main} (medium) → coder Sonnet 5.5 (high) | ${review}]\` — ${who}. Never write \`→ none\` or \`→ 无\`.`
      : NO_LABEL_LINE,
  ]
  if (c.review === 'off') lines.push(reviewOffNote(labelLine))
  if (registry) {
    const shown = lanesLine(declared)
    if (shown) lines.push(shown)
  }
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
/** what `/spick lane <rest>` asks for; the value keeps its case and its inner spaces */
export type LaneCommand =
  | { kind: 'lane-show'; lane: string }
  | { kind: 'lane-set'; lane: string; field: string; value: string }

/** what `/spick <args>` asks for, parsed; `usage` for anything else */
export type SpickCommand =
  | { kind: 'open' }
  | { kind: 'routing'; value: Routing }
  | { kind: 'review'; value: Review }
  | LaneCommand
  | { kind: 'band'; hidden: boolean }
  | { kind: 'quota' }
  | { kind: 'usage' }

export const ARGUMENT_HINT = '[on|off|auto|review on|off|lane <id> [<field> <value>]|hide|show|quota]'
export const USAGE = `spick: usage /spick ${ARGUMENT_HINT}`

/**
 * What follows `lane `: `<id>` shows the lane, `<id> on|off` sets enabled, `<id> <field> <value>` sets the field.
 * The id and the field are lowercased, the value is not (notes keep their case and spaces); set_lane.py validates all three.
 */
export function parseLaneText(rest: string): LaneCommand | null {
  const m = /^\s*(\S+)(?:\s+(\S+)(?:\s+([\s\S]*\S))?)?\s*$/.exec(rest)
  if (!m) return null
  const lane = (m[1] ?? '').toLowerCase()
  const word = m[2]
  const value = m[3]
  if (word === undefined) return { kind: 'lane-show', lane }
  const field = word.toLowerCase()
  if (value === undefined) {
    if (field === 'on' || field === 'off') return { kind: 'lane-set', lane, field: 'enabled', value: field === 'on' ? 'yes' : 'no' }
    return null
  }
  return { kind: 'lane-set', lane, field, value }
}

export function parseSpick(args: string): SpickCommand {
  const w = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const [a, b] = w
  if (w.length === 0) return { kind: 'open' }
  if (w.length === 1 && (a === 'on' || a === 'off' || a === 'auto')) return { kind: 'routing', value: a }
  if (w.length === 1 && (a === 'hide' || a === 'show')) return { kind: 'band', hidden: a === 'hide' }
  if (w.length === 1 && a === 'quota') return { kind: 'quota' }
  if (w.length === 2 && a === 'review' && (b === 'on' || b === 'off')) return { kind: 'review', value: b === 'on' ? 'auto' : 'off' }
  if (a === 'lane') return parseLaneText(args.trim().replace(/^lane\s*/i, '')) ?? { kind: 'usage' }
  return { kind: 'usage' }
}
