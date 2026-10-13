import { test, expect } from 'claude-code/testing'
import type { Controls } from '../types'
import { DEFAULT_CONTROLS, OFF_SENTENCE, REVIEW_OFF_NOTE, checklist, effectiveRouting, laneOffNote, parseLanes, parseReview, parseRouting, parseSpick } from './checklist'

const HAIKU = 'claude-haiku-5-5'
const FABLE = 'claude-fable-5-1'
const ctl = (patch: Partial<Controls> = {}): Controls => ({ ...DEFAULT_CONTROLS, ...patch, lanes: { ...DEFAULT_CONTROLS.lanes, ...(patch.lanes ?? {}) } })

test('the off sentence and notes read exactly as the spec words them', () => {
  expect(OFF_SENTENCE).toBe('Spick routing is off for this session: do the work yourself, do not dispatch coder/planner/deep by the Spick table, do not route to Gemini/Grok/Codex; still end with the label line.')
  expect(REVIEW_OFF_NOTE).toBe('Codex review is off: skip the review step and write `Review: off` in the label line.')
  expect(laneOffNote('gemini')).toBe('Gemini lane is off: use the fallback chain.')
  expect(laneOffNote('grok')).toBe('Grok lane is off: use the fallback chain.')
  expect(laneOffNote('codex')).toBe('Codex lane is off: use the fallback chain.')
})

test('routing on: the three questions, the bash hook\'s substance, no notes', () => {
  const block = checklist(ctl(), HAIKU)
  expect(block.startsWith('[spick triage - answer all three before the first tool call]')).toBe(true)
  for (const q of ['1. Plan mode?', '2. Lane?', '3. Goal-shaped?']) expect(block).toContain(q)
  expect(block).toContain('web lookup -> Gemini (agy); X data -> Grok.')
  expect(block).toContain('Review: Codex gpt-6-astra (medium)')
  expect(block).toContain('every participant, reviewer included, carries its own model and effort')
  expect(block).not.toContain('lane is off')
  expect(block).not.toContain(REVIEW_OFF_NOTE)
  expect(block).not.toContain(OFF_SENTENCE)
})

test('routing off: the off sentence alone', () => {
  expect(checklist(ctl({ routing: 'off' }), HAIKU)).toBe(OFF_SENTENCE)
  expect(checklist(ctl({ manualModel: true }), HAIKU)).toBe(OFF_SENTENCE)
  // auto on a model that is not Haiku is off
  expect(checklist(ctl(), FABLE)).toBe(OFF_SENTENCE)
  // forced on works on any model
  expect(checklist(ctl({ routing: 'on' }), FABLE)).not.toBe(OFF_SENTENCE)
})

test('a lane that is off leaves the checklist and adds its note', () => {
  const noGemini = checklist(ctl({ lanes: { gemini: false, grok: true, codex: true } }), HAIKU)
  expect(noGemini).toContain('web lookup -> Grok; X data -> Grok.')
  expect(noGemini).not.toContain('Gemini (agy)')
  expect(noGemini.split('\n').at(-1)).toBe('Gemini lane is off: use the fallback chain.')

  const noGrok = checklist(ctl({ lanes: { gemini: true, grok: false, codex: true } }), HAIKU)
  expect(noGrok).toContain('web lookup -> Gemini (agy). Pick an effort')
  expect(noGrok).not.toContain('X data')
  expect(noGrok).toContain('Grok lane is off: use the fallback chain.')

  const neither = checklist(ctl({ lanes: { gemini: false, grok: false, codex: true } }), HAIKU)
  expect(neither).toContain('web lookup -> Agent(deep) with WebSearch.')

  const noCodex = checklist(ctl({ lanes: { gemini: true, grok: true, codex: false } }), HAIKU)
  expect(noCodex).not.toContain('Codex gpt-6-astra')
  expect(noCodex).toContain('Review: skipped]')
  expect(noCodex.split('\n').at(-1)).toBe('Codex lane is off: use the fallback chain.')
})

test('review off adds its note and the label example reads Review: off', () => {
  const block = checklist(ctl({ review: 'off' }), HAIKU)
  expect(block).toContain('| Review: off]')
  expect(block).not.toContain('Codex gpt-6-astra')
  expect(block.split('\n').at(-1)).toBe(REVIEW_OFF_NOTE)
  // lane notes first, the review note last
  const both = checklist(ctl({ review: 'off', lanes: { gemini: false, grok: true, codex: true } }), HAIKU).split('\n')
  expect(both.slice(-2)).toEqual([laneOffNote('gemini'), REVIEW_OFF_NOTE])
})

test('effectiveRouting states the value for this session and why', () => {
  expect(effectiveRouting(ctl(), HAIKU)).toEqual({ on: true, why: 'on for this session (Haiku 5.5)' })
  expect(effectiveRouting(ctl(), FABLE)).toEqual({ on: false, why: 'off: Fable 5.1 is not Haiku' })
  expect(effectiveRouting(ctl({ manualModel: true }), HAIKU)).toEqual({ on: false, why: 'off: model selected manually' })
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
  expect(checklist(DEFAULT_CONTROLS, HAIKU)).toBe("[spick triage - answer all three before the first tool call]\n1. Plan mode? 3+ files, irreversible/wide action, ambiguous ask, greenfield build, or user asked for a plan -> call EnterPlanMode now, then dispatch planner inside it (no such tool in headless mode: plan inline and stop before editing).\n2. Lane? chores -> you; code change beyond a one-liner -> Agent(coder), never edit source yourself; plan/design -> Agent(planner); hard/decision/formal writing -> Agent(deep); web lookup -> Gemini (agy); X data -> Grok. Pick an effort for every delegate.\n3. Goal-shaped? machine-checkable finish (tests green, build ok, exit 0) that needs several edit-run cycles -> hand the user one `/goal <check command>; stop after 10 attempts` line; you cannot start it yourself.\nReply starts with the deliverable; end with the label line: no delegate -> `[Model: Haiku 5.5 | Effort: medium]`; with delegates -> `[Model: Haiku 5.5 (medium) → coder Sonnet 5.5 (high) | Review: Codex gpt-6-astra (medium)]` — every participant, reviewer included, carries its own model and effort. Never write `→ none` or `→ 无`.")
})
