import type { Controls, Gate, LaneInfo, Review, Routing } from '../types'
import { modelName } from './format'
import { lanesLine } from './quotaline'

export const DEFAULT_CONTROLS: Controls = { routing: 'on', review: 'auto', gate: 'on', manualModel: false }
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
// Checklist item 2, the same words as scripts/triage-hook.sh: routed by the shape of the deliverable, the most
// expensive lane first and the main session last, because a small model stops at the first bucket that fits.
export const LANE_HEAD = '2. Lane? Route by the shape of the deliverable, top to bottom, first match wins; you are the last line, not the first:'
export const LANE_BULLET_DEEP = '   - a verdict: compare, evaluate, find gaps, diagnose why, review a codebase or a design, recommend, formal writing, or you cannot tell how hard it is -> Agent(deep). You never write a verdict yourself; read files only to brief it.'
export const LANE_BULLET_PLANNER = '   - a plan or a design, or a change that needs a decision the user did not make (layout, API, algorithm, data shape, which file) -> Agent(planner); the change then goes to Agent(coder) with the plan.'
export const LANE_BULLET_CODER = '   - changed code beyond a one-liner with nothing left to decide -> Agent(coder). You never edit source yourself.'
/** the lane bullet when the user declared lane_registry (the Lanes line names the lanes), else the fixed built-in lanes */
export const LANE_BULLET_REGISTRY = "   - a task an outside lane is tagged for -> pick from the Lanes line by its tags; never send anything above a lane's data: level."
export const LANE_BULLET_BUILTIN = '   - web lookup -> Gemini (agy); X data -> Grok.'
export const LANE_BULLET_YOU = "   - a plain lookup, nothing else: the answer is already in a file here, a command's output or your own knowledge (Q&A, find/read, summarise, tidy, run a script) -> you."
export const LANE_TAIL = `   A prompt that mixes kinds is split by kind: you fetch, a lane searches, deep judges, coder edits. Pick an effort for every delegate. The Agent tool's own "when in doubt, don't spawn" is written for a model doing its own work; you are the triage layer, so when in doubt, spawn deep. A brief carries no design of your own: once it starts saying how (use X, then Y), stop and dispatch planner.`
/** the lines of checklist item 2, in order */
export const laneBullets = (registry: boolean): string[] => [LANE_HEAD, LANE_BULLET_DEEP, LANE_BULLET_PLANNER, LANE_BULLET_CODER, registry ? LANE_BULLET_REGISTRY : LANE_BULLET_BUILTIN, LANE_BULLET_YOU, LANE_TAIL]
/** checklist item 2 when the user declared lane_registry, as one block */
export const REGISTRY_LANE_LINE = laneBullets(true).join('\n')
export const NO_LABEL_LINE = 'Reply starts with the deliverable; the status band shows who worked, so print no label line.'

/** True where an AbovePrompt band is drawn: terminal and desktop. */
export const drawsBand = (surfaces: readonly string[]): boolean => surfaces.some(s => s === 'terminal' || s === 'desktop')

/** prompt origins that are deliveries, not someone asking for work: no checklist */
const DELIVERIES = new Set(['task-notification', 'peer', 'peer-send-message', 'projects-relay', 'observer', 'observer-activity'])
export const isDelivery = (kind: string): boolean => DELIVERIES.has(kind)

/** the toast a manual model pick raises */
export const MANUAL_TOAST = 'spick: routing off (model selected manually) · /spick on or /spick force to resume'

export type Effective = { on: boolean; why: string }

/**
 * Whether routing applies this session, and the reason the pane prints beside the switch.
 * `on` routes only while the session model is Haiku, `force` on any model; a manual model pick turns it off for the
 * session whatever the switch says.
 */
export function effectiveRouting(c: Controls, sessionModel: string): Effective {
  // the reason says what routing does, not on or off: those name the switch's values
  if (c.manualModel) return { on: false, why: 'routes nothing (model selected manually)' }
  if (c.routing === 'off') return { on: false, why: 'routes nothing (switched off)' }
  if (c.routing === 'force') return { on: true, why: 'routes (forced)' }
  if (/haiku/i.test(sessionModel)) return { on: true, why: `routes (${modelName(sessionModel)} session)` }
  return { on: false, why: sessionModel ? `routes nothing (${modelName(sessionModel)} is not Haiku)` : 'routes nothing (session model unknown)' }
}

/**
 * The one context block attached to each prompt: the three-question triage checklist
 * while routing is effectively on, the off sentence while it is off. `quotaLine`, when given,
 * is appended as the last line (plain facts from the quota cache; see quotaline.ts). `lanes`,
 * when the cache carries them (the user declared lane_registry), switches line 2 to the capability
 * wording and prints the Lanes line before the quota line. The cache lists the enabled lanes only,
 * so a lane switched off (in spick.json, by /spick lane <id> enabled no, or a Controls button) is
 * simply absent: no note, the same text the bash hook prints. Without a registry every lane is on. `hint`, when
 * given, is the Hint line (hint.ts: the keywords found in the prompt and the default route they imply) and sits
 * right after item 2, where the model has just read the buckets.
 */
export function checklist(c: Controls, sessionModel: string, labelLine: boolean, quotaLine?: string, lanes?: readonly LaneInfo[], hint?: string | null): string {
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
    ...laneBullets(registry),
    ...(hint ? [hint] : []),
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
  return v === 'on' || v === 'force' || v === 'off' ? v : DEFAULT_CONTROLS.routing
}
/**
 * A value stored under the old names (`auto` routed on Haiku only, `on` on any model) in its new name: auto -> on,
 * on -> force; the default when absent or malformed. The old key is read only while the new one holds nothing.
 */
export function migrateRouting(v: unknown): Routing {
  return v === 'auto' ? 'on' : v === 'on' ? 'force' : v === 'off' ? 'off' : DEFAULT_CONTROLS.routing
}
export function parseReview(v: unknown): Review {
  return v === 'off' || v === 'auto' ? v : DEFAULT_CONTROLS.review
}
export function parseGate(v: unknown): Gate {
  return v === 'off' || v === 'on' ? v : DEFAULT_CONTROLS.gate
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
  | { kind: 'gate'; value: Gate }
  | LaneCommand
  | { kind: 'band'; hidden: boolean }
  | { kind: 'quota' }
  | { kind: 'usage' }

export const ARGUMENT_HINT = '[on|force|off|review on|off|gate on|off|lane <id> [<field> <value>]|hide|show|quota]'
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
  if (w.length === 1 && (a === 'on' || a === 'force' || a === 'off')) return { kind: 'routing', value: a }
  // the old name of on
  if (w.length === 1 && a === 'auto') return { kind: 'routing', value: 'on' }
  if (w.length === 1 && (a === 'hide' || a === 'show')) return { kind: 'band', hidden: a === 'hide' }
  if (w.length === 1 && a === 'quota') return { kind: 'quota' }
  if (w.length === 2 && a === 'review' && (b === 'on' || b === 'off')) return { kind: 'review', value: b === 'on' ? 'auto' : 'off' }
  if (w.length === 2 && a === 'gate' && (b === 'on' || b === 'off')) return { kind: 'gate', value: b }
  if (a === 'lane') return parseLaneText(args.trim().replace(/^lane\s*/i, '')) ?? { kind: 'usage' }
  return { kind: 'usage' }
}
