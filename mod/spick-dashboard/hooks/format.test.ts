import { test, expect } from 'claude-code/testing'
import {
  modelName, parseCli, isSourcePath, bandSegments, table, quotaBar,
  fmtDuration, fmtCost, estimateCost, quotaMeters, verbOf, displayWidth, MAIN_LANE,
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

const L = (b: { left: { text: string }[] }) => b.left.map(s => s.text).join('')
const R = (b: { right: { text: string }[] }) => b.right.map(s => s.text).join('')

const mainActive = { lane: MAIN_LANE, model: 'Fable 5.1', effort: 'high', agents: 0, isIdle: false, durationMs: 12000 }
const coderActive = { lane: 'coder', model: 'Sonnet 5.5', effort: 'medium', agents: 2, agentIndex: 2, isIdle: false, durationMs: 44000, mainModel: 'Fable 5.1' }
const geminiActive = { lane: 'Gemini', model: 'gemini-3.8-flash', effort: 'low', agents: 0, isIdle: false, durationMs: 31000, mainModel: 'Fable 5.1' }
const METERS = [{ name: 'claude', pct: 8 }, { name: 'codex', pct: 37 }]
const WIDE_METERS = 'claude ▰▱▱▱▱▱▱▱▱▱ 8%   codex ▰▰▰▰▱▱▱▱▱▱ 37%'
const coderIdle = { lane: 'coder', model: 'Sonnet 5.5', effort: 'medium', agents: 0, isIdle: true, durationMs: 134000, meters: METERS }
const mainIdle = { lane: MAIN_LANE, model: 'Fable 5.1', effort: 'high', agents: 0, isIdle: true, durationMs: 36000, meters: METERS }

test('bandSegments reads the spec sample sentences at 90+ columns', () => {
  expect(L(bandSegments(mainActive, 100))).toBe('spick   Working · Fable 5.1 · high effort · 12s')
  // no provider known: the hint
  expect(R(bandSegments(mainActive, 100))).toBe('/spick for details')
  expect(R(bandSegments({ ...mainActive, meters: METERS }, 120))).toBe(WIDE_METERS)
  expect(L(bandSegments(coderActive, 100))).toBe('spick   coder is working · Sonnet 5.5 · medium effort · agent 2 of 2 · 44s')
  expect(R(bandSegments(coderActive, 100))).toBe('main: Fable 5.1')
  expect(L(bandSegments(geminiActive, 100))).toBe('spick   Gemini is searching · gemini-3.8-flash · low effort · 31s')
  expect(R(bandSegments(geminiActive, 100))).toBe('main: Fable 5.1')
  expect(L(bandSegments(coderIdle, 100))).toBe('spick   Idle · last turn: coder on Sonnet 5.5 · medium effort · took 2m 14s')
  expect(R(bandSegments(coderIdle, 160))).toBe(WIDE_METERS)
  expect(L(bandSegments(mainIdle, 100))).toBe('spick   Idle · last turn: Fable 5.1 · high effort · took 36s')
  expect(R(bandSegments(mainIdle, 160))).toBe(WIDE_METERS)
})

test('bandSegments attention samples: the cause replaces the right group, only the cause is colored', () => {
  const haiku = { lane: MAIN_LANE, model: 'Haiku 5.5', effort: 'low', agents: 0, isIdle: false, durationMs: 8000 }
  const edited = bandSegments({ ...haiku, note: { kind: 'error' as const, text: 'edited src/lru.py' } }, 100)
  expect(L(edited)).toBe('spick   Working · Haiku 5.5 · low effort · 8s')
  expect(R(edited)).toBe('edited src/lru.py')
  expect(edited.right).toEqual([{ text: 'edited ', style: 'plain' }, { text: 'src/lru.py', style: 'error' }])
  const review = bandSegments({ ...coderActive, agents: 1, agentIndex: 1, note: { kind: 'warning' as const, text: 'review: codex' } }, 100)
  expect(L(review)).toBe('spick   coder is working · Sonnet 5.5 · medium effort · 44s')
  expect(review.right).toEqual([{ text: 'review: codex', style: 'warning' }])
  // a cause wins over the meters
  expect(bandSegments({ ...haiku, meters: METERS, note: { kind: 'error' as const, text: 'edited src/lru.py' } }, 120).right).toEqual(edited.right)
})

test('bandSegments styles: bold wordmark in brand, three spaces, bold lane, idle all dim', () => {
  const b = bandSegments(coderActive, 100)
  expect(b.left[0]).toEqual({ text: 'spick', style: 'brand' })
  expect(b.left[1]?.text).toBe('   ')
  expect(b.left[2]).toEqual({ text: 'coder', style: 'lane' })
  expect(b.left[3]).toEqual({ text: ' is working', style: 'plain' })
  expect(bandSegments(mainActive, 100).left[2]).toEqual({ text: 'Working', style: 'lane' })
  const idle = bandSegments(coderIdle, 100)
  expect([...idle.left.slice(2), ...idle.right].filter(s => s.text.trim() !== '').every(s => s.style === 'dim')).toBe(true)
})

test('bandSegments verbs by lane: Codex reviews only on a review call', () => {
  const codex = { lane: 'Codex', model: '', agents: 0, isIdle: false, durationMs: 5000 }
  expect(L(bandSegments(codex, 100))).toBe('spick   Codex is working · 5s')
  expect(L(bandSegments({ ...codex, isReview: true }, 100))).toBe('spick   Codex is reviewing · 5s')
  expect(L(bandSegments({ ...codex, lane: 'Grok' }, 100))).toBe('spick   Grok is fetching X · 5s')
  expect(verbOf('Gemini')).toBe('is searching')
  expect(verbOf('planner')).toBe('is working')
})

test('bandSegments drops the agent ordinal for a single agent or the main session', () => {
  expect(L(bandSegments({ ...coderActive, agents: 1, agentIndex: 1 }, 100))).not.toContain('agent ')
  expect(L(bandSegments({ ...mainActive, agents: 2 }, 100))).not.toContain('agent ')
})

test('bandSegments width tiers: 90+, 70-89, 50-69, 40-49, under 40', () => {
  const warned = { ...coderActive, note: { kind: 'warning' as const, text: 'review: codex' } }
  // 90-109: meters with five-cell bars; 110+: ten cells
  const short = { ...mainActive, durationMs: undefined, meters: METERS }
  expect(R(bandSegments(short, 109))).toBe('claude ▱▱▱▱▱ 8%   codex ▰▰▱▱▱ 37%')
  expect(R(bandSegments(short, 90))).toBe('claude ▱▱▱▱▱ 8%   codex ▰▰▱▱▱ 37%')
  expect(R(bandSegments(short, 110))).toBe(WIDE_METERS)
  // 70-89: no right group except an attention cause
  expect(L(bandSegments(coderActive, 80))).toBe('spick   coder is working · Sonnet 5.5 · medium effort · agent 2 of 2 · 44s')
  expect(R(bandSegments(coderActive, 80))).toBe('')
  expect(R(bandSegments(mainActive, 89))).toBe('')
  expect(R(bandSegments(coderIdle, 89))).toBe('')
  expect(R(bandSegments({ ...mainActive, meters: METERS }, 89))).toBe('')
  expect(R(bandSegments(warned, 80))).toBe('review: codex')
  // 50-69: also no agent ordinal and no elapsed; effort keeps its word
  expect(L(bandSegments(coderActive, 60))).toBe('spick   coder is working · Sonnet 5.5 · medium effort')
  // measured fitting then drops took and effort from the 75-cell idle sentence
  expect(L(bandSegments(coderIdle, 60))).toBe('spick   Idle · last turn: coder on Sonnet 5.5')
  expect(R(bandSegments(warned, 60))).toBe('review: codex')
  // 40-49: also no effort; the cause and the idle duration still show
  expect(L(bandSegments(coderActive, 45))).toBe('spick   coder is working · Sonnet 5.5')
  expect(R(bandSegments(warned, 45))).toBe('review: codex')
  // the idle duration still shows at 40-49 when it fits
  expect(L(bandSegments({ ...mainIdle, model: 'Haiku 5.5', durationMs: 6000 }, 45))).toBe('spick   Idle · last turn: Haiku 5.5 · took 6s')
  expect(L(bandSegments(coderIdle, 45))).toBe('spick   Idle · last turn: coder on Sonnet 5.5')
  // under 40: wordmark, lane or Working, model
  expect(L(bandSegments(coderActive, 35))).toBe('spick · coder · Sonnet 5.5')
  expect(L(bandSegments(mainActive, 35))).toBe('spick · Working · Fable 5.1')
  expect(R(bandSegments(warned, 35))).toBe('')
  expect(L(bandSegments(coderIdle, 35))).toBe('spick · Idle · Sonnet 5.5')
})

test('bandSegments meters: a hot provider is warning as a whole, the others subtle, three spaces apart', () => {
  const b = bandSegments({ ...coderIdle, meters: [{ name: 'claude', pct: 8 }, { name: 'codex', pct: 83 }] }, 160)
  expect(b.right).toEqual([
    { text: 'claude ▰▱▱▱▱▱▱▱▱▱ 8%', style: 'dim' },
    { text: '   ', style: 'plain' },
    { text: 'codex ▰▰▰▰▰▰▰▰▱▱ 83%', style: 'warning' },
  ])
  expect(bandSegments({ ...mainActive, meters: [{ name: 'claude', pct: 80 }] }, 100).right).toEqual([{ text: 'claude ▰▰▰▰▱ 80%', style: 'warning' }])
})

test('bandSegments right group fallbacks: idle with no provider is empty, active main shows the hint, a delegate names the main model', () => {
  expect(R(bandSegments({ ...coderIdle, meters: [] }, 120))).toBe('')
  expect(R(bandSegments({ ...coderIdle, meters: undefined }, 120))).toBe('')
  expect(R(bandSegments({ ...mainActive, meters: [] }, 120))).toBe('/spick for details')
  expect(R(bandSegments({ ...coderActive, meters: METERS }, 120))).toBe('main: Fable 5.1')
  expect(L(bandSegments({ ...mainIdle, model: '' }, 100))).toBe('spick   Idle · last turn: main session · high effort · took 36s')
})

test('bandSegments active delegate without a known main model falls through to the meters, then the hint', () => {
  const noMain = { ...coderActive, mainModel: undefined }
  expect(bandSegments({ ...noMain, meters: METERS }, 160).right).toEqual(bandSegments({ ...mainActive, meters: METERS }, 160).right)
  expect(R(bandSegments({ ...noMain, meters: METERS }, 160))).toBe(WIDE_METERS)
  expect(R(bandSegments({ ...noMain, meters: [] }, 120))).toBe('/spick for details')
})

const W = (b: { left: { text: string }[]; right: { text: string }[] }) =>
  displayWidth(L(b)) + (b.right.length > 0 ? 2 + displayWidth(R(b)) : 0)

test('displayWidth counts the meter glyphs and CJK as two cells', () => {
  expect(displayWidth('▰▱')).toBe(4)
  expect(displayWidth('claude ▰▱▱▱▱▱▱▱▱▱ 8%')).toBe(30)
  expect(displayWidth('spick · coder')).toBe(13)
  expect(displayWidth('中文')).toBe(4)
})

test('bandSegments fits by measured width: a right group that would overflow goes first', () => {
  const codexReview = { lane: 'Codex', isReview: true, model: 'gpt-5.5-mini', effort: 'low', agents: 0, isIdle: false, durationMs: 9000, meters: METERS }
  const b = bandSegments(codexReview, 100)
  // the tier output: a 59-cell sentence, the gap and 43 cells of five-cell meters, 104 in all
  expect(displayWidth(L(b)) + 2 + displayWidth('claude ▱▱▱▱▱ 8%   codex ▰▰▱▱▱ 37%')).toBe(104)
  expect(L(b)).toBe('spick   Codex is reviewing · gpt-5.5-mini · low effort · 9s')
  expect(b.right).toEqual([])
  expect(W(b)).toBeLessThanOrEqual(100)
})

test('bandSegments fits a 60-column idle view by dropping took, then effort', () => {
  const b = bandSegments(coderIdle, 60)
  expect(W(b)).toBeLessThanOrEqual(60)
  expect(L(b)).toBe('spick   Idle · last turn: coder on Sonnet 5.5')
  // narrower still: the wording goes (bare lane and model), then the model
  expect(L(bandSegments(coderIdle, 42))).toBe('spick   Idle · coder · Sonnet 5.5')
})

test('bandSegments keeps an attention cause at 45 columns and drops left segments instead', () => {
  const review = bandSegments({ ...coderActive, note: { kind: 'warning' as const, text: 'review: codex' } }, 45)
  expect(review.right).toEqual([{ text: 'review: codex', style: 'warning' }])
  expect(L(review)).toBe('spick   coder · Sonnet 5.5')
  expect(W(review)).toBeLessThanOrEqual(45)
  const edited = bandSegments({ ...mainActive, model: 'Haiku 5.5', note: { kind: 'error' as const, text: 'edited src/lru.py' } }, 40)
  expect(R(edited)).toBe('edited src/lru.py')
  expect(L(edited)).toBe('spick   Working')
})

test('every sample view fits its columns by measured width', () => {
  const note = (kind: 'warning' | 'error', text: string) => ({ note: { kind, text } })
  const views = [
    mainActive, coderActive, geminiActive, coderIdle, mainIdle,
    { ...mainActive, meters: METERS }, { ...coderActive, mainModel: undefined, meters: METERS },
    { ...mainIdle, meters: [{ name: 'claude', pct: 8 }, { name: 'codex', pct: 83 }] },
    { ...mainActive, model: 'Haiku 5.5', effort: 'low', durationMs: 8000, ...note('error', 'edited src/lru.py') },
    { ...coderActive, ...note('warning', 'review: codex') },
    { lane: 'Codex', isReview: true, model: 'gpt-5.5-mini', effort: 'low', agents: 0, isIdle: false, durationMs: 9000, meters: METERS },
  ]
  for (const v of views) {
    for (const columns of [40, 45, 60, 80, 90, 100, 110, 140]) {
      const b = bandSegments(v, columns)
      expect(displayWidth(L(b)) + (b.right.length > 0 ? 2 + displayWidth(R(b)) : 0) <= columns).toBe(true)
    }
  }
})

test('quotaMeters counts only finite values: a NaN weekly falls back to a finite five-hour, none at all omits the provider', () => {
  expect(quotaMeters({ claude: { sevenDay: NaN, fiveHour: 12 }, codex: { sevenDay: 37 }, readAt: 0 })).toEqual([{ name: 'claude', pct: 12 }, { name: 'codex', pct: 37 }])
  expect(quotaMeters({ claude: { sevenDay: NaN }, codex: { sevenDay: Infinity, fiveHour: NaN }, readAt: 0 })).toEqual([])
})

test('quotaMeters takes the weekly window per known provider, five-hour when the weekly is unknown', () => {
  expect(quotaMeters({ claude: { fiveHour: 5, sevenDay: 8 }, codex: { sevenDay: 37 }, readAt: 0 })).toEqual(METERS)
  expect(quotaMeters({ claude: { fiveHour: 12 }, codex: null, readAt: 0 })).toEqual([{ name: 'claude', pct: 12 }])
  expect(R(bandSegments({ ...coderIdle, meters: quotaMeters({ claude: { fiveHour: 12 }, codex: null, readAt: 0 }) }, 120))).toBe('claude ▰▱▱▱▱▱▱▱▱▱ 12%')
  expect(quotaMeters({ claude: null, codex: null, readAt: 0 })).toEqual([])
  expect(quotaMeters(null)).toEqual([])
})

test('table pads columns and right-aligns numbers, with em dash for unpriced', () => {
  const rows = table([
    ['lane', 'turns', 'est. cost'],
    ['main session', '11', '$0.04'],
    ['Gemini', '2', '—'],
  ], ['l', 'r', 'r'])
  expect(rows[1]).toBe('main session     11      $0.04')
  expect(rows[2]).toBe('Gemini            2          —')
  expect(new Set(rows.map(r => r.length)).size).toBe(1)
})

test('quotaBar draws a non-finite input as all cells free', () => {
  expect(quotaBar(NaN)).toBe('▱▱▱▱▱▱▱▱▱▱')
  expect(quotaBar(Infinity, 5)).toBe('▱▱▱▱▱')
  expect(quotaBar(-Infinity)).toBe('▱▱▱▱▱▱▱▱▱▱')
})

test('quotaBar renders ten cells, or as many as asked', () => {
  expect(quotaBar(8, 5)).toBe('▱▱▱▱▱')
  expect(quotaBar(37, 5)).toBe('▰▰▱▱▱')
  expect(quotaBar(50, 5)).toBe('▰▰▰▱▱')
  expect(quotaBar(100, 5)).toBe('▰▰▰▰▰')
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
