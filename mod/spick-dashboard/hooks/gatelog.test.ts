import { test, expect } from 'claude-code/testing'
import { appendGateLog, gateLogLine, gateLogPath, gateOutcome, parseGateLog } from './gatelog'
import type { GateLogEntry } from './gatelog'

const SENT: GateLogEntry = { at: '2026-10-16T10:00:00.000Z', sessionId: 's1', kind: 'judgement', words: ['对比', '差距'], outcome: 'sent-back' }

test('one entry is one JSON line with the keys in order, under ~/.claude', () => {
  expect(gateLogLine(SENT)).toBe('{"at":"2026-10-16T10:00:00.000Z","sessionId":"s1","kind":"judgement","words":["对比","差距"],"outcome":"sent-back"}')
  expect(gateLogPath('/h')).toBe('/h/.claude/spick-gate.jsonl')
})

test('append adds one line; a file missing its last newline gets one first', () => {
  const one = appendGateLog('', SENT)
  expect(one).toBe(gateLogLine(SENT) + '\n')
  const kept = { ...SENT, outcome: 'kept' as const }
  expect(appendGateLog(one, kept)).toBe(one + gateLogLine(kept) + '\n')
  expect(appendGateLog(gateLogLine(SENT), kept)).toBe(one + gateLogLine(kept) + '\n')
})

test('parse reads the entries back and skips a torn or foreign line', () => {
  const kept = { ...SENT, outcome: 'kept' as const }
  const text = appendGateLog(appendGateLog('', SENT), kept) + '{"at":"x","outcome"\n' + '{"at":"x","sessionId":"s","kind":"k","words":[],"outcome":"maybe"}\n\n'
  expect(parseGateLog(text)).toEqual([SENT, kept])
  expect(parseGateLog('')).toEqual([])
})

test('the outcome at a later stop: a delegate wins, then a Kept: line (either language); else none yet', () => {
  expect(gateOutcome('long answer', true)).toBe('delegated')
  expect(gateOutcome('answer\nKept: a diff is a lookup', true)).toBe('delegated')
  expect(gateOutcome('answer\nKept: a diff is a lookup', false)).toBe('kept')
  expect(gateOutcome('答案\n自留：纯查阅', false)).toBe('kept')
  expect(gateOutcome('the same answer again', false)).toBeNull()
})
