import { test, expect } from 'claude-code/testing'
import { parseClaudeUsage, parseCodexRateLimits } from './quota'

test('parseClaudeUsage reads the cached utilization', () => {
  const json = JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: 1, utilization: { five_hour: { utilization: 5 }, seven_day: { utilization: 1 } } } })
  expect(parseClaudeUsage(json)).toEqual({ fiveHour: 5, sevenDay: 1 })
})

test('parseClaudeUsage returns null when the field is missing or the text is not JSON', () => {
  expect(parseClaudeUsage('{"oauthAccount":{}}')).toBeNull()
  expect(parseClaudeUsage('not json')).toBeNull()
})

test('parseCodexRateLimits takes the last complete rate_limits object', () => {
  const line = (pct: number) => JSON.stringify({ payload: { rate_limits: { primary: { used_percent: pct, window_minutes: 10080 }, secondary: null } } })
  expect(parseCodexRateLimits(line(12) + '\n' + line(30) + '\n')).toEqual({ sevenDay: 30 })
})

test('parseCodexRateLimits skips a truncated trailing object', () => {
  const good = JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 30, window_minutes: 10080 } } } })
  const cut = '{"payload":{"rate_limits":{"primary":{"used_percent":99,"window_mi'
  expect(parseCodexRateLimits(good + '\n' + cut)).toEqual({ sevenDay: 30 })
  expect(parseCodexRateLimits(cut)).toBeNull()
})

test('parseCodexRateLimits labels a five-hour window', () => {
  const line = JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 7, window_minutes: 300 }, secondary: { used_percent: 30, window_minutes: 10080 } } } })
  expect(parseCodexRateLimits(line)).toEqual({ fiveHour: 7, sevenDay: 30 })
})
