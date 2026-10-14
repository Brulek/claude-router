import { test, expect } from 'claude-code/testing'
import type { Controls } from '../types'
import { DEFAULT_CONTROLS, NO_LABEL_LINE, REGISTRY_LANE_LINE, checklist, drawsBand, isDelivery, offSentence, reviewOffNote, effectiveRouting, parseLaneText, parseReview, parseRouting, parseSpick, ARGUMENT_HINT, USAGE } from './checklist'

const HAIKU = 'claude-haiku-5-5'
const FABLE = 'claude-fable-5-1'
const ctl = (patch: Partial<Controls> = {}): Controls => ({ ...DEFAULT_CONTROLS, ...patch })

test('the off sentence and notes read exactly as the spec words them', () => {
  expect(offSentence(true)).toBe('Spick routing is off for this session: do the work yourself, do not dispatch coder/planner/deep by the Spick table, do not route to Gemini/Grok/Codex; still end with the label line.')
  expect(reviewOffNote(true)).toBe('Codex review is off: skip the review step and write `Review: off` in the label line.')
})

test('routing on: the three questions, the bash hook\'s substance, no notes', () => {
  const block = checklist(ctl(), HAIKU, true)
  expect(block.startsWith('[spick triage - answer all three before the first tool call]')).toBe(true)
  for (const q of ['1. Plan mode?', '2. Lane?', '3. Goal-shaped?']) expect(block).toContain(q)
  expect(block).toContain('web lookup -> Gemini (agy); X data -> Grok.')
  // design first: a change that needs a decision goes to planner before coder, and the brief carries no design of the main session's own
  expect(block).toContain('a change that needs a decision (layout, API, algorithm, data shape, which file) -> Agent(planner) first, then Agent(coder) with the plan; other code change beyond a one-liner -> Agent(coder)')
  expect(block).toContain('A brief carries no design of your own: once it starts saying how (use X, then Y), stop and dispatch planner.')
  expect(REGISTRY_LANE_LINE).toContain('-> Agent(planner) first, then Agent(coder) with the plan;')
  expect(REGISTRY_LANE_LINE).toContain('A brief carries no design of your own')
  expect(block).toContain('Review: Codex gpt-6-astra (medium)')
  expect(block).toContain('every participant, reviewer included, carries its own model and effort')
  expect(block).not.toContain('lane is off')
  expect(block).not.toContain(reviewOffNote(true))
  expect(block).not.toContain(offSentence(true))
})

test('routing off: the off sentence alone', () => {
  expect(checklist(ctl({ routing: 'off' }), HAIKU, true)).toBe(offSentence(true))
  expect(checklist(ctl({ manualModel: true }), HAIKU, true)).toBe(offSentence(true))
  // auto on a model that is not Haiku is off
  expect(checklist(ctl(), FABLE, true)).toBe(offSentence(true))
  // forced on works on any model
  expect(checklist(ctl({ routing: 'on' }), FABLE, true)).not.toBe(offSentence(true))
})

test('a lane switched off is simply absent from the cache: no note, the Lanes line shows what is enabled', () => {
  const on = [
    { id: 'gemini', kind: 'cli-subscription', tags: ['search'], data: 'public' },
    { id: 'grok', kind: 'cli-subscription', tags: ['x-data'], data: 'public' },
    { id: 'codex', kind: 'cli-subscription', tags: ['code'], data: 'code' },
  ]
  const all = checklist(ctl(), HAIKU, true, undefined, on).split('\n')
  expect(all.at(-1)).toBe('Lanes (user-declared; data = most that may be sent): gemini search data:public · grok x-data data:public · codex code data:code')
  expect(all.join('\n')).toContain('Review: Codex gpt-6-astra (medium)')
  const noGemini = checklist(ctl(), HAIKU, true, undefined, on.slice(1)).split('\n')
  expect(noGemini.at(-1)).toBe('Lanes (user-declared; data = most that may be sent): grok x-data data:public · codex code data:code')
  expect(noGemini.join('\n')).not.toContain('lane is off')
  // codex absent from the enabled lanes: no Codex reviewer in the label example
  const noCodex = checklist(ctl(), HAIKU, true, undefined, on.slice(0, 2))
  expect(noCodex).not.toContain('Codex gpt-6-astra')
  expect(noCodex).toContain('Review: skipped]')
})

test('review off adds its note and the label example reads Review: off', () => {
  const block = checklist(ctl({ review: 'off' }), HAIKU, true)
  expect(block).toContain('| Review: off]')
  expect(block).not.toContain('Codex gpt-6-astra')
  expect(block.split('\n').at(-1)).toBe(reviewOffNote(true))
})

test('effectiveRouting states the value for this session and why', () => {
  expect(effectiveRouting(ctl(), HAIKU)).toEqual({ on: true, why: 'on (Haiku 5.5 session)' })
  expect(effectiveRouting(ctl(), FABLE)).toEqual({ on: false, why: 'off (Fable 5.1 is not Haiku)' })
  expect(effectiveRouting(ctl({ manualModel: true }), HAIKU)).toEqual({ on: false, why: 'off (model selected manually)' })
  expect(effectiveRouting(ctl({ routing: 'on' }), FABLE)).toEqual({ on: true, why: 'on (forced)' })
  expect(effectiveRouting(ctl({ routing: 'off' }), HAIKU).on).toBe(false)
})

test('stored values parse, a malformed one falls back to the default', () => {
  expect(parseRouting('off')).toBe('off')
  expect(parseRouting('bogus')).toBe('auto')
  expect(parseRouting(undefined)).toBe('auto')
  expect(parseReview('off')).toBe('off')
  expect(parseReview(3)).toBe('auto')
})

test('/spick arguments parse; anything else is usage', () => {
  expect(parseSpick('')).toEqual({ kind: 'open' })
  expect(parseSpick(' Off ')).toEqual({ kind: 'routing', value: 'off' })
  expect(parseSpick('auto')).toEqual({ kind: 'routing', value: 'auto' })
  expect(parseSpick('review on')).toEqual({ kind: 'review', value: 'auto' })
  expect(parseSpick('review off')).toEqual({ kind: 'review', value: 'off' })
  expect(parseSpick('lane grok off')).toEqual({ kind: 'lane-set', lane: 'grok', field: 'enabled', value: 'no' })
  expect(parseSpick('hide')).toEqual({ kind: 'band', hidden: true })
  expect(parseSpick('show')).toEqual({ kind: 'band', hidden: false })
  expect(parseSpick('quota')).toEqual({ kind: 'quota' })
  for (const bad of ['lane', 'lane   ', 'lane glm tags', 'review', 'on now', 'details']) expect(parseSpick(bad)).toEqual({ kind: 'usage' })
})

test('with every switch at its default the block is the bash hook\'s text, word for word', () => {
  // a copy of scripts/triage-hook.sh's heredoc: change both together
  expect(checklist(DEFAULT_CONTROLS, HAIKU, true)).toBe("[spick triage - answer all three before the first tool call]\n1. Plan mode? 3+ files, irreversible/wide action, ambiguous ask, greenfield build, or user asked for a plan -> call EnterPlanMode now, then dispatch planner inside it (no such tool in headless mode: plan inline and stop before editing).\n2. Lane? chores -> you; a change that needs a decision (layout, API, algorithm, data shape, which file) -> Agent(planner) first, then Agent(coder) with the plan; other code change beyond a one-liner -> Agent(coder), never edit source yourself; plan/design -> Agent(planner); hard/decision/formal writing -> Agent(deep); web lookup -> Gemini (agy); X data -> Grok. Pick an effort for every delegate. A brief carries no design of your own: once it starts saying how (use X, then Y), stop and dispatch planner.\n3. Goal-shaped? machine-checkable finish (tests green, build ok, exit 0) that needs several edit-run cycles -> hand the user one `/goal <check command>; stop after 10 attempts` line; you cannot start it yourself.\nReply starts with the deliverable; end with the label line: no delegate -> `[Model: Haiku 5.5 | Effort: medium]`; with delegates -> `[Model: Haiku 5.5 (medium) → coder Sonnet 5.5 (high) | Review: Codex gpt-6-astra (medium)]` — every participant, reviewer included, carries its own model and effort. Never write `→ none` or `→ 无`.")
})

test('while the band shows (labelLine false) no sentence asks for the label line', () => {
  expect(offSentence(false)).toBe('Spick routing is off for this session: do the work yourself, do not dispatch coder/planner/deep by the Spick table, do not route to Gemini/Grok/Codex; the status band shows who worked, so print no label line.')
  expect(reviewOffNote(false)).toBe('Codex review is off: skip the review step.')
  expect(NO_LABEL_LINE).toBe('Reply starts with the deliverable; the status band shows who worked, so print no label line.')

  const on = checklist(ctl({ review: 'off' }), HAIKU, false).split('\n')
  expect(on).toContain(NO_LABEL_LINE)
  expect(on.at(-1)).toBe('Codex review is off: skip the review step.')
  expect(on.join('\n')).not.toContain('label line:')
  expect(on.join('\n')).not.toContain('[Model:')
  expect(checklist(ctl({ routing: 'off' }), HAIKU, false)).toBe(offSentence(false))
  // labelLine true keeps today's wording
  expect(checklist(ctl({ routing: 'off' }), HAIKU, true)).toBe(offSentence(true))
  expect(checklist(ctl({ review: 'off' }), HAIKU, true).split('\n').at(-1)).toBe(reviewOffNote(true))
})

test('forced on, the label example names the session model', () => {
  const block = checklist(ctl({ routing: 'on' }), FABLE, true)
  expect(block).toContain('no delegate -> `[Model: Fable 5.1 | Effort: medium]`')
  expect(block).toContain('`[Model: Fable 5.1 (medium) → coder')
  expect(block).not.toContain('Haiku 5.5')
})

test('the band test and the delivery origins', () => {
  expect(drawsBand(['terminal'])).toBe(true)
  expect(drawsBand(['vscode', 'desktop'])).toBe(true)
  expect(drawsBand([])).toBe(false)
  expect(drawsBand(['vscode'])).toBe(false)
  for (const k of ['task-notification', 'peer', 'peer-send-message', 'projects-relay', 'observer', 'observer-activity']) expect(isDelivery(k)).toBe(true)
  for (const k of ['composer', 'bridge', 'sdk', 'plugin', 'scheduled-trigger']) expect(isDelivery(k)).toBe(false)
})

test('a quota line is appended as the last line, only while routing is on', () => {
  const line = 'Quota (cache 4m old): codex Pro Lite: 7d 53% (resets in 6d).'
  const base = checklist(ctl(), HAIKU, true)
  expect(checklist(ctl(), HAIKU, true, line)).toBe(base + '\n' + line)
  expect(checklist(ctl({ review: 'off' }), HAIKU, true, line).split('\n').at(-1)).toBe(line)
  expect(checklist(ctl(), HAIKU, true, undefined)).toBe(base)
  expect(checklist(ctl(), HAIKU, true, '')).toBe(base)
  expect(checklist(ctl({ routing: 'off' }), HAIKU, true, line)).toBe(offSentence(true))
})

// ---- declared lanes (lane_registry): the cache carries them ----
const DECLARED = [
  { id: 'gemini', kind: 'cli-subscription', tags: ['search'], data: 'code' },
  { id: 'glm', kind: 'api-key', tags: ['chinese', 'cheap'], data: 'text' },
]

test('with declared lanes: capability line 2, the Lanes line before the quota line, no fixed fallback wording', () => {
  const block = checklist(ctl(), HAIKU, true, 'Quota (cache 1m old): x.', DECLARED).split('\n')
  expect(block[2]).toBe(REGISTRY_LANE_LINE)
  expect(block[2]).not.toContain('Gemini (agy)')
  expect(block.at(-2)).toBe('Lanes (user-declared; data = most that may be sent): gemini search data:code · glm chinese,cheap data:text · glm is a third-party service: sending content to it carries a data-leak risk.')
  expect(block.at(-1)).toBe('Quota (cache 1m old): x.')
})

test('without declared lanes the checklist is the old one', () => {
  expect(checklist(ctl(), HAIKU, true, undefined, undefined)).toBe(checklist(ctl(), HAIKU, true))
  expect(checklist(ctl(), HAIKU, true, undefined, [])).toBe(checklist(ctl(), HAIKU, true))
})

test('/spick lane forms: show, on|off maps to enabled, any field with a free-text value', () => {
  expect(parseSpick('lane glm')).toEqual({ kind: 'lane-show', lane: 'glm' })
  expect(parseSpick('lane glm on')).toEqual({ kind: 'lane-set', lane: 'glm', field: 'enabled', value: 'yes' })
  expect(parseSpick(' LANE GLM Off ')).toEqual({ kind: 'lane-set', lane: 'glm', field: 'enabled', value: 'no' })
  expect(parseSpick('lane glm enabled no')).toEqual({ kind: 'lane-set', lane: 'glm', field: 'enabled', value: 'no' })
  // a tag list, and notes with spaces and case kept
  expect(parseSpick('lane openrouter tags gateway,cheap')).toEqual({ kind: 'lane-set', lane: 'openrouter', field: 'tags', value: 'gateway,cheap' })
  expect(parseSpick('lane glm notes  Use for Chinese   drafts only ')).toEqual({ kind: 'lane-set', lane: 'glm', field: 'notes', value: 'Use for Chinese   drafts only' })
  expect(parseSpick('lane glm name GLM Plan A')).toEqual({ kind: 'lane-set', lane: 'glm', field: 'name', value: 'GLM Plan A' })
  // an unknown id is not the parser's to refuse: set_lane.py does
  expect(parseSpick('lane claude off')).toEqual({ kind: 'lane-set', lane: 'claude', field: 'enabled', value: 'no' })
  // the Input on the lanes page sends "<lane> <field> <value>" through the same parser
  expect(parseLaneText('glm tags a,b')).toEqual({ kind: 'lane-set', lane: 'glm', field: 'tags', value: 'a,b' })
  expect(parseLaneText('')).toBeNull()
  expect(USAGE).toBe(`spick: usage /spick ${ARGUMENT_HINT}`)
})
