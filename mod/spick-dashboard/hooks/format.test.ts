import { test, expect } from 'claude-code/testing'
import {
  modelName, parseCli, isSourcePath, bandSegments, table, quotaBar,
  fmtDuration, fmtAge, fmtCost, estimateCost, quotaMeters, verbOf, displayWidth, MAIN_LANE, runningLines,
  tagLine, wrapWords, usageLines, quotaCells, recentLines, clockOf, LABEL_W, HOTKEY_W, NARROW_BELOW,
  colWidths, usageRows, recentRows, runningRows, quotaWindows,
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

test('parseCli takes the lane id from invoke.py --lane', () => {
  expect(parseCli('python3 ~/.claude/skills/spick/scripts/invoke.py --lane glm --prompt-file /tmp/p.txt --model glm-5')).toEqual(
    { lane: 'glm', model: 'glm-5', isReview: false })
  expect(parseCli('cd x && python3 invoke.py --prompt-file p.txt --lane=qwen-local')).toEqual(
    { lane: 'qwen-local', isReview: false })
  expect(parseCli('python3 invoke.py --prompt-file p.txt')).toBeNull()
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

test('isSourcePath excludes notes, tables, logs, lock files and a leading .claude/; json, yaml and toml are source', () => {
  expect(isSourcePath('src/lru.py')).toBe(true)
  expect(isSourcePath('scripts/quota.sh')).toBe(true)
  expect(isSourcePath('README.md')).toBe(false)
  expect(isSourcePath('data/report.csv')).toBe(false)
  for (const f of ['notes.txt', 'a.tsv', 'run.log', 'Cargo.lock', 'yarn.lock', 'package-lock.json', 'pnpm-lock.yaml', 'docs/x.markdown']) expect(isSourcePath(f)).toBe(false)
  for (const f of ['config.json', '.github/workflows/ci.yml', 'docker-compose.yaml', 'pyproject.toml']) expect(isSourcePath(f)).toBe(true)
  expect(isSourcePath('/repo/.claude/plans/1-foo.py', '/repo')).toBe(false)
  expect(isSourcePath('.claude/settings.local.json', '/repo')).toBe(false)
})

test('isSourcePath counts Dockerfile, Makefile, Justfile, Rakefile and Gemfile; other extensionless names are not source', () => {
  for (const f of ['Dockerfile', 'build/Makefile', '/repo/Justfile', 'Rakefile', 'Gemfile', 'Dockerfile.dev']) expect(isSourcePath(f, '/repo')).toBe(true)
  for (const f of ['LICENSE', 'bin/run', 'makefile.md']) expect(isSourcePath(f, '/repo')).toBe(false)
})

test('isSourcePath judges the path relative to the session cwd: a worktree under .claude/worktrees/ is source (regression)', () => {
  expect(isSourcePath('/repo/.claude/worktrees/x/src/a.py', '/repo')).toBe(true)
  expect(isSourcePath('.claude/worktrees/x/src/a.py', '/repo')).toBe(true)
  expect(isSourcePath('/repo/.claude/worktrees/x/.claude/settings.local.json', '/repo')).toBe(false)
  expect(isSourcePath('/repo/.claude/worktrees/x/src/a.py', '/repo/.claude/worktrees/x')).toBe(true)
  // a .claude/ that is not leading (relative to cwd) does not exclude
  expect(isSourcePath('/elsewhere/.claude/hooks/a.py', '/repo')).toBe(true)
  expect(isSourcePath('./src/a.py', '/repo')).toBe(true)
})

const L = (b: { left: { text: string }[] }) => b.left.map(s => s.text).join('')
const R = (b: { right: { text: string }[] }) => b.right.map(s => s.text).join('')

const mainActive = { lane: MAIN_LANE, model: 'Fable 5.1', agents: 0, isIdle: false, durationMs: 12000 }
const coderActive = { lane: 'coder', model: 'Sonnet 5.5', agents: 2, agentIndex: 2, isIdle: false, durationMs: 44000, mainModel: 'Fable 5.1' }
const geminiActive = { lane: 'Gemini', model: 'gemini-3.8-flash', agents: 0, isIdle: false, durationMs: 31000, mainModel: 'Fable 5.1' }
const coderIdle = { lane: 'coder', model: 'Sonnet 5.5', agents: 0, isIdle: true, durationMs: 134000 }
const mainIdle = { lane: MAIN_LANE, model: 'Fable 5.1', agents: 0, isIdle: true, durationMs: 36000 }

test('bandSegments reads the spec sample sentences at 90+ columns', () => {
  expect(L(bandSegments(mainActive, 100))).toBe('SPICK   Working · Fable 5.1 · 12s')
  expect(R(bandSegments(mainActive, 100))).toBe('/spick for details')
  expect(L(bandSegments(coderActive, 100))).toBe('SPICK   coder is working · Sonnet 5.5 · agent 2 of 2 · 44s')
  expect(R(bandSegments(coderActive, 100))).toBe('main: Fable 5.1')
  expect(L(bandSegments(geminiActive, 100))).toBe('SPICK   Gemini is searching · gemini-3.8-flash · 31s')
  expect(R(bandSegments(geminiActive, 100))).toBe('main: Fable 5.1')
  // idle: no duration, nothing on the right
  expect(L(bandSegments(coderIdle, 100))).toBe('SPICK   Idle · last turn: coder on Sonnet 5.5')
  expect(R(bandSegments(coderIdle, 160))).toBe('')
  expect(L(bandSegments(mainIdle, 100))).toBe('SPICK   Idle · last turn: Fable 5.1')
  expect(R(bandSegments(mainIdle, 160))).toBe('')
})

test('bandSegments attention samples: the cause replaces the right group, only the cause is colored', () => {
  const haiku = { lane: MAIN_LANE, model: 'Haiku 5.5', agents: 0, isIdle: false, durationMs: 8000 }
  const edited = bandSegments({ ...haiku, note: { kind: 'error' as const, text: 'edited src/lru.py' } }, 100)
  expect(L(edited)).toBe('SPICK   Working · Haiku 5.5 · 8s')
  expect(R(edited)).toBe('edited src/lru.py')
  expect(edited.right).toEqual([{ text: 'edited ', style: 'plain' }, { text: 'src/lru.py', style: 'error' }])
  const review = bandSegments({ ...coderActive, agents: 1, agentIndex: 1, note: { kind: 'warning' as const, text: 'review: codex' } }, 100)
  expect(L(review)).toBe('SPICK   coder is working · Sonnet 5.5 · 44s')
  expect(review.right).toEqual([{ text: 'review: codex', style: 'warning' }])
})

test('bandSegments styles: bold wordmark in brand, three spaces, bold lane, idle all dim', () => {
  const b = bandSegments(coderActive, 100)
  expect(b.left[0]).toEqual({ text: 'SPICK', style: 'brand' })
  expect(b.left[1]?.text).toBe('   ')
  expect(b.left[2]).toEqual({ text: 'coder', style: 'lane' })
  expect(b.left[3]).toEqual({ text: ' is working', style: 'plain' })
  expect(bandSegments(mainActive, 100).left[2]).toEqual({ text: 'Working', style: 'lane' })
  const idle = bandSegments(coderIdle, 100)
  expect([...idle.left.slice(2), ...idle.right].filter(s => s.text.trim() !== '').every(s => s.style === 'dim')).toBe(true)
})

test('bandSegments verbs by lane: Codex reviews only on a review call', () => {
  const codex = { lane: 'Codex', model: '', agents: 0, isIdle: false, durationMs: 5000 }
  expect(L(bandSegments(codex, 100))).toBe('SPICK   Codex is working · 5s')
  expect(L(bandSegments({ ...codex, isReview: true }, 100))).toBe('SPICK   Codex is reviewing · 5s')
  expect(L(bandSegments({ ...codex, lane: 'Grok' }, 100))).toBe('SPICK   Grok is fetching X · 5s')
  expect(verbOf('Gemini')).toBe('is searching')
  expect(verbOf('planner')).toBe('is working')
})

test('bandSegments drops the agent ordinal for a single agent or the main session', () => {
  expect(L(bandSegments({ ...coderActive, agents: 1, agentIndex: 1 }, 100))).not.toContain('agent ')
  expect(L(bandSegments({ ...mainActive, agents: 2 }, 100))).not.toContain('agent ')
})

test('bandSegments width tiers: 90+, 70-89, 40-69, under 40', () => {
  const warned = { ...coderActive, note: { kind: 'warning' as const, text: 'review: codex' } }
  // 90+: the right group shows while active
  expect(R(bandSegments(mainActive, 90))).toBe('/spick for details')
  expect(R(bandSegments(coderActive, 90))).toBe('main: Fable 5.1')
  // 70-89: no right group except an attention cause; ordinal and elapsed stay
  expect(L(bandSegments(coderActive, 80))).toBe('SPICK   coder is working · Sonnet 5.5 · agent 2 of 2 · 44s')
  expect(R(bandSegments(coderActive, 80))).toBe('')
  expect(R(bandSegments(mainActive, 89))).toBe('')
  expect(R(bandSegments(coderIdle, 89))).toBe('')
  expect(R(bandSegments(warned, 80))).toBe('review: codex')
  // 40-69: no agent ordinal, no elapsed
  expect(L(bandSegments(coderActive, 69))).toBe('SPICK   coder is working · Sonnet 5.5')
  expect(L(bandSegments(coderActive, 45))).toBe('SPICK   coder is working · Sonnet 5.5')
  expect(R(bandSegments(warned, 45))).toBe('review: codex')
  expect(L(bandSegments({ ...mainIdle, model: 'Haiku 5.5' }, 45))).toBe('SPICK   Idle · last turn: Haiku 5.5')
  expect(L(bandSegments(coderIdle, 45))).toBe('SPICK   Idle · last turn: coder on Sonnet 5.5')
  // under 40: wordmark, lane or Working, model
  expect(L(bandSegments(coderActive, 35))).toBe('SPICK · coder · Sonnet 5.5')
  expect(L(bandSegments(mainActive, 35))).toBe('SPICK · Working · Fable 5.1')
  expect(R(bandSegments(warned, 35))).toBe('')
  expect(L(bandSegments(coderIdle, 35))).toBe('SPICK · Idle · Sonnet 5.5')
})

test('bandSegments right group: idle is empty, active main shows the hint, a delegate names the main model', () => {
  expect(R(bandSegments(coderIdle, 120))).toBe('')
  expect(R(bandSegments(mainIdle, 120))).toBe('')
  expect(R(bandSegments(mainActive, 120))).toBe('/spick for details')
  expect(R(bandSegments(coderActive, 120))).toBe('main: Fable 5.1')
  expect(L(bandSegments({ ...mainIdle, model: '' }, 100))).toBe('SPICK   Idle · last turn: main session')
  // a delegate with no known main model falls back to the hint
  expect(R(bandSegments({ ...coderActive, mainModel: undefined }, 120))).toBe('/spick for details')
})

const W = (b: { left: { text: string }[]; right: { text: string }[] }) =>
  displayWidth(L(b)) + (b.right.length > 0 ? 2 + displayWidth(R(b)) : 0)

test('displayWidth counts the meter glyphs and CJK as two cells', () => {
  expect(displayWidth('▰▱')).toBe(4)
  expect(displayWidth('claude ▰▱▱▱▱▱▱▱▱▱ 8%')).toBe(30)
  expect(displayWidth('SPICK · coder')).toBe(13)
  expect(displayWidth('中文')).toBe(4)
})

test('bandSegments fits by measured width: a right group that would overflow goes first', () => {
  const longModel = { lane: 'Codex', isReview: true, model: 'gpt-5.5-mini-with-a-rather-long-name-x', agents: 0, isIdle: false, durationMs: 9000 }
  const b = bandSegments(longModel, 90)
  // the sentence takes 72 cells and the hint another 20, over 90 together
  expect(displayWidth(L(b)) + 2 + displayWidth('/spick for details')).toBeGreaterThan(90)
  expect(L(b)).toBe('SPICK   Codex is reviewing · gpt-5.5-mini-with-a-rather-long-name-x · 9s')
  expect(b.right).toEqual([])
  expect(W(b)).toBeLessThanOrEqual(90)
})

test('bandSegments with reserved columns: the tiers go by the band width, the fit by what the reserve leaves', () => {
  // 100 columns, 21 taken by the routing switch: the right group's tier (90) holds and it still fits in the 79 left
  const b = bandSegments(coderActive, 100, 21)
  expect(L(b)).toBe(L(bandSegments(coderActive, 100)))
  expect(R(b)).toBe('main: Fable 5.1')
  expect(W(b)).toBeLessThanOrEqual(79)
  // a reserve that leaves too little: the right group goes first, then the left gives up its parts
  const tight = bandSegments(coderActive, 100, 50)
  expect(tight.right).toEqual([])
  expect(W(tight)).toBeLessThanOrEqual(50)
})

test('bandSegments fits a narrow idle view by dropping the wording, then the model', () => {
  expect(L(bandSegments(coderIdle, 42))).toBe('SPICK   Idle · coder · Sonnet 5.5')
  expect(W(bandSegments(coderIdle, 42))).toBeLessThanOrEqual(42)
  expect(L(bandSegments(coderIdle, 20))).toBe('SPICK · Idle')
})

test('bandSegments keeps an attention cause at 45 columns and drops left segments instead', () => {
  const review = bandSegments({ ...coderActive, note: { kind: 'warning' as const, text: 'review: codex' } }, 45)
  expect(review.right).toEqual([{ text: 'review: codex', style: 'warning' }])
  expect(L(review)).toBe('SPICK   coder · Sonnet 5.5')
  expect(W(review)).toBeLessThanOrEqual(45)
  const edited = bandSegments({ ...mainActive, model: 'Haiku 5.5', note: { kind: 'error' as const, text: 'edited src/lru.py' } }, 40)
  expect(R(edited)).toBe('edited src/lru.py')
  expect(L(edited)).toBe('SPICK   Working')
})

test('every sample view fits its columns by measured width', () => {
  const note = (kind: 'warning' | 'error', text: string) => ({ note: { kind, text } })
  const views = [
    mainActive, coderActive, geminiActive, coderIdle, mainIdle,
    { ...mainActive, model: 'Haiku 5.5', durationMs: 8000, ...note('error', 'edited src/lru.py') },
    { ...coderActive, ...note('warning', 'review: codex') },
    { lane: 'Codex', isReview: true, model: 'gpt-5.5-mini', agents: 0, isIdle: false, durationMs: 9000 },
  ]
  for (const v of views) {
    for (const columns of [40, 45, 60, 80, 90, 100, 110, 140]) {
      expect(W(bandSegments(v, columns)) <= columns).toBe(true)
    }
  }
})

test('the band never says the old duration word or effort and never draws a quota bar, at any width', () => {
  const views = [mainActive, coderActive, geminiActive, coderIdle, mainIdle, { ...mainIdle, routingOff: true },
    { ...coderActive, note: { kind: 'warning' as const, text: 'review: codex' } }]
  for (const v of views) {
    for (const columns of [20, 35, 40, 45, 60, 70, 80, 90, 100, 120, 160]) {
      const b = bandSegments(v, columns)
      const text = L(b) + ' ' + R(b)
      expect(text).not.toContain('took')
      expect(text).not.toContain('effort')
      expect(text).not.toMatch(/[▰▱]/)
      expect(text).not.toMatch(/%/)
      expect(text).not.toMatch(/claude |codex /)
    }
  }
})

test('an idle band shows no duration at any width', () => {
  for (const columns of [40, 80, 120]) expect(L(bandSegments(mainIdle, columns))).not.toMatch(/\d+m? ?\d*s/)
})

test('quotaMeters counts only finite values: a NaN weekly falls back to a finite five-hour, none at all omits the provider', () => {
  expect(quotaMeters({ claude: { sevenDay: NaN, fiveHour: 12 }, codex: { sevenDay: 37 }, readAt: 0 })).toEqual([{ name: 'claude', window: '5h', pct: 12 }, { name: 'codex', window: '7d', pct: 37 }])
  expect(quotaMeters({ claude: { sevenDay: NaN }, codex: { sevenDay: Infinity, fiveHour: NaN }, readAt: 0 })).toEqual([])
})

test('quotaMeters takes the weekly window per known provider, five-hour when the weekly is unknown', () => {
  expect(quotaMeters({ claude: { fiveHour: 5, sevenDay: 8 }, codex: { sevenDay: 37 }, readAt: 0 })).toEqual([{ name: 'claude', window: '7d', pct: 8 }, { name: 'codex', window: '7d', pct: 37 }])
  expect(quotaMeters({ claude: { fiveHour: 12 }, codex: null, readAt: 0 })).toEqual([{ name: 'claude', window: '5h', pct: 12 }])
  expect(quotaMeters({ claude: null, codex: null, readAt: 0 })).toEqual([])
  expect(quotaMeters(null)).toEqual([])
})

test('table pads columns and right-aligns numbers, with em dash for unpriced', () => {
  const rows = table([
    ['lane', 'turns', 'at API rates'],
    ['main session', '11', '$0.04'],
    ['Gemini', '2', '—'],
  ], ['l', 'r', 'r'])
  expect(rows[1]).toBe('main session     11         $0.04')
  expect(rows[2]).toBe('Gemini            2             —')
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
  expect(fmtAge(0)).toBe('just now')
  expect(fmtAge(59_999)).toBe('just now')
  expect(fmtAge(60_000)).toBe('1m ago')
  expect(fmtAge(4 * 60_000)).toBe('4m ago')
  expect(fmtAge(2 * 3_600_000)).toBe('2h ago')
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
  // Fable 5.1: $10 in, $50 out, $0.25 cache read, 12.5 cache write; a session on Fable shows a cost in /spick spend
  expect(near(estimateCost('claude-fable-5-1', writes), 12.5)).toBe(true)
  expect(near(estimateCost('claude-fable-5-1', { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 }), 10 + 5 + 0.25)).toBe(true)
  const mixed = estimateCost('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 400_000 })
  expect(near(mixed, 2 + 1 + 0.2 + 1)).toBe(true)
  expect(estimateCost('gemini-3.8-flash', { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBeNull()
})

test('bandSegments: routing off puts a warning ` off` after the wordmark at every width', () => {
  const v = { lane: MAIN_LANE, model: 'Fable 5.1', agents: 0, isIdle: true, durationMs: 36_000, routingOff: true }
  const wide = bandSegments(v, 120)
  expect(wide.left.slice(0, 2)).toEqual([{ text: 'SPICK', style: 'brand' }, { text: ' off', style: 'warning' }])
  expect(wide.left.map(s => s.text).join('')).toBe('SPICK off   Idle · last turn: Fable 5.1')
  expect(bandSegments(v, 35).left.map(s => s.text).join('')).toBe('SPICK off · Idle · Fable 5.1')
  expect(bandSegments({ ...v, routingOff: false }, 120).left[1]).toEqual({ text: '   ', style: 'plain' })
  // the wordmark keeps its five cells, no letter spacing
  expect(displayWidth(bandSegments({ ...v, routingOff: false }, 120).left[0]!.text)).toBe(5)
})

test('bandSegments aggregates several agents of a lane: coder ×12 working, no ordinal; one agent reads as before', () => {
  const many = { ...coderActive, agents: 12, agentIndex: 12, count: 12, durationMs: 190000 }
  expect(L(bandSegments(many, 100))).toBe('SPICK   coder \u00d712 working · Sonnet 5.5 · 3m 10s')
  expect(bandSegments(many, 100).left[2]).toEqual({ text: 'coder \u00d712', style: 'lane' })
  expect(bandSegments(many, 100).left[3]).toEqual({ text: ' working', style: 'plain' })
  expect(R(bandSegments(many, 100))).toBe('main: Fable 5.1')
  expect(L(bandSegments({ ...many, lane: 'Gemini', count: 2 }, 100))).toContain('Gemini \u00d72 searching')
  expect(L(bandSegments({ ...many, lane: 'Codex', count: 2, isReview: true }, 100))).toContain('Codex \u00d72 reviewing')
  // narrow: the count stays with the lane
  expect(L(bandSegments(many, 30))).toBe('SPICK · coder \u00d712 · Sonnet 5.5')
  // one agent (count 1 or absent): exactly the old sentence, ordinal included
  expect(L(bandSegments({ ...coderActive, count: 1 }, 100))).toBe(L(bandSegments(coderActive, 100)))
  expect(L(bandSegments({ ...coderActive, count: 1 }, 100))).toBe('SPICK   coder is working · Sonnet 5.5 · agent 2 of 2 · 44s')
  // idle and main never show a count
  expect(L(bandSegments({ ...coderIdle, count: 3 }, 100))).toBe('SPICK   Idle · last turn: coder on Sonnet 5.5')
  expect(L(bandSegments({ ...mainActive, count: 3 }, 100))).toBe('SPICK   Working · Fable 5.1 · 12s')
})

test('runningLines caps at five rows and counts the rest; a timed-out row says why', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, lane: 'coder', model: 'Sonnet 5.5', startedAt: 1000 + i * 1000 }))
  const r = runningLines(rows, 200000)
  expect(r.lines).toHaveLength(5)
  expect(r.more).toBe(7)
  expect(r.lines[0]).toBe('coder  Sonnet 5.5  3m 19s')
  expect(runningLines(rows.slice(0, 5), 200000).more).toBe(0)
  const t = runningLines([{ ...rows[0]!, timedOutAt: 5 }], 200000)
  expect(t.lines[0]).toBe('coder  Sonnet 5.5  timed out, no completion signal')
})

test('the pane layout constants: a ten-column label, `r: ` is three, narrow starts below 64', () => {
  expect([LABEL_W, HOTKEY_W, NARROW_BELOW]).toEqual([10, 3, 64])
})

test('tagLine joins with ", " and ends with " +N" when the tags do not fit', () => {
  const tags = ['search', 'long-context', 'multimodal', 'image']
  expect(tagLine(tags, 52)).toBe('search, long-context, multimodal, image')
  expect(tagLine(tags, 39)).toBe('search, long-context, multimodal, image')
  // one short of fitting: as many tags as fit, then the count of the rest
  expect(tagLine(tags, 38)).toBe('search, long-context, multimodal +1')
  expect(tagLine(tags, 25)).toBe('search, long-context +2')
  expect(tagLine(tags, 25)).toMatch(/ \+2$/)
  expect(tagLine(tags, 10)).toBe('search +3')
  // not even the first tag and its count fit: cut, never longer than the width
  expect(tagLine(tags, 6).length).toBeLessThanOrEqual(6)
  expect(tagLine([], 20)).toBe('')
  expect(tagLine(['x-data'], 20)).toBe('x-data')
  for (let w = 1; w < 45; w++) expect(tagLine(tags, w).length).toBeLessThanOrEqual(Math.max(w, 0))
})

test('wrapWords breaks at spaces and cuts a word that is longer than the line', () => {
  expect(wrapWords('aa bb cc dd', 5)).toEqual(['aa bb', 'cc dd'])
  expect(wrapWords('aa bb cc dd', 2)).toEqual(['aa', 'bb', 'cc', 'dd'])
  expect(wrapWords('abcdefgh ij', 5)).toEqual(['abcd…', 'ij'])
  expect(wrapWords('', 5)).toEqual([])
})

test('usageLines: column heads first with a blank first column, a total row from two lanes up, none for one', () => {
  const t = (turns: number, costUsd: number | null) => ({ turns, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd })
  expect(usageLines([['main session', t(52, 0.45)]])).toEqual([
    '              turns  at API rates',
    'main session     52         $0.45',
  ])
  const two = usageLines([['main session', t(52, 0.45)], ['Gemini', t(3, null)]])
  expect(two.at(-1)).toBe('total            55         $0.45')
  expect(two).toHaveLength(4)
  // nothing priced: the total reads as an em dash
  expect(usageLines([['a', t(1, null)], ['b', t(1, null)]]).at(-1)).toMatch(/—$/)
  // every line is as long as the table, none ends in a space
  for (const l of two) expect(l).toBe(l.trimEnd())
})

test('colWidths measures every column over every row, the head row included', () => {
  expect(colWidths([['', 'turns', 'at API rates'], ['main session', '52', '$0.45']])).toEqual([12, 5, 12])
  expect(colWidths([])).toEqual([])
  expect(colWidths([['a'], ['bbb', 'cc']])).toEqual([3])
})

test('usageRows gives the cells behind usageLines: heads, one row per lane, a total from two lanes, aligned l r r', () => {
  const t = (turns: number, costUsd: number | null) => ({ turns, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd })
  const one = usageRows([['main session', t(52, 0.45)]])
  expect(one).toEqual({ rows: [['', 'turns', 'at API rates'], ['main session', '52', '$0.45']], align: ['l', 'r', 'r'] })
  const two = usageRows([['main session', t(52, 0.45)], ['Gemini', t(3, null)]])
  expect(two.rows).toHaveLength(4)
  expect(two.rows.at(-1)).toEqual(['total', '55', '$0.45'])
  expect(two.rows[2]).toEqual(['Gemini', '3', '—'])
  // the lines are these cells joined by two spaces, as table joins them
  expect(usageLines([['main session', t(52, 0.45)]])[1]).toBe('main session     52         $0.45')
})

test('recentRows and runningRows give the cells behind their lines', () => {
  const at = new Date(2026, 9, 14, 14, 52).getTime()
  const turn = { turnId: 'a', startedAt: at, endedAt: at + 221_000, lane: 'coder', model: 'Sonnet 5.5', effort: 'high', agents: 0 }
  expect(recentRows([turn], false)).toEqual({ rows: [['14:52', 'coder', 'Sonnet 5.5', 'high', '3m 41s']], align: ['l', 'l', 'l', 'l', 'r'] })
  expect(recentRows([turn], true)).toEqual({ rows: [['14:52', 'coder', 'Sonnet 5.5', '3m 41s']], align: ['l', 'l', 'l', 'r'] })
  const running = Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, lane: 'coder', model: 'Sonnet 5.5', startedAt: 1000 + i * 1000 }))
  const r = runningRows(running, 200000)
  expect(r.rows).toHaveLength(5)
  expect(r.more).toBe(2)
  expect(r.rows[0]).toEqual(['coder', 'Sonnet 5.5', '3m 19s'])
  expect(r.align).toEqual(['l', 'l', 'l'])
})

test('quotaWindows splits a window into label, bar and percent; quotaCells joins them', () => {
  expect(quotaWindows({ fiveHour: 19, sevenDay: 9 }, 10)).toEqual([{ label: '5h', bar: '▰▰▱▱▱▱▱▱▱▱', pct: '19%' }, { label: '7d', bar: '▰▱▱▱▱▱▱▱▱▱', pct: '9%' }])
  expect(quotaWindows({ sevenDay: 100 }, 5)).toEqual([{ label: '7d', bar: '▰▰▰▰▰', pct: '100%' }])
  expect(quotaWindows(null, 10)).toEqual([])
})

test('quotaCells: five-hour first, one space after the label, percent right-aligned, none without data', () => {
  expect(quotaCells({ fiveHour: 19, sevenDay: 9 }, 10)).toEqual(['5h ▰▰▱▱▱▱▱▱▱▱  19%', '7d ▰▱▱▱▱▱▱▱▱▱   9%'])
  expect(quotaCells({ sevenDay: 80 }, 10)).toEqual(['7d ▰▰▰▰▰▰▰▰▱▱  80%'])
  expect(quotaCells({ sevenDay: 80 }, 5)).toEqual(['7d ▰▰▰▰▱  80%'])
  expect(quotaCells(null, 10)).toEqual([])
  expect(quotaCells({}, 10)).toEqual([])
})

test('recentLines aligns time, lane, model, effort and duration; narrow drops the effort column', () => {
  const at = new Date(2026, 9, 14, 14, 52).getTime()
  const rows = [
    { turnId: 'a', startedAt: at, endedAt: at + 221_000, lane: 'coder', model: 'Sonnet 5.5', effort: 'high', agents: 0 },
    { turnId: 'b', startedAt: at - 300_000, endedAt: at - 294_000, lane: 'main session', model: 'Haiku 5.5', effort: 'low', agents: 0 },
  ]
  expect(clockOf(at)).toBe('14:52')
  expect(recentLines(rows, false)).toEqual([
    '14:52  coder         Sonnet 5.5  high  3m 41s',
    '14:47  main session  Haiku 5.5   low       6s',
  ])
  expect(recentLines(rows, true)).toEqual([
    '14:52  coder         Sonnet 5.5  3m 41s',
    '14:47  main session  Haiku 5.5       6s',
  ])
  // a turn without an effort leaves the column empty, not "undefined"
  expect(recentLines([{ ...rows[0]!, effort: undefined }], false)[0]).not.toContain('undefined')
})
