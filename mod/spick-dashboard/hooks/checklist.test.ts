import { test, expect } from 'claude-code/testing'
import type { Controls } from '../types'
import { DEFAULT_CONTROLS, NO_LABEL_LINE, REGISTRY_LANE_LINE, checklist, drawsBand, isDelivery, offSentence, reviewOffNote, effectiveRouting, laneOffNote, parseLanes, parseReview, parseRouting, parseSpick } from './checklist'

const HAIKU = 'claude-haiku-5-5'
const FABLE = 'claude-fable-5-1'
const ctl = (patch: Partial<Controls> = {}): Controls => ({ ...DEFAULT_CONTROLS, ...patch, lanes: { ...DEFAULT_CONTROLS.lanes, ...(patch.lanes ?? {}) } })

test('the off sentence and notes read exactly as the spec words them', () => {
  expect(offSentence(true)).toBe('Spick routing is off for this session: do the work yourself, do not dispatch coder/planner/deep by the Spick table, do not route to Gemini/Grok/Codex; still end with the label line.')
  expect(reviewOffNote(true)).toBe('Codex review is off: skip the review step and write `Review: off` in the label line.')
  expect(laneOffNote('gemini')).toBe('Gemini lane is off: use the fallback chain.')
  expect(laneOffNote('grok')).toBe('Grok lane is off: use the fallback chain. X data has no fallback: say so.')
  expect(laneOffNote('codex')).toBe('Codex lane is off: use the fallback chain.')
})

test('routing on: the three questions, the bash hook\'s substance, no notes', () => {
  const block = checklist(ctl(), HAIKU, true)
  expect(block.startsWith('[spick triage - answer all three before the first tool call]')).toBe(true)
  for (const q of ['1. Plan mode?', '2. Lane?', '3. Goal-shaped?']) expect(block).toContain(q)
  expect(block).toContain('web lookup -> Gemini (agy); X data -> Grok.')
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

test('a lane that is off leaves the checklist and adds its note', () => {
  const noGemini = checklist(ctl({ lanes: { gemini: false, grok: true, codex: true } }), HAIKU, true)
  expect(noGemini).toContain('web lookup -> Grok; X data -> Grok.')
  expect(noGemini).not.toContain('Gemini (agy)')
  expect(noGemini.split('\n').at(-1)).toBe('Gemini lane is off: use the fallback chain.')

  const noGrok = checklist(ctl({ lanes: { gemini: true, grok: false, codex: true } }), HAIKU, true)
  expect(noGrok).toContain('web lookup -> Gemini (agy). Pick an effort')
  expect(noGrok).not.toContain('X data ->')
  expect(noGrok).toContain('Grok lane is off: use the fallback chain. X data has no fallback: say so.')

  const neither = checklist(ctl({ lanes: { gemini: false, grok: false, codex: true } }), HAIKU, true)
  expect(neither).toContain('web lookup -> Agent(deep) with WebSearch.')

  const noCodex = checklist(ctl({ lanes: { gemini: true, grok: true, codex: false } }), HAIKU, true)
  expect(noCodex).not.toContain('Codex gpt-6-astra')
  expect(noCodex).toContain('Review: skipped]')
  expect(noCodex.split('\n').at(-1)).toBe('Codex lane is off: use the fallback chain.')
})

test('review off adds its note and the label example reads Review: off', () => {
  const block = checklist(ctl({ review: 'off' }), HAIKU, true)
  expect(block).toContain('| Review: off]')
  expect(block).not.toContain('Codex gpt-6-astra')
  expect(block.split('\n').at(-1)).toBe(reviewOffNote(true))
  // lane notes first, the review note last
  const both = checklist(ctl({ review: 'off', lanes: { gemini: false, grok: true, codex: true } }), HAIKU, true).split('\n')
  expect(both.slice(-2)).toEqual([laneOffNote('gemini'), reviewOffNote(true)])
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
  expect(parseLanes(JSON.stringify({ gemini: false, grok: true, codex: false }))).toEqual({ gemini: false, grok: true, codex: false })
  expect(parseLanes('{not json')).toEqual({ gemini: true, grok: true, codex: true })
  expect(parseLanes(JSON.stringify({ grok: 'no' }))).toEqual({ gemini: true, grok: true, codex: true })
})

test('/spick arguments parse; anything else is usage', () => {
  expect(parseSpick('')).toEqual({ kind: 'open' })
  expect(parseSpick(' Off ')).toEqual({ kind: 'routing', value: 'off' })
  expect(parseSpick('auto')).toEqual({ kind: 'routing', value: 'auto' })
  expect(parseSpick('review on')).toEqual({ kind: 'review', value: 'auto' })
  expect(parseSpick('review off')).toEqual({ kind: 'review', value: 'off' })
  expect(parseSpick('lane grok off')).toEqual({ kind: 'lane', lane: 'grok', on: false })
  expect(parseSpick('hide')).toEqual({ kind: 'band', hidden: true })
  expect(parseSpick('show')).toEqual({ kind: 'band', hidden: false })
  expect(parseSpick('quota')).toEqual({ kind: 'quota' })
  for (const bad of ['lane', 'lane claude off', 'review', 'on now', 'details']) expect(parseSpick(bad)).toEqual({ kind: 'usage' })
})

test('with every switch at its default the block is the bash hook\'s text, word for word', () => {
  // a copy of scripts/triage-hook.sh's heredoc: change both together
  expect(checklist(DEFAULT_CONTROLS, HAIKU, true)).toBe("[spick triage - answer all three before the first tool call]\n1. Plan mode? 3+ files, irreversible/wide action, ambiguous ask, greenfield build, or user asked for a plan -> call EnterPlanMode now, then dispatch planner inside it (no such tool in headless mode: plan inline and stop before editing).\n2. Lane? chores -> you; code change beyond a one-liner -> Agent(coder), never edit source yourself; plan/design -> Agent(planner); hard/decision/formal writing -> Agent(deep); web lookup -> Gemini (agy); X data -> Grok. Pick an effort for every delegate.\n3. Goal-shaped? machine-checkable finish (tests green, build ok, exit 0) that needs several edit-run cycles -> hand the user one `/goal <check command>; stop after 10 attempts` line; you cannot start it yourself.\nReply starts with the deliverable; end with the label line: no delegate -> `[Model: Haiku 5.5 | Effort: medium]`; with delegates -> `[Model: Haiku 5.5 (medium) → coder Sonnet 5.5 (high) | Review: Codex gpt-6-astra (medium)]` — every participant, reviewer included, carries its own model and effort. Never write `→ none` or `→ 无`.")
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
  { id: 'gemini', kind: 'cli-subscription', tags: ['search'], prefer: ['search'], data: 'code' },
  { id: 'glm', kind: 'api-key', tags: ['chinese', 'cheap'], prefer: ['chinese'], data: 'text' },
]

test('with declared lanes: capability line 2, the Lanes line before the quota line, no fixed fallback wording', () => {
  const block = checklist(ctl(), HAIKU, true, 'Quota (cache 1m old): x.', DECLARED).split('\n')
  expect(block[2]).toBe(REGISTRY_LANE_LINE)
  expect(block[2]).not.toContain('Gemini (agy)')
  expect(block.at(-2)).toBe('Lanes (user-declared; data = most that may be sent): gemini search prefer:search data:code · glm chinese,cheap prefer:chinese data:text · glm is a third-party service: sending content to it carries a data-leak risk.')
  expect(block.at(-1)).toBe('Quota (cache 1m old): x.')
})

test('without declared lanes the checklist is the old one', () => {
  expect(checklist(ctl(), HAIKU, true, undefined, undefined)).toBe(checklist(ctl(), HAIKU, true))
  expect(checklist(ctl(), HAIKU, true, undefined, [])).toBe(checklist(ctl(), HAIKU, true))
})

test('a declared lane switched off leaves the Lanes line and adds the plain off note', () => {
  const block = checklist(ctl({ lanes: { glm: false } }), HAIKU, true, undefined, DECLARED).split('\n')
  expect(block.at(-2)).toBe('glm lane is off for this session')
  expect(block.at(-1)).not.toContain('glm chinese')
  expect(laneOffNote('grok', true)).toBe('grok lane is off for this session')
})

test('/spick lane accepts the ids it is told are registered', () => {
  expect(parseSpick('lane glm off', ['gemini', 'glm'])).toEqual({ kind: 'lane', lane: 'glm', on: false })
  expect(parseSpick('lane glm off')).toEqual({ kind: 'usage' })
  expect(parseLanes(JSON.stringify({ gemini: false, glm: false, 'Bad Id': false }))).toEqual({ gemini: false, grok: true, codex: true, glm: false })
})
