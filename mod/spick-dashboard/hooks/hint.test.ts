import { test, expect } from 'claude-code/testing'
import { HINT_HEAD, HINT_TAIL, KEYWORDS, findHints, gateReason, hintLine, lineOf } from './hint'

// A copy of skills/spick/scripts/testdata/triage_hints.json: triage_hint.py's tests read the same cases, so the two
// implementations answer alike or one of the two suites fails. Change both together.
const FIXTURE: readonly { prompt: string; line: string | null }[] = [
  { prompt: 'spick刚刚提交了推送，请你将spick与https://github.com/paxon-yang/claude-agent-tools/blob/main/README.zh-CN.md进行对比，看看spick在技术上、界面上是否有差距',
    line: "   Hint (keywords in this prompt, not a verdict): judgement words (对比, 差距) -> start from Agent(deep, high); web signs (a web address) -> the search lane fetches, judging what it finds is still deep's. Keeping a hinted task yourself needs a one-line reason in the reply, on a line starting with `Kept:`." },
  { prompt: '我主要是指分流的技术上是否有差距，需要你去查看对方的代码',
    line: '   Hint (keywords in this prompt, not a verdict): judgement words (差距) -> start from Agent(deep, high). Keeping a hinted task yourself needs a one-line reason in the reply, on a line starting with `Kept:`.' },
  { prompt: '为什么我给你这两个指令，都被你分流到了haiku',
    line: '   Hint (keywords in this prompt, not a verdict): judgement words (为什么) -> start from Agent(deep, high). Keeping a hinted task yourself needs a one-line reason in the reply, on a line starting with `Kept:`.' },
  { prompt: '现在几点了?', line: null },
  { prompt: '给 <SANDBOX>/quota.sh 加一个 --help 参数,打印一段用法说明然后退出 0。改完跑一下确认。',
    line: '   Hint (keywords in this prompt, not a verdict): edit words (加一个) -> Agent(coder) once nothing is left to decide. Keeping a hinted task yourself needs a one-line reason in the reply, on a line starting with `Kept:`.' },
  { prompt: '我想做一个脚本:每天早上 8 点把 ~/Downloads 里超过 30 天没动过的文件挪到 ~/Archive,挪完给我发一封邮件列出挪了哪些。先别写代码,告诉我应该怎么设计。',
    line: '   Hint (keywords in this prompt, not a verdict): design words (怎么设计) -> Agent(planner) before any coder; edit words (做一个) -> Agent(coder) once nothing is left to decide. Keeping a hinted task yourself needs a one-line reason in the reply, on a line starting with `Kept:`.' },
  { prompt: 'Compare the two parsers and tell me which is better',
    line: '   Hint (keywords in this prompt, not a verdict): judgement words (compare, which is better) -> start from Agent(deep, high). Keeping a hinted task yourself needs a one-line reason in the reply, on a line starting with `Kept:`.' },
  { prompt: 'Please review this diff for security problems',
    line: '   Hint (keywords in this prompt, not a verdict): review words (review) -> the review lane for a diff, else Agent(deep). Keeping a hinted task yourself needs a one-line reason in the reply, on a line starting with `Kept:`.' },
  { prompt: 'Preview the page and tell me the title', line: null },
  { prompt: "What's the latest version of agy, is there a Windows build?",
    line: "   Hint (keywords in this prompt, not a verdict): web signs (latest) -> the search lane fetches, judging what it finds is still deep's. Keeping a hinted task yourself needs a one-line reason in the reply, on a line starting with `Kept:`." },
  { prompt: '帮我查一下 Google Antigravity CLI(agy)现在最新版本号是多少,有没有 Windows 版本。',
    line: "   Hint (keywords in this prompt, not a verdict): web signs (最新, 版本号, google) -> the search lane fetches, judging what it finds is still deep's. Keeping a hinted task yourself needs a one-line reason in the reply, on a line starting with `Kept:`." },
  { prompt: '把这条推文下面的评论情绪分析一下',
    line: '   Hint (keywords in this prompt, not a verdict): judgement words (分析) -> start from Agent(deep, high); X words (推文) -> the x-data lane. Keeping a hinted task yourself needs a one-line reason in the reply, on a line starting with `Kept:`.' },
  { prompt: 'vscode settings: where is the font size option?', line: null },
  { prompt: '对比一下这两个文件各有多少行',
    line: '   Hint (keywords in this prompt, not a verdict): judgement words (对比) -> start from Agent(deep, high). Keeping a hinted task yourself needs a one-line reason in the reply, on a line starting with `Kept:`.' },
  { prompt: '', line: null },
]

test('the fixture: the same lines triage_hint.py prints', () => {
  for (const c of FIXTURE) expect(hintLine(c.prompt)).toBe(c.line)
})

test('kinds fire in priority order, each at most once, with the words it matched', () => {
  expect(Object.keys(KEYWORDS)).toEqual(['judgement', 'review', 'design', 'code', 'web', 'x'])
  expect(findHints('先对比再修复，顺便搜一下最新的做法')).toEqual([
    { kind: 'judgement', words: ['对比'] },
    { kind: 'code', words: ['修复'] },
    { kind: 'web', words: ['最新', '搜一下'] },
  ])
})

test('ASCII entries match whole words, case-insensitively; other entries anywhere', () => {
  expect(findHints('COMPARE A vs B')).toEqual([{ kind: 'judgement', words: ['compare', 'vs'] }])
  // preview is not review, vscode is not vs, gaps/gap: no double count of a word inside a longer one
  expect(findHints('preview the vscode page')).toEqual([])
  expect(findHints('what is the gap here')).toEqual([{ kind: 'judgement', words: ['gap'] }])
  expect(findHints('mind the gaps')).toEqual([{ kind: 'judgement', words: ['gaps'] }])
  // a phrase matches across any whitespace
  expect(findHints('which   is\tbetter?')).toEqual([{ kind: 'judgement', words: ['which is better'] }])
  // a web address alone is a web sign
  expect(findHints('see https://example.com/x')).toEqual([{ kind: 'web', words: ['a web address'] }])
  // a word a longer match already covers is left out: 怎么设计 hides 设计
  expect(findHints('这个怎么设计')).toEqual([{ kind: 'design', words: ['怎么设计'] }])
})

test('the line shows at most three words per kind and keeps the fixed head and tail', () => {
  const line = hintLine('对比、比较、评估、评价这四种说法') ?? ''
  expect(line.startsWith(HINT_HEAD)).toBe(true)
  expect(line.endsWith(HINT_TAIL)).toBe(true)
  expect(line).toContain('judgement words (对比, 比较, 评估) -> start from Agent(deep, high)')
  expect(line).not.toContain('评价')
})

test('gateReason: a verdict or a design the main session kept; other kinds are not the gate\'s business', () => {
  const v = gateReason(findHints('把 A 和 B 对比一下，差距在哪'))
  expect(v?.kind).toBe('verdict')
  expect(v?.text).toContain('spick gate: this prompt was hinted as a verdict (对比, 差距) and nothing was delegated this turn')
  expect(v?.text).toContain('dispatch Agent(deep, high)')
  expect(v?.text).toContain('reply with one line starting with `Kept:`')
  expect(v?.text.endsWith('This gate fires once per turn.')).toBe(true)
  const d = gateReason(findHints('这个功能怎么设计'))
  expect(d?.kind).toBe('design')
  expect(d?.text).toContain('hinted as a design (怎么设计)')
  expect(d?.text).toContain('dispatch Agent(planner, high)')
  // review counts as a verdict; a design next to a verdict reads as a verdict, deep's
  expect(gateReason(findHints('review this diff'))?.kind).toBe('verdict')
  expect(gateReason(findHints('评估一下这个方案'))).toMatchObject({ kind: 'verdict' })
  for (const t of ['fix the bug', 'what is the latest version', '这条推文说了什么', '现在几点了', '']) expect(gateReason(findHints(t))).toBeNull()
  expect(lineOf([])).toBeNull()
  expect(lineOf(findHints('对比一下'))).toBe(hintLine('对比一下'))
})
