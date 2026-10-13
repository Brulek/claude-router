import { test, expect } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { parseClaudeUsage, parseCodexRateLimits, readQuota } from './quota'

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

type Entry = { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }
const dir = (name: string): Entry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
const file = (name: string, mtimeMs: number): Entry => ({ name, kind: 'file', size: 1, mtimeMs, isLink: false })

function fakeEngine(opts: { home?: () => Promise<string | undefined>; files?: Record<string, string>; lists?: Record<string, Entry[]> }): EngineInterface {
  return {
    env: { get: opts.home ?? (async () => '/h') },
    fs: {
      read: async (path: string) => {
        const text = opts.files?.[path]
        if (text === undefined) throw new Error('ENOENT ' + path)
        return text
      },
      list: async (path: string) => opts.lists?.[path] ?? [],
    },
  } as unknown as EngineInterface
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
  expect(await readQuota($, 9)).toEqual({ claude: null, codex: { sevenDay: 21 }, readAt: 9 })
})
