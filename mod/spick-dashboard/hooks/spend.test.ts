import { test, expect } from 'claude-code/testing'
import { SPEND_DIR, parseSpendFile, spendFileText, spendPath, spendRow } from './spend'

const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 30, cache_creation_input_tokens: 4 }

test('a turn row carries the usage, the cost, the agent and the effort', () => {
  expect(spendRow({ at: 0, turnId: 't1', agentId: 'a1', lane: 'coder', model: 'claude-sonnet-5-5', effort: 'high', usage: USAGE, costUsd: 0.5 })).toEqual({
    at: '1970-01-01T00:00:00.000Z', turnId: 't1', agentId: 'a1', lane: 'coder', model: 'claude-sonnet-5-5', effort: 'high',
    inputTokens: 1000, outputTokens: 200, cacheReadTokens: 30, cacheCreationTokens: 4, costUsd: 0.5,
  })
})

test('a main-session row leaves agentId and effort out when absent; an unknown model stays unpriced', () => {
  const r = spendRow({ at: 1000, turnId: 't1', lane: 'main session', model: 'mystery-1', usage: USAGE, costUsd: null })
  expect('agentId' in r).toBe(false)
  expect('effort' in r).toBe(false)
  expect(r.costUsd).toBeNull()
})

test('a CLI call row has zero tokens and costUsd null, whatever cost is passed', () => {
  expect(spendRow({ at: 0, turnId: 't1', lane: 'Gemini', model: 'gemini-3.8-flash', effort: 'low', usage: null, costUsd: 3 })).toEqual({
    at: '1970-01-01T00:00:00.000Z', turnId: 't1', lane: 'Gemini', model: 'gemini-3.8-flash', effort: 'low',
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null,
  })
})

test('the file text is JSON, one row per line, and reads back', () => {
  const rows = [spendRow({ at: 0, turnId: 't1', lane: 'main session', model: 'm', usage: USAGE, costUsd: 1 }), spendRow({ at: 1, turnId: 't1', lane: 'Gemini', model: '', usage: null, costUsd: null })]
  const f = { sessionId: 's1', cwd: '/repo', startedAt: '1970-01-01T00:00:00.000Z', rows }
  const text = spendFileText(f)
  expect(JSON.parse(text)).toEqual(f)
  expect(text.split('\n')).toHaveLength(5)
  expect(text.endsWith('\n')).toBe(true)
  expect(JSON.parse(spendFileText({ ...f, rows: [] }))).toEqual({ ...f, rows: [] })
  expect(parseSpendFile(text, 's1')).toEqual(f)
})

test('a file of another session, or not JSON, is not taken up; rows that are not rows are dropped', () => {
  const text = spendFileText({ sessionId: 's1', cwd: '/repo', startedAt: 'x', rows: [] })
  expect(parseSpendFile(text, 's2')).toBeNull()
  expect(parseSpendFile('not json', 's1')).toBeNull()
  expect(parseSpendFile('{"sessionId":"s1","rows":{}}', 's1')).toBeNull()
  expect(parseSpendFile('{"sessionId":"s1","rows":[1,{"at":"x","lane":"main session","inputTokens":1}]}', 's1')?.rows).toEqual([{ at: 'x', lane: 'main session', inputTokens: 1 }])
})

test('the path is under ~/.claude/spick-spend and the id cannot leave the directory', () => {
  expect(SPEND_DIR).toBe('.claude/spick-spend')
  expect(spendPath('/h', 'abc-123_x.y')).toBe('/h/.claude/spick-spend/abc-123_x.y.json')
  expect(spendPath('/h', '../../etc/passwd')).toBe('/h/.claude/spick-spend/__.._etc_passwd.json')
  expect(spendPath('/h', '..')).toBe('/h/.claude/spick-spend/_.json')
})
