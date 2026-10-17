import { test, expect } from 'claude-code/testing'
import { parseClaudeUsage, parseCodexRateLimits, readQuota } from './quota'
import type { QuotaIO } from './quota'

test('parseClaudeUsage reads the cached utilization', () => {
  const json = JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: 1, utilization: { five_hour: { utilization: 5 }, seven_day: { utilization: 1 } } } })
  // fetchedAtMs is the sample's own time
  expect(parseClaudeUsage(json)).toEqual({ fiveHour: 5, sevenDay: 1, sampledAt: 1 })
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

type Entry = { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }
const dir = (name: string): Entry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
const file = (name: string, mtimeMs: number, size = 1): Entry => ({ name, kind: 'file', size, mtimeMs, isLink: false })

function fakeEngine(opts: { home?: () => Promise<string | undefined>; codexHome?: string; files?: Record<string, string>; lists?: Record<string, Entry[]> }): QuotaIO {
  return {
    env: async name => (name === 'HOME' ? (opts.home ? opts.home() : '/h') : opts.codexHome),
    read: async (path: string) => {
      const text = opts.files?.[path]
      if (text === undefined) throw new Error('ENOENT ' + path)
      return text
    },
    list: async (path: string) => opts.lists?.[path] ?? [],
  }
}

test('readQuota resolves with both sources null when env.get rejects', async () => {
  const $ = fakeEngine({ home: async () => { throw new Error('boom') } })
  expect(await readQuota($, 42)).toEqual({ claude: null, codex: null, readAt: 42 })
})

test('readQuota resolves with nulls when ~/.claude.json is unreadable and no sessions exist', async () => {
  expect(await readQuota(fakeEngine({}), 7)).toEqual({ claude: null, codex: null, readAt: 7 })
})

test('readQuota skips a newest session file whose rate_limits is null and uses the next one', async () => {
  const root = '/h/.codex/sessions'
  const day = `${root}/2026/10/13`
  const valid = JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 21, window_minutes: 10080 }, secondary: null } } })
  const nullOnly = JSON.stringify({ payload: { rate_limits: null } })
  const $ = fakeEngine({
    lists: {
      [root]: [dir('2026')],
      [`${root}/2026`]: [dir('10')],
      [`${root}/2026/10`]: [dir('13')],
      [day]: [file('old.jsonl', 100), file('new.jsonl', 200)],
    },
    files: { [`${day}/old.jsonl`]: valid, [`${day}/new.jsonl`]: nullOnly },
  })
  // a log line with no timestamp: the file's mtime stands in for the sample time
  expect(await readQuota($, 9)).toEqual({ claude: null, codex: { sevenDay: 21, sampledAt: 100 }, readAt: 9 })
})

const VALID = (pct: number) => JSON.stringify({ payload: { rate_limits: { primary: { used_percent: pct, window_minutes: 10080 }, secondary: null } } })

test('readQuota skips a session file over 4 MiB without reading it', async () => {
  const day = '/h/.codex/sessions/2026/10/13'
  const reads: string[] = []
  const io = fakeEngine({
    lists: {
      '/h/.codex/sessions': [dir('2026')], '/h/.codex/sessions/2026': [dir('10')], '/h/.codex/sessions/2026/10': [dir('13')],
      [day]: [file('huge.jsonl', 300, 4 * 1024 * 1024 + 1), file('small.jsonl', 100)],
    },
    files: { [`${day}/huge.jsonl`]: VALID(99), [`${day}/small.jsonl`]: VALID(12) },
  })
  const read = io.read
  io.read = async path => { reads.push(path); return read(path) }
  expect((await readQuota(io, 1)).codex).toEqual({ sevenDay: 12, sampledAt: 100 })
  expect(reads.includes(`${day}/huge.jsonl`)).toBe(false)
})

test('readQuota walks back to an older day directory when the newest day has no usable file', async () => {
  const root = '/h/.codex/sessions'
  const io = fakeEngine({
    lists: {
      [root]: [dir('2026')],
      [`${root}/2026`]: [dir('09'), dir('10')],
      [`${root}/2026/10`]: [dir('13'), dir('12')],
      [`${root}/2026/10/13`]: [file('a.jsonl', 300), file('b.jsonl', 200)],
      [`${root}/2026/10/12`]: [],
      [`${root}/2026/09`]: [dir('30')],
      [`${root}/2026/09/30`]: [file('old.jsonl', 100)],
    },
    files: {
      [`${root}/2026/10/13/a.jsonl`]: JSON.stringify({ payload: { rate_limits: null } }),
      [`${root}/2026/10/13/b.jsonl`]: 'not json',
      [`${root}/2026/09/30/old.jsonl`]: VALID(44),
    },
  })
  expect((await readQuota(io, 2)).codex).toEqual({ sevenDay: 44, sampledAt: 100 })
})

test('readQuota reads Codex sessions under CODEX_HOME when it is set', async () => {
  const root = '/custom/codex/sessions'
  const io = fakeEngine({
    codexHome: '/custom/codex',
    lists: { [root]: [dir('2026')], [`${root}/2026`]: [dir('10')], [`${root}/2026/10`]: [dir('13')], [`${root}/2026/10/13`]: [file('s.jsonl', 1)] },
    files: { [`${root}/2026/10/13/s.jsonl`]: VALID(5) },
  })
  expect((await readQuota(io, 3)).codex).toEqual({ sevenDay: 5, sampledAt: 1 })
})

test('readQuota stops after 20 session files', async () => {
  const day = '/h/.codex/sessions/2026/10/13'
  const names = Array.from({ length: 25 }, (_, i) => `f${i}.jsonl`)
  let reads = 0
  const io = fakeEngine({
    lists: {
      '/h/.codex/sessions': [dir('2026')], '/h/.codex/sessions/2026': [dir('10')], '/h/.codex/sessions/2026/10': [dir('13')],
      [day]: names.map((n, i) => file(n, 1000 - i)),
    },
    // only the oldest file parses, and it lies past the bound
    files: Object.fromEntries(names.map((n, i) => [`${day}/${n}`, i === 24 ? VALID(9) : '{}'])),
  })
  const read = io.read
  io.read = async path => { reads++; return read(path) }
  expect((await readQuota(io, 4)).codex).toBeNull()
  // the 20 session files plus ~/.claude.json
  expect(reads).toBe(21)
})

// copies of skills/spick/scripts/testdata/claude_cache_with_limits.json, claude_cache_no_limits.json and
// codex_rollout_line.jsonl (quota.py's parsers are tested against the same files)
const CLAUDE_WITH_LIMITS = {
  cachedUsageUtilization: {
    fetchedAtMs: 1791884005705,
    utilization: {
      five_hour: { utilization: 19, resets_at: '2026-10-13T10:19:59.536299+00:00' },
      seven_day: { utilization: 9, resets_at: '2026-10-20T00:59:59.536324+00:00' },
      limits: [
        { kind: 'session', group: 'session', percent: 19, severity: 'normal', resets_at: '2026-10-13T10:19:59.536299+00:00', scope: null, is_active: true },
        { kind: 'weekly_all', group: 'weekly', percent: 9, severity: 'normal', resets_at: '2026-10-20T00:59:59.536324+00:00', scope: null, is_active: false },
        { kind: 'weekly_scoped', group: 'weekly', percent: 12, severity: 'normal', resets_at: '2026-10-20T00:59:59.536544+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
      ],
    },
  },
}
const CODEX_LINE = '{"timestamp": "2026-10-13T06:54:34.941Z", "type": "event_msg", "payload": {"type": "token_count", "rate_limits": {"limit_id": "codex", "limit_name": null, "primary": {"used_percent": 23.0, "window_minutes": 10080, "resets_at": 1792472309}, "secondary": null, "credits": {"has_credits": false, "unlimited": false, "balance": "0"}, "individual_limit": null, "spend_control_reached": null, "plan_type": "prolite", "rate_limit_reached_type": null}}}'
const SAMPLE_NOW = Date.parse('2026-10-13T08:00:00Z')

test('parseClaudeUsage reads limits[] as quota.py does: session is 5h, weekly_all 7d, a scoped weekly no meter; sampledAt is fetchedAtMs', () => {
  expect(parseClaudeUsage(JSON.stringify(CLAUDE_WITH_LIMITS), SAMPLE_NOW)).toEqual({ fiveHour: 19, sevenDay: 9, sampledAt: 1791884005705 })
  // limits[] wins over utilization.*
  const differ = structuredClone(CLAUDE_WITH_LIMITS)
  differ.cachedUsageUtilization.utilization.five_hour.utilization = 77
  expect(parseClaudeUsage(JSON.stringify(differ), SAMPLE_NOW)?.fiveHour).toBe(19)
  // no limits[]: utilization.*
  const { limits: _, ...noLimits } = CLAUDE_WITH_LIMITS.cachedUsageUtilization.utilization
  expect(parseClaudeUsage(JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: 1791884005705, utilization: noLimits } }), SAMPLE_NOW)).toEqual({ fiveHour: 19, sevenDay: 9, sampledAt: 1791884005705 })
})

test('a window whose reset has passed is left out, never read as its old figure', () => {
  const later = Date.parse('2026-10-13T11:00:00Z')
  expect(parseClaudeUsage(JSON.stringify(CLAUDE_WITH_LIMITS), later)).toEqual({ sevenDay: 9, sampledAt: 1791884005705 })
  expect(parseClaudeUsage(JSON.stringify(CLAUDE_WITH_LIMITS), Date.parse('2026-10-21T00:00:00Z'))).toBeNull()
  expect(parseCodexRateLimits(CODEX_LINE, 1792472309 * 1000 + 1)).toBeNull()
})

test('parseCodexRateLimits takes the sample time from its log line\'s timestamp, and resets_at in epoch seconds', () => {
  expect(parseCodexRateLimits(CODEX_LINE, SAMPLE_NOW)).toEqual({ sevenDay: 23, sampledAt: Date.parse('2026-10-13T06:54:34.941Z') })
})
