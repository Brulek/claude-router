import { test, expect } from 'claude-code/testing'
import type { Controls } from '../types'
import { DEFAULT_CONTROLS, LANE_BULLET_DEEP, LANE_BULLET_YOU, LANE_HEAD, LANE_TAIL, NO_LABEL_LINE, REGISTRY_LANE_LINE, checklist, drawsBand, isDelivery, laneBullets, offSentence, reviewOffNote, effectiveRouting, migrateRouting, parseGate, parseGuard, parseLaneText, parseReview, parseRouting, parseSpick, ARGUMENT_HINT, USAGE } from './checklist'

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
  expect(block).toContain('a change that needs a decision the user did not make (layout, API, algorithm, data shape, which file) -> Agent(planner); the change then goes to Agent(coder) with the plan.')
  expect(block).toContain('A brief carries no design of your own: once it starts saying how (use X, then Y), stop and dispatch planner.')
  // routed by the shape of the deliverable, the most expensive lane first: deep, planner, coder, the lanes, and the
  // main session last, since a small model stops at the first bucket that fits; a verdict is never the main session's
  const order = ['-> Agent(deep).', '-> Agent(planner);', '-> Agent(coder).', 'web lookup -> Gemini (agy)', '-> you.'].map(s => block.indexOf(s))
  expect(order.every(i => i > -1)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  expect(block).toContain('You never write a verdict yourself; read files only to brief it.')
  // the harness tells a model doing its own work not to spawn when in doubt; the triage layer is told the opposite
  expect(block).toContain(`The Agent tool's own "when in doubt, don't spawn" is written for a model doing its own work; you are the triage layer, so when in doubt, spawn deep.`)
  expect(REGISTRY_LANE_LINE).toBe(laneBullets(true).join('\n'))
  expect(REGISTRY_LANE_LINE).toContain('-> Agent(planner); the change then goes to Agent(coder) with the plan.')
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
  // on, on a model that is not Haiku, routes nothing
  expect(checklist(ctl(), FABLE, true)).toBe(offSentence(true))
  // force routes on any model
  expect(checklist(ctl({ routing: 'force' }), FABLE, true)).not.toBe(offSentence(true))
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
  expect(effectiveRouting(ctl(), HAIKU)).toEqual({ on: true, why: 'routes (Haiku 5.5 session)' })
  expect(effectiveRouting(ctl(), FABLE)).toEqual({ on: false, why: 'routes nothing (Fable 5.1 is not Haiku)' })
  expect(effectiveRouting(ctl({ manualModel: true }), HAIKU)).toEqual({ on: false, why: 'routes nothing (model selected manually)' })
  expect(effectiveRouting(ctl({ routing: 'force' }), FABLE)).toEqual({ on: true, why: 'routes (forced)' })
  expect(effectiveRouting(ctl({ routing: 'off' }), HAIKU)).toEqual({ on: false, why: 'routes nothing (switched off)' })
  // a manual model pick wins over force too
  expect(effectiveRouting(ctl({ routing: 'force', manualModel: true }), HAIKU)).toEqual({ on: false, why: 'routes nothing (model selected manually)' })
})

test('stored values parse, a malformed one falls back to the default', () => {
  expect(parseRouting('off')).toBe('off')
  expect(parseRouting('force')).toBe('force')
  expect(parseRouting('bogus')).toBe('on')
  expect(parseRouting(undefined)).toBe('on')
  // the old names: auto routed on Haiku only (now on), on routed on any model (now force)
  expect(parseRouting('auto')).toBe('on')
  expect(migrateRouting('auto')).toBe('on')
  expect(migrateRouting('on')).toBe('force')
  expect(migrateRouting('off')).toBe('off')
  expect(migrateRouting(undefined)).toBe('on')
  expect(parseReview('off')).toBe('off')
  expect(parseReview(3)).toBe('auto')
})

test('/spick arguments parse; anything else is usage', () => {
  expect(parseSpick('')).toEqual({ kind: 'open' })
  expect(parseSpick(' Off ')).toEqual({ kind: 'routing', value: 'off' })
  expect(parseSpick('on')).toEqual({ kind: 'routing', value: 'on' })
  expect(parseSpick('force')).toEqual({ kind: 'routing', value: 'force' })
  // auto, the old name of on, still works
  expect(parseSpick('auto')).toEqual({ kind: 'routing', value: 'on' })
  expect(parseSpick('review on')).toEqual({ kind: 'review', value: 'auto' })
  expect(parseSpick('review off')).toEqual({ kind: 'review', value: 'off' })
  expect(parseSpick('lane grok off')).toEqual({ kind: 'lane-set', lane: 'grok', field: 'enabled', value: 'no' })
  expect(parseSpick('hide')).toEqual({ kind: 'band', hidden: true })
  expect(parseSpick('show')).toEqual({ kind: 'band', hidden: false })
  expect(parseSpick('quota')).toEqual({ kind: 'quota' })
  expect(parseSpick(' Spend ')).toEqual({ kind: 'spend' })
  for (const bad of ['lane', 'lane   ', 'lane glm tags', 'review', 'on now', 'details', 'spend 30']) expect(parseSpick(bad)).toEqual({ kind: 'usage' })
})

test('with every switch at its default the block is the bash hook\'s text, word for word', () => {
  // a copy of scripts/triage-hook.sh's heredoc; test_triage_hint.py runs the hook itself and compares it with this file's constants
  expect(checklist(DEFAULT_CONTROLS, HAIKU, true)).toBe("[spick triage - answer all three before the first tool call]\n1. Plan mode? 3+ files, irreversible/wide action, ambiguous ask, greenfield build, or user asked for a plan -> call EnterPlanMode now, then dispatch planner inside it (no such tool in headless mode: plan inline and stop before editing).\n2. Lane? Route by the shape of the deliverable, top to bottom, first match wins; you are the last line, not the first:\n   - a verdict: compare, evaluate, find gaps, diagnose why, review a codebase or a design, recommend, formal writing, or you cannot tell how hard it is -> Agent(deep). You never write a verdict yourself; read files only to brief it.\n   - a plan or a design, or a change that needs a decision the user did not make (layout, API, algorithm, data shape, which file) -> Agent(planner); the change then goes to Agent(coder) with the plan.\n   - changed code beyond a one-liner with nothing left to decide -> Agent(coder). You never edit source yourself.\n   - web lookup -> Gemini (agy); X data -> Grok.\n   - a plain lookup, nothing else: the answer is already in a file here, a command's output or your own knowledge (Q&A, find/read, summarise, tidy, run a script) -> you.\n   A prompt that mixes kinds is split by kind: you fetch, a lane searches, deep judges, coder edits. Pick an effort for every delegate. The Agent tool's own \"when in doubt, don't spawn\" is written for a model doing its own work; you are the triage layer, so when in doubt, spawn deep. A brief carries no design of your own: once it starts saying how (use X, then Y), stop and dispatch planner.\n3. Goal-shaped? machine-checkable finish (tests green, build ok, exit 0) that needs several edit-run cycles -> hand the user one `/goal <check command>; stop after 10 attempts` line; you cannot start it yourself.\nReply starts with the deliverable; end with the label line: no delegate -> `[Model: Haiku 5.5 | Effort: medium]`; with delegates -> `[Model: Haiku 5.5 (medium) → coder Sonnet 5.5 (high) | Review: Codex gpt-6-astra (medium)]` — every participant, reviewer included, carries its own model and effort. Never write `→ none` or `→ 无`.")
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

test('force: the label example names the session model', () => {
  const block = checklist(ctl({ routing: 'force' }), FABLE, true)
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
  const item2 = block.slice(2, 2 + laneBullets(true).length).join('\n')
  expect(item2).toBe(REGISTRY_LANE_LINE)
  expect(item2).not.toContain('Gemini (agy)')
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

test('the Hint line sits right after item 2 and before item 3; absent when there is none', () => {
  const hint = '   Hint (keywords in this prompt, not a verdict): judgement words (对比) -> start from Agent(deep, high). Keeping a hinted task yourself needs a one-line reason in the reply, on a line starting with `Kept:`.'
  const lines = checklist(ctl(), HAIKU, true, undefined, undefined, hint).split('\n')
  const at = lines.indexOf(hint)
  expect(at).toBe(2 + laneBullets(false).length)
  expect(lines[at - 1]).toBe(LANE_TAIL)
  expect((lines[at + 1] ?? '').startsWith('3. Goal-shaped?')).toBe(true)
  for (const none of [undefined, null, '']) expect(checklist(ctl(), HAIKU, true, undefined, undefined, none)).toBe(checklist(ctl(), HAIKU, true))
  // with declared lanes the hint still follows item 2, before the Lanes and quota lines
  const reg = checklist(ctl(), HAIKU, true, 'Quota (cache 1m old): x.', DECLARED, hint).split('\n')
  expect(reg.indexOf(hint)).toBe(2 + laneBullets(true).length)
  expect(reg.at(-1)).toBe('Quota (cache 1m old): x.')
  // routing off: no checklist, so no hint either
  expect(checklist(ctl({ routing: 'off' }), HAIKU, true, undefined, undefined, hint)).toBe(offSentence(true))
})

test('item 2 is one head, five bullets and a tail; deep is the first bullet and the main session the last', () => {
  for (const registry of [true, false]) {
    const b = laneBullets(registry)
    expect(b[0]).toBe(LANE_HEAD)
    expect(b[1]).toBe(LANE_BULLET_DEEP)
    expect(b.at(-2)).toBe(LANE_BULLET_YOU)
    expect(b.at(-1)).toBe(LANE_TAIL)
    expect(b.filter(l => l.startsWith('   - ')).length).toBe(5)
    // every bullet names who takes it
    for (const l of b.slice(1, -1)) expect(/-> (Agent\((deep|planner|coder)\)|you\.|Gemini \(agy\)|pick from the Lanes line)/.test(l)).toBe(true)
  }
})

test('the gate switch parses and defaults to on', () => {
  expect(DEFAULT_CONTROLS.gate).toBe('on')
  expect(parseGate('off')).toBe('off')
  expect(parseGate('on')).toBe('on')
  expect(parseGate(undefined)).toBe('on')
  expect(parseGate('bogus')).toBe('on')
  expect(parseSpick('gate off')).toEqual({ kind: 'gate', value: 'off' })
  expect(parseSpick(' Gate ON ')).toEqual({ kind: 'gate', value: 'on' })
  for (const bad of ['gate', 'gate maybe', 'gate on now']) expect(parseSpick(bad)).toEqual({ kind: 'usage' })
  expect(ARGUMENT_HINT).toContain('gate on|off')
})

test('the guard switch parses and defaults to on', () => {
  expect(DEFAULT_CONTROLS.guard).toBe('on')
  expect(parseGuard('off')).toBe('off')
  expect(parseGuard('on')).toBe('on')
  expect(parseGuard(undefined)).toBe('on')
  expect(parseGuard('bogus')).toBe('on')
  expect(parseSpick('guard off')).toEqual({ kind: 'guard', value: 'off' })
  expect(parseSpick(' Guard ON ')).toEqual({ kind: 'guard', value: 'on' })
  for (const bad of ['guard', 'guard maybe', 'guard on now']) expect(parseSpick(bad)).toEqual({ kind: 'usage' })
  expect(ARGUMENT_HINT).toContain('guard on|off')
  expect(USAGE).toBe('spick: usage /spick [on|force|off|review on|off|gate on|off|guard on|off|lane <id> [<field> <value>]|hide|show|quota|spend]')
})
