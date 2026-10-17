import { test, expect } from 'claude-code/testing'
import { SCHEMA_VERSION, ZERO_USAGE, addUsage, appendLines, lateLine, lineText, turnLine, usageEntry } from './turnlog'
import type { DelegateEntry } from './turnlog'

const U = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }
const base = {
  at: Date.parse('2026-10-17T10:00:00Z'), sessionId: 's1', turnId: 't1', cwd: '/repo', mainModel: 'claude-haiku-5-5', routing: 'on' as const,
  hint: ['judgement'], kept: null, gateEvents: [], delegates: [], mainFiles: [], agentFiles: [], files: [], checks: [], escalation: null,
  usage: usageEntry(U, 0.01), lastInput: 115, ms: 1200,
}
const coder = (startedAt: string, usage = usageEntry(U, 0.5)): DelegateEntry =>
  ({ id: 'c1', lane: 'coder', model: 'claude-sonnet-5-5', status: 'completed', ok: true, startedAt, ms: 10, usage, costUsd: usage.costUsd })

test('usageEntry renames the engine counts; addUsage sums them, the cost null only while both are', () => {
  expect(usageEntry(U, null)).toEqual({ input: 10, output: 2, cacheRead: 100, cacheWrite: 5, costUsd: null })
  expect(addUsage(ZERO_USAGE, usageEntry(U, null)).costUsd).toBeNull()
  expect(addUsage(usageEntry(U, 0.25), usageEntry(U, null))).toEqual({ input: 20, output: 4, cacheRead: 200, cacheWrite: 10, costUsd: 0.25 })
})

test('turnLine carries schemaVersion 2 and derives gate, check, escalation and agentUsage', () => {
  const l = turnLine({
    ...base,
    gateEvents: [{ at: 'x', kind: 'judgement', words: ['why'], outcome: 'sent-back' }, { at: 'y', kind: 'judgement', words: ['why'], outcome: 'delegated' }],
    delegates: [coder('2026-10-17T10:00:05.000Z'), { id: 'g1', lane: 'Gemini', model: '', status: 'failed', ok: false, startedAt: '2026-10-17T10:00:01.000Z', ms: 3, usage: null, costUsd: null }],
    mainFiles: ['a.py'], agentFiles: ['b.py', 'c.py'], files: ['a.py', 'b.py', 'c.py'],
    checks: [{ command: 'pytest', startedAt: 'a', finishedAt: 'b', exitOk: false, editsDuring: 0, coversTurn: false }],
    escalation: { command: 'pytest', at: Date.parse('2026-10-17T10:00:04Z') },
  })
  expect(l.schemaVersion).toBe(SCHEMA_VERSION)
  expect(l.at).toBe('2026-10-17T10:00:00.000Z')
  expect(l.gate).toEqual({ kind: 'judgement', outcome: 'delegated' })
  expect(l.edits).toEqual({ main: 1, agents: 2, files: ['a.py', 'b.py', 'c.py'] })
  expect(l.check).toEqual({ ran: true, passed: false, afterLastEdit: false, command: 'pytest' })
  expect(l.escalation).toEqual({ command: 'pytest', followed: true })
  expect(l.agentUsage).toEqual({ input: 10, output: 2, cacheRead: 100, cacheWrite: 5, costUsd: 0.5 })
  expect(l.context).toEqual({ lastInput: 115 })
})

test('an escalation with no coder or deep after it is not followed; no check, no gate are null', () => {
  const l = turnLine({ ...base, delegates: [coder('2026-10-17T09:59:00.000Z')], escalation: { command: 'pytest', at: Date.parse('2026-10-17T10:00:00Z') }, lastInput: undefined })
  expect(l.escalation).toEqual({ command: 'pytest', followed: false })
  expect(l.check).toBeNull()
  expect(l.gate).toBeNull()
  expect(l.context).toEqual({ lastInput: null })
})

test('lines are one JSON line each; appendLines mends a missing last newline', () => {
  const late = lateLine({ at: 0, sessionId: 's1', turnId: 't1', delegate: coder('2026-10-17T10:00:00.000Z') })
  expect(late).toMatchObject({ schemaVersion: 2, late: true, at: '1970-01-01T00:00:00.000Z', turnId: 't1' })
  const text = lineText(late)
  expect(text.endsWith('\n')).toBe(true)
  expect(text.split('\n').length).toBe(2)
  expect(appendLines('', ['a\n'])).toBe('a\n')
  expect(appendLines('x', ['a\n', 'b\n'])).toBe('x\na\nb\n')
})
