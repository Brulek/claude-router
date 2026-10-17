import { test, expect } from 'claude-code/testing'
import type { Controls } from '../types'
import { lanesFromCache, lanesFromConfig } from './quotaline'
import { CHECKLIST_TEMPLATE, DEFAULT_CONTROLS, EFFORT_DEFAULTS, LANE_BULLET_DEEP, LANE_BULLET_LANES_BUILTIN, LANE_BULLET_LANES_NONE, LANE_BULLET_YOU, LANE_HEAD, LANE_TAIL, NO_LABEL_LINE, REGISTRY_LANE_LINE, checklist, drawsBand, isDelivery, laneBullets, offSentence, reviewOffNote, effectiveRouting, migrateRouting, parseGate, parseGuard, parseLaneText, parseReview, parseRouting, parseSpick, ARGUMENT_HINT, USAGE } from './checklist'

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
  expect(block).toContain(LANE_BULLET_LANES_BUILTIN)
  // the planner threshold is narrow: architecture, interface, data format, cross-module; layout and naming are coder's
  expect(block).toContain('(architecture, public interface, data format, cross-module trade-off) -> Agent(planner)')
  expect(block).toContain('layout, naming, which file are its calls')
  // not dispatching is the default for small work, and the brief is a handoff packet
  expect(block).toContain('small work stays here')
  expect(block).toContain('A brief is a handoff packet, not your trail')
  // escalation on a fact: a check failing twice
  expect(block).toContain('A check failing twice: Agent(coder) at high effort, or Agent(deep) if the cause is unknown.')
  // the kinds in rules.json order: outside lanes, deep, planner, coder, review, the main session last
  const order = ['-> Grok', '-> Agent(deep).', '-> Agent(planner)', '-> Agent(coder);', 'a diff to review', '-> you:'].map(s => block.indexOf(s))
  expect(order.every(i => i > -1)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  expect(REGISTRY_LANE_LINE).toBe(laneBullets(true).join('\n'))
  expect(REGISTRY_LANE_LINE).toContain('pick from the Lanes line by tag')
  expect(block).toContain('Review: Codex <model> (medium)')
  expect(block).toContain('every participant, reviewer included, carries its own model and effort')
  expect(block).not.toContain('lane is off')
  expect(block).not.toContain(reviewOffNote(true))
  expect(block).not.toContain(offSentence(true))
})

test('routing off: the off sentence alone', () => {
  expect(checklist(ctl({ routing: 'off' }), HAIKU, true)).toBe(offSentence(true))
  expect(checklist(ctl({ manualModel: true }), HAIKU, true)).toBe(offSentence(true))
  // on, on a model that is not Haiku, routes nothing (and says /spick force exists)
  expect(checklist(ctl(), FABLE, true)).toBe(offSentence(true, true))
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
  expect(all.join('\n')).toContain('Review: Codex <model> (medium)')
  const noGemini = checklist(ctl(), HAIKU, true, undefined, on.slice(1)).split('\n')
  expect(noGemini.at(-1)).toBe('Lanes (user-declared; data = most that may be sent): grok x-data data:public · codex code data:code')
  expect(noGemini.join('\n')).not.toContain('lane is off')
  // codex absent from the enabled lanes: no Codex reviewer in the label example
  const noCodex = checklist(ctl(), HAIKU, true, undefined, on.slice(0, 2))
  expect(noCodex).not.toContain('Codex <model>')
  expect(noCodex).toContain('Review: skipped]')
})

test('review off adds its note and the label example reads Review: off', () => {
  const block = checklist(ctl({ review: 'off' }), HAIKU, true)
  expect(block).toContain('| Review: off]')
  expect(block).not.toContain('Codex <model>')
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

/** what scripts/triage-hook.sh prints from assets/checklist.txt for one variant (its loop, in TypeScript) */
const hookText = (variant: 'builtin' | 'registry' | 'none', hint?: string): string[] => {
  const out: string[] = []
  for (const line of CHECKLIST_TEMPLATE) {
    const m = /^\{([a-z,]+)\}(.*)$/.exec(line)
    if (!m) out.push(line)
    else if (m[1] === 'hint') { if (hint) out.push(hint) }
    else if ((m[1] ?? '').split(',').includes(variant)) out.push(m[2] ?? '')
  }
  return out
}

test('with every switch at its default the block is the bash hook\'s text, line for line, in each lane variant', () => {
  // test_triage_hint.py runs the hook itself against assets/checklist.txt; CHECKLIST_TEMPLATE is that file, rendered
  const hint = '   Hint (keywords in this prompt, not a verdict): edit words (fix) -> Agent(coder) once nothing is left to decide. Keeping a hinted task yourself needs a one-line reason in the reply, on a line starting with `Kept:`.'
  expect(checklist(DEFAULT_CONTROLS, HAIKU, true)).toBe(hookText('builtin').join('\n'))
  expect(checklist(DEFAULT_CONTROLS, HAIKU, true, undefined, undefined, hint)).toBe(hookText('builtin', hint).join('\n'))
  const codex = [{ id: 'codex', kind: 'cli-subscription', tags: ['code', 'review'], data: 'code' }]
  const reg = checklist(DEFAULT_CONTROLS, HAIKU, true, undefined, { registry: true, lanes: codex }).split('\n')
  expect(reg.slice(0, -1)).toEqual(hookText('registry'))
  expect(checklist(DEFAULT_CONTROLS, HAIKU, true, undefined, { registry: true, lanes: [] })).toBe(hookText('none').join('\n'))
  expect(checklist(DEFAULT_CONTROLS, HAIKU, true, undefined, { registry: false, lanes: [] })).toBe(hookText('builtin').join('\n'))
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

test('on but not Haiku: the off sentence names /spick force; switched off or picked by hand, it does not', () => {
  const note = ' (`/spick force` routes on any model; a forced session still sends code to `coder` so the main context stays small)'
  expect(checklist(ctl(), FABLE, true)).toBe(offSentence(true) + note)
  expect(checklist(ctl(), FABLE, false)).toBe(offSentence(false) + note)
  expect(offSentence(true, true)).toBe(offSentence(true) + note)
  expect(checklist(ctl({ routing: 'off' }), FABLE, true)).toBe(offSentence(true))
  expect(checklist(ctl({ manualModel: true }), FABLE, true)).toBe(offSentence(true))
  expect(checklist(ctl(), HAIKU, true)).not.toContain('/spick force')
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

test('without a registry the checklist is the built-in one; an empty registry is not "no registry"', () => {
  const builtin = checklist(ctl(), HAIKU, true)
  expect(checklist(ctl(), HAIKU, true, undefined, undefined)).toBe(builtin)
  expect(checklist(ctl(), HAIKU, true, undefined, null)).toBe(builtin)
  expect(checklist(ctl(), HAIKU, true, undefined, { registry: false, lanes: [] })).toBe(builtin)
  // a registry with every lane off, in either shape: no outside lane may be called and nothing reviews by Codex
  for (const none of [{ registry: true, lanes: [] }, []] as const) {
    const block = checklist(ctl(), HAIKU, true, 'Quota (cache 1m old): x.', none)
    expect(block).not.toBe(builtin)
    expect(block).toContain('   - no outside lane is enabled: do not call Gemini, Grok or Codex')
    expect(block).toContain('| Review: skipped]')
    expect(block).toContain('every participant carries its own model and effort')
    expect(block).not.toContain('Lanes (')
    expect(block.split('\n').at(-1)).toBe('Quota (cache 1m old): x.')
  }
  // what lanesFromCache returns goes straight in
  expect(checklist(ctl(), HAIKU, true, undefined, lanesFromCache('{"registry":true,"lanes":[]}'))).toContain('no outside lane is enabled')
  expect(checklist(ctl(), HAIKU, true, undefined, lanesFromCache('{"registry":false,"lanes":[]}'))).toBe(builtin)
  // a cold cache: spick.json with every built-in switched off and no registry is none, not the built-in bullet
  const allOff = checklist(ctl(), HAIKU, true, undefined, lanesFromConfig('{"lanes":{"gemini":false,"grok":false,"codex":false}}'))
  expect(allOff).toBe(hookText('none').join('\n'))
  expect(allOff).not.toContain(LANE_BULLET_LANES_BUILTIN)
  // one switched off: the registry wording with the other two on the Lanes line
  const oneOff = checklist(ctl(), HAIKU, true, undefined, lanesFromConfig('{"lanes":{"gemini":false}}')).split('\n')
  expect(oneOff.slice(0, -1)).toEqual(hookText('registry'))
  expect(oneOff.at(-1)).toBe('Lanes (user-declared; data = most that may be sent): grok x-data data:code · codex code,review,image data:code')
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
  const hint = '   Hint (keywords in this prompt, not a verdict): judgement words (对比) -> size the material: small -> you, with a `Kept:` line; large or high-stakes -> Agent(deep). Keeping a hinted task yourself needs a one-line reason in the reply, on a line starting with `Kept:`.'
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

test('item 2 is one head, six bullets and a tail; the outside lanes come first and the main session last', () => {
  for (const v of [true, false, 'builtin', 'registry', 'none'] as const) {
    const b = laneBullets(v)
    expect(b[0]).toBe(LANE_HEAD)
    expect(b[2]).toBe(LANE_BULLET_DEEP)
    expect(b.at(-2)).toBe(LANE_BULLET_YOU)
    expect(b.at(-1)).toBe(LANE_TAIL)
    expect(b.filter(l => l.startsWith('   - ')).length).toBe(6)
    // every bullet names who takes it
    for (const l of b.slice(1, -1)) expect(/-> (Agent\((deep|planner|coder)\)|you:|Grok|Codex|pick from the Lanes line|the lane tagged|Agent\(deep\))|no outside lane/.test(l)).toBe(true)
  }
  expect(laneBullets('none')[1]).toBe(LANE_BULLET_LANES_NONE)
  expect(LANE_BULLET_LANES_NONE).toContain('no outside lane is enabled: do not call Gemini, Grok or Codex')
  expect(EFFORT_DEFAULTS).toEqual({ coder: 'medium', planner: 'high', deep: 'medium' })
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
  expect(USAGE).toBe('spick: usage /spick [on|force|off|review on|off|gate on|off|guard on|off|lane <id> [<field> <value>]|hide|show|quota|spend|audit]')
})
