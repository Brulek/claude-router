import { test, expect } from 'claude-code/testing'
import {
  modelName, parseCli, isSourcePath, bandSegments, table, quotaBar,
  fmtDuration, fmtCost, estimateCost,
} from './format'

test('modelName maps Claude ids to display names and leaves others alone', () => {
  expect(modelName('claude-haiku-5-5')).toBe('Haiku 5.5')
  expect(modelName('claude-sonnet-5-5')).toBe('Sonnet 5.5')
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelName('claude-fable-5-1')).toBe('Fable 5.1')
  expect(modelName('gemini-3.8-flash-medium')).toBe('gemini-3.8-flash-medium')
})

test('parseCli recognises the three CLIs and their model/effort flags', () => {
  expect(parseCli('agy -p "find it" --model gemini-3.8-flash-low --effort low')).toEqual(
    { lane: 'Gemini', model: 'gemini-3.8-flash-low', effort: 'low', isReview: false })
  expect(parseCli('grok -p "x" -m grok-4.7 --effort medium')).toEqual(
    { lane: 'Grok', model: 'grok-4.7', effort: 'medium', isReview: false })
  expect(parseCli(`git diff | codex exec --skip-git-repo-check --sandbox read-only -c 'model_reasoning_effort="high"' "Review this diff"`)).toEqual(
    { lane: 'Codex', effort: 'high', isReview: true })
  expect(parseCli('codex exec --sandbox workspace-write "fix it" < /dev/null')).toEqual(
    { lane: 'Codex', isReview: false })
})

test('parseCli ignores CLI names inside quoted strings and ordinary words', () => {
  expect(parseCli('echo "remember to run agy later"')).toBeNull()
  expect(parseCli('ls agyfolder')).toBeNull()
  expect(parseCli('python3 -m pytest')).toBeNull()
})

test('parseCli requires the CLI in command position, not just anywhere', () => {
  expect(parseCli('grep -r grok .')).toBeNull()
  expect(parseCli('which agy')).toBeNull()
  expect(parseCli('brew install grok')).toBeNull()
  expect(parseCli('man agy')).toBeNull()
})

test('parseCli accepts path invocations and env/npx/sudo/time prefixes', () => {
  expect(parseCli('~/.local/bin/agy -p "x"')?.lane).toBe('Gemini')
  expect(parseCli('/opt/homebrew/bin/codex exec "fix"')?.lane).toBe('Codex')
  expect(parseCli('npx agy -p "x"')?.lane).toBe('Gemini')
  expect(parseCli('cd /tmp && time grok -p "x"')?.lane).toBe('Grok')
})

test('parseCli finds a CLI on a later line of a multi-line command', () => {
  expect(parseCli('cd /repo\nagy -p "find it" --model gemini-3.8-flash')).toEqual({ lane: 'Gemini', model: 'gemini-3.8-flash', isReview: false })
  expect(parseCli('echo start\n  grok -p "x"')?.lane).toBe('Grok')
  // a backslash-newline continues the same command, so its flags still count
  expect(parseCli('agy -p "x" \\\n  --effort low')?.effort).toBe('low')
  // a newline inside quotes is not a command boundary
  expect(parseCli('echo "line one\nagy -p x"')).toBeNull()
})

test('parseCli marks Codex review only when the prompt says review as a word', () => {
  expect(parseCli('codex exec "build the preview pane"')?.isReview).toBe(false)
  expect(parseCli('codex exec "Review this diff for bugs"')?.isReview).toBe(true)
  expect(parseCli('codex exec --sandbox read-only "fix" < docs/code-review.md')?.isReview).toBe(false)
})

test('isSourcePath excludes docs, data, plan files and .claude', () => {
  expect(isSourcePath('src/lru.py')).toBe(true)
  expect(isSourcePath('scripts/quota.sh')).toBe(true)
  expect(isSourcePath('README.md')).toBe(false)
  expect(isSourcePath('/Users/x/.claude/plans/1-foo.md')).toBe(false)
  expect(isSourcePath('data/report.csv')).toBe(false)
  expect(isSourcePath('config.json')).toBe(false)
})

const view = { lane: 'coder', model: 'Sonnet 5.5', effort: 'medium', agents: 2, agentIndex: 1, isIdle: false }

test('bandSegments shows everything at 80 columns', () => {
  const texts = bandSegments(view, 80).map(s => s.text)
  expect(texts).toEqual(['spick', ' · ', 'coder', ' · ', 'Sonnet 5.5', ' · ', 'medium', ' · ', '1 of 2 agents', '/spick for details'])
  expect(bandSegments(view, 80)[0]?.style).toBe('brand')
  expect(bandSegments(view, 80)[2]?.style).toBe('lane')
})

test('bandSegments counts the showing agent by its ordinal, and drops the count when no agent shows', () => {
  expect(bandSegments({ ...view, lane: 'planner', agentIndex: 2 }, 80).map(s => s.text)).toContain('2 of 2 agents')
  const main = { lane: 'you', model: 'Haiku 5.5', effort: 'low', agents: 2, isIdle: false }
  expect(bandSegments(main, 80).map(s => s.text)).toEqual(['spick', ' · ', 'you', ' · ', 'Haiku 5.5', ' · ', 'low', '/spick for details'])
})

test('bandSegments drops hint and agent count below 70, effort below 50, keeps lane+model below 40', () => {
  expect(bandSegments(view, 60).map(s => s.text)).toEqual(['spick', ' · ', 'coder', ' · ', 'Sonnet 5.5', ' · ', 'medium'])
  expect(bandSegments(view, 45).map(s => s.text)).toEqual(['spick', ' · ', 'coder', ' · ', 'Sonnet 5.5'])
  expect(bandSegments(view, 30).map(s => s.text)).toEqual(['spick', ' · ', 'coder', ' · ', 'Sonnet 5.5'])
})

test('bandSegments idle state prefixes last:, appends duration, and drops the hint', () => {
  const idle = { ...view, isIdle: true, durationMs: 134000, agents: 0 }
  expect(bandSegments(idle, 80).map(s => s.text)).toEqual(['spick', ' · ', 'last: coder', ' · ', 'Sonnet 5.5', ' · ', 'medium', ' · ', '2m 14s'])
  expect(bandSegments(idle, 80).slice(2).every(s => s.style === 'dim')).toBe(true)
})

test('bandSegments attention note replaces the hint and carries its color', () => {
  const warned = { ...view, agents: 0, note: { kind: 'warning' as const, text: 'codex 7d 83%' } }
  const segs = bandSegments(warned, 80)
  expect(segs[segs.length - 1]).toEqual({ text: 'codex 7d 83%', style: 'warning' })
  expect(segs.some(s => s.text === '/spick for details')).toBe(false)
})

test('bandSegments keeps the cause and the idle wall time at 40-49 columns, drops both below 40', () => {
  const warned = { ...view, agents: 0, note: { kind: 'warning' as const, text: 'codex 7d 83%' } }
  const idle = { ...view, isIdle: true, durationMs: 134000, agents: 0 }
  expect(bandSegments(warned, 45).map(s => s.text)).toEqual(['spick', ' · ', 'coder', ' · ', 'Sonnet 5.5', 'codex 7d 83%'])
  expect(bandSegments(warned, 45).at(-1)).toEqual({ text: 'codex 7d 83%', style: 'warning' })
  expect(bandSegments(idle, 45).map(s => s.text)).toEqual(['spick', ' · ', 'last: coder', ' · ', 'Sonnet 5.5', ' · ', '2m 14s'])
  expect(bandSegments(warned, 35).map(s => s.text)).toEqual(['spick', ' · ', 'coder', ' · ', 'Sonnet 5.5'])
  expect(bandSegments(idle, 35).map(s => s.text)).toEqual(['spick', ' · ', 'last: coder', ' · ', 'Sonnet 5.5'])
})

test('table pads columns and right-aligns numbers, with em dash for unpriced', () => {
  const rows = table([
    ['lane', 'turns', 'est. cost'],
    ['you', '11', '$0.04'],
    ['Gemini', '2', '—'],
  ], ['l', 'r', 'r'])
  expect(rows[1]).toBe('you        11      $0.04')
  expect(rows[2]).toBe('Gemini      2          —')
  expect(new Set(rows.map(r => r.length)).size).toBe(1)
})

test('quotaBar renders ten cells', () => {
  expect(quotaBar(0)).toBe('▱▱▱▱▱▱▱▱▱▱')
  expect(quotaBar(30)).toBe('▰▰▰▱▱▱▱▱▱▱')
  expect(quotaBar(83)).toBe('▰▰▰▰▰▰▰▰▱▱')
  expect(quotaBar(100)).toBe('▰▰▰▰▰▰▰▰▰▰')
})

test('formatters', () => {
  expect(fmtDuration(6000)).toBe('6s')
  expect(fmtDuration(134000)).toBe('2m 14s')
  expect(fmtCost(0.0412)).toBe('$0.04')
  expect(fmtCost(null)).toBe('—')
  // toBeCloseTo is not in the engine's test kit; compare with a tolerance by hand
  const haiku = estimateCost('claude-haiku-5-5', { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  expect(haiku !== null && Math.abs(haiku - 0.1) < 1e-5).toBe(true)
  // cache writes are priced at 1.25 x input: Haiku 0.125, Sonnet 2.5, Opus 5 per million
  const writes = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000 }
  const near = (got: number | null, want: number) => got !== null && Math.abs(got - want) < 1e-5
  expect(near(estimateCost('claude-haiku-5-5', writes), 0.125)).toBe(true)
  expect(near(estimateCost('claude-sonnet-5-5', writes), 2.5)).toBe(true)
  expect(near(estimateCost('claude-opus-5-5', writes), 5)).toBe(true)
  const mixed = estimateCost('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 400_000 })
  expect(near(mixed, 2 + 1 + 0.2 + 1)).toBe(true)
  expect(estimateCost('gemini-3.8-flash', { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBeNull()
})
