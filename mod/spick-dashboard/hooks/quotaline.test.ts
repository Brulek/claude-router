import { test, expect } from 'claude-code/testing'
import { lanesFromCache, lanesLine, quotaLineFromCache } from './quotaline'

// A copy of skills/spick/scripts/testdata/cache_sample.json and cache_sample.line.txt: quota.py's tests
// check the same pair, so the Python and TypeScript builders stay word for word the same.
const SAMPLE = "{\"written_at\":\"2026-10-13T15:30:00Z\",\"providers\":[{\"provider\":\"claude\",\"plan\":\"Max 20x\",\"price\":\"$200/mo\",\"source\":\"~/.claude.json\",\"sampled_at\":\"2026-10-13T09:33:25Z\",\"age_s\":null,\"windows\":[{\"name\":\"5h\",\"used_pct\":19.0,\"resets_at\":\"2026-10-13T10:19:59Z\",\"reset\":false},{\"name\":\"7d\",\"used_pct\":9.0,\"resets_at\":\"2026-10-20T00:59:59Z\",\"reset\":false}],\"status\":\"stale\",\"facts\":[]},{\"provider\":\"codex\",\"plan\":\"Pro Lite\",\"price\":null,\"source\":\"codex app-server\",\"sampled_at\":\"2026-10-13T15:29:00Z\",\"age_s\":null,\"windows\":[{\"name\":\"7d\",\"used_pct\":53.0,\"resets_at\":\"2026-10-20T05:38:29Z\",\"reset\":false}],\"status\":\"fresh\",\"facts\":[]},{\"provider\":\"gemini\",\"plan\":\"AI Pro\",\"price\":null,\"source\":\"agy /usage\",\"sampled_at\":\"2026-10-13T15:29:30Z\",\"age_s\":null,\"windows\":[{\"name\":\"Gemini 7d\",\"used_pct\":0.6,\"resets_at\":\"2026-10-15T01:43:55Z\",\"reset\":false},{\"name\":\"Gemini 5h\",\"used_pct\":0.0,\"resets_at\":\"2026-10-13T20:34:05Z\",\"reset\":false}],\"status\":\"fresh\",\"facts\":[]},{\"provider\":\"grok\",\"plan\":\"SuperGrok\",\"price\":null,\"source\":\"grok agent stdio\",\"sampled_at\":null,\"age_s\":null,\"windows\":[],\"status\":\"unknown\",\"reason\":\"login needed\",\"facts\":[]},{\"provider\":\"glm\",\"plan\":null,\"price\":null,\"source\":\"lane_registry\",\"sampled_at\":null,\"age_s\":null,\"windows\":[],\"status\":\"unknown\",\"facts\":[\"no meter (declared plan only)\"]},{\"provider\":\"proxy\",\"plan\":null,\"price\":null,\"source\":\"lane_registry\",\"sampled_at\":\"2026-10-13T15:29:40Z\",\"age_s\":null,\"windows\":[],\"status\":\"fresh\",\"facts\":[\"balance 12.30 USD\"]},{\"provider\":\"deepseek\",\"plan\":\"per-token\",\"price\":null,\"source\":\"lane_registry\",\"sampled_at\":\"2026-10-13T15:29:50Z\",\"age_s\":null,\"windows\":[],\"status\":\"fresh\",\"facts\":[\"balance 12.40 CNY\"]},{\"provider\":\"openrouter\",\"plan\":null,\"price\":null,\"source\":\"lane_registry\",\"sampled_at\":\"2026-10-13T15:29:55Z\",\"age_s\":null,\"windows\":[],\"status\":\"fresh\",\"facts\":[\"used 3.20 of 10.00 USD\"]}],\"lanes\":[{\"id\":\"gemini\",\"kind\":\"cli-subscription\",\"tags\":[\"search\",\"long-context\",\"multimodal\",\"image\"],\"data\":\"code\"},{\"id\":\"grok\",\"kind\":\"cli-subscription\",\"tags\":[\"x-data\"],\"data\":\"code\"},{\"id\":\"codex\",\"kind\":\"cli-subscription\",\"tags\":[\"code\",\"review\",\"image\"],\"data\":\"code\"},{\"id\":\"glm\",\"kind\":\"api-key\",\"tags\":[\"chinese\",\"cheap\"],\"data\":\"text\"},{\"id\":\"proxy\",\"kind\":\"relay\",\"tags\":[\"code\"],\"data\":null}]}"
const NOW = Date.parse('2026-10-13T15:34:00Z')
const LINE = "Quota (cache 4m old): claude Max 20x: 5h reset passed, 7d 9% (resets in 6d) [stale, 6h old] \u00b7 codex Pro Lite: 7d 53% (resets in 6d) \u00b7 gemini AI Pro: Gemini 7d 1% (resets in 1d), Gemini 5h 0% (resets in 5h) \u00b7 grok SuperGrok: unknown (login needed) \u00b7 glm: no meter (declared plan only) \u00b7 proxy: balance 12.30 USD \u00b7 deepseek per-token: balance 12.40 CNY \u00b7 openrouter: used 3.20 of 10.00 USD."
const LANES_LINE = "Lanes (user-declared; data = most that may be sent): gemini search,long-context,multimodal,image data:code \u00b7 grok x-data data:code \u00b7 codex code,review,image data:code \u00b7 glm chinese,cheap data:text \u00b7 proxy code data:unset \u00b7 glm is a third-party service: sending content to it carries a data-leak risk. \u00b7 proxy is a third-party service: sending content to it carries a data-leak risk."

test('the sample cache gives the same line as quota.py', () => {
  expect(quotaLineFromCache(SAMPLE, NOW)).toBe(LINE)
})

test('the sample cache gives the same Lanes line as lanes.py', () => {
  expect(lanesLine(lanesFromCache(SAMPLE) ?? [])).toBe(LANES_LINE)
})

test('a lane with no declared data level says so; a third-party lane carries the data-leak fact', () => {
  const line = lanesLine(lanesFromCache(SAMPLE) ?? [])
  expect(line).toContain('proxy code data:unset')
  expect(line).toContain('glm is a third-party service: sending content to it carries a data-leak risk.')
  expect(line).not.toContain('gemini is a third-party')
})

test('lanes come from the cache only when it carries them', () => {
  expect(lanesFromCache('{"written_at":"2026-10-13T15:30:00Z","providers":[]}')).toBeNull()
  expect(lanesFromCache('{not json')).toBeNull()
  expect(lanesFromCache('{"lanes":[]}')).toBeNull()
})

test('facts replace the unknown prefix; a provider without facts keeps it', () => {
  const doc = '{"written_at":"2026-10-13T15:30:00Z","providers":[{"provider":"glm","facts":["no meter (declared plan only)"]},{"provider":"grok","facts":[],"reason":"login needed"}]}'
  const line = quotaLineFromCache(doc, NOW) ?? ''
  expect(line).toContain('glm: no meter (declared plan only)')
  expect(line).toContain('grok: unknown (login needed)')
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
