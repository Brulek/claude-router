import { test, expect } from 'claude-code/testing'
import { quotaLineFromCache } from './quotaline'

// A copy of skills/spick/scripts/testdata/cache_sample.json and cache_sample.line.txt: quota.py's tests
// check the same pair, so the Python and TypeScript builders stay word for word the same.
const SAMPLE = "{\"written_at\":\"2026-10-13T15:30:00Z\",\"providers\":[{\"provider\":\"claude\",\"plan\":\"Max 20x\",\"price\":\"$200/mo\",\"source\":\"~/.claude.json\",\"sampled_at\":\"2026-10-13T09:33:25Z\",\"age_s\":null,\"windows\":[{\"name\":\"5h\",\"used_pct\":19.0,\"resets_at\":\"2026-10-13T10:19:59Z\",\"reset\":false},{\"name\":\"7d\",\"used_pct\":9.0,\"resets_at\":\"2026-10-20T00:59:59Z\",\"reset\":false}],\"status\":\"stale\"},{\"provider\":\"codex\",\"plan\":\"Pro Lite\",\"price\":null,\"source\":\"codex app-server\",\"sampled_at\":\"2026-10-13T15:29:00Z\",\"age_s\":null,\"windows\":[{\"name\":\"7d\",\"used_pct\":53.0,\"resets_at\":\"2026-10-20T05:38:29Z\",\"reset\":false}],\"status\":\"fresh\"},{\"provider\":\"gemini\",\"plan\":\"AI Pro\",\"price\":null,\"source\":\"agy /usage\",\"sampled_at\":\"2026-10-13T15:29:30Z\",\"age_s\":null,\"windows\":[{\"name\":\"Gemini 7d\",\"used_pct\":0.6,\"resets_at\":\"2026-10-15T01:43:55Z\",\"reset\":false},{\"name\":\"Gemini 5h\",\"used_pct\":0.0,\"resets_at\":\"2026-10-13T20:34:05Z\",\"reset\":false}],\"status\":\"fresh\"},{\"provider\":\"grok\",\"plan\":\"SuperGrok\",\"price\":null,\"source\":\"grok agent stdio\",\"sampled_at\":null,\"age_s\":null,\"windows\":[],\"status\":\"unknown\",\"reason\":\"login needed\"}]}"
const NOW = Date.parse('2026-10-13T15:34:00Z')
const LINE = "Quota (cache 4m old): claude Max 20x: 5h reset passed, 7d 9% (resets in 6d) [stale, 6h old] \u00b7 codex Pro Lite: 7d 53% (resets in 6d) \u00b7 gemini AI Pro: Gemini 7d 1% (resets in 1d), Gemini 5h 0% (resets in 5h) \u00b7 grok SuperGrok: unknown (login needed)."

test('the sample cache gives the same line as quota.py', () => {
  expect(quotaLineFromCache(SAMPLE, NOW)).toBe(LINE)
})

test('facts only: ages, a reset that passed, an unknown with its reason', () => {
  const line = quotaLineFromCache(SAMPLE, NOW) ?? ''
  expect(line).toContain('claude Max 20x: 5h reset passed, 7d 9% (resets in 6d) [stale, 6h old]')
  expect(line).toContain('grok SuperGrok: unknown (login needed)')
  expect(line.startsWith('Quota (cache 4m old): ')).toBe(true)
  expect(line).not.toMatch(/should|must|avoid|prefer|tight/)
})

test('a window past its reset time reads as reset, not as its old percent', () => {
  const later = Date.parse('2026-10-21T00:00:00Z')
  expect(quotaLineFromCache(SAMPLE, later)).toContain('codex Pro Lite: 7d reset passed')
})

test('a window whose reset time is past reads as reset passed, whatever its old percent', () => {
  const doc = '{"written_at":"2026-10-13T15:30:00Z","providers":[{"provider":"codex","plan":"Pro","sampled_at":"2026-10-13T15:29:00Z","windows":[{"name":"5h","used_pct":40,"resets_at":"2026-10-13T15:00:00Z","reset":false}]}]}'
  expect(quotaLineFromCache(doc, NOW)).toContain('codex Pro: 5h reset passed.')
})

test('an unknown percent keeps its reset time, a missing reset time drops the parenthesis', () => {
  const doc = '{"written_at":"2026-10-13T15:30:00Z","providers":[{"provider":"codex","plan":"Pro","sampled_at":"2026-10-13T15:29:00Z","windows":[{"name":"7d","used_pct":null,"resets_at":"2026-10-15T15:34:00Z","reset":false},{"name":"5h","used_pct":12.0,"resets_at":null,"reset":false}]}]}'
  expect(quotaLineFromCache(doc, NOW)).toContain('codex Pro: 7d unknown (resets in 2d), 5h 12%.')
})

test('a missing, corrupt or empty cache gives no line', () => {
  expect(quotaLineFromCache('', NOW)).toBeNull()
  expect(quotaLineFromCache('{not json', NOW)).toBeNull()
  expect(quotaLineFromCache('{"written_at":"2026-10-13T15:30:00Z","providers":[]}', NOW)).toBeNull()
  expect(quotaLineFromCache('{"providers":[{"provider":"claude"}]}', NOW)).toBeNull()
})
