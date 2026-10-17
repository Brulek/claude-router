import { test, expect } from 'claude-code/testing'
import { KEPT_RE, MIN_REVIEW_CHARS, gateFiring, isReport, gateOutcome, keptLine, roleDone, sendBackText } from './gate'
import type { RoleRun } from './gate'

const J = { kind: 'judgement' as const, words: ['对比', '差距'] }
const R = { kind: 'review' as const, words: ['review'] }
const D = { kind: 'design' as const, words: ['design'] }

test('judgement needs deep: completed or still running counts; refused or failed does not; other lanes never', () => {
  const run = (lane: string, status: RoleRun['status'], isReview = false): RoleRun[] => [{ lane, status, isReview }]
  expect(roleDone('deep', run('deep', 'completed'))).toBe(true)
  expect(roleDone('deep', run('deep', 'running'))).toBe(true)
  expect(roleDone('deep', run('deep', 'refused'))).toBe(false)
  expect(roleDone('deep', run('deep', 'failed'))).toBe(false)
  expect(roleDone('deep', run('coder', 'completed'))).toBe(false)
  expect(roleDone('deep', run('Codex', 'completed', true))).toBe(false)
})

test('review needs a review call that returned cleanly with real output, or deep', () => {
  expect(MIN_REVIEW_CHARS).toBe(20)
  expect(roleDone('review', [{ lane: 'Codex', isReview: true, status: 'completed', isReport: true }])).toBe(true)
  // output that is no report, none measured, or a failed call is no review
  expect(roleDone('review', [{ lane: 'Codex', isReview: true, status: 'completed', isReport: false, outputChars: 500 }])).toBe(false)
  expect(roleDone('review', [{ lane: 'Codex', isReview: true, status: 'completed' }])).toBe(false)
  expect(roleDone('review', [{ lane: 'Codex', isReview: true, status: 'failed', isReport: true }])).toBe(false)
  expect(roleDone('review', [{ lane: 'Codex', status: 'completed' }])).toBe(false)
  expect(roleDone('review', [{ lane: 'deep', status: 'completed' }])).toBe(true)
})

test('isReport: a short clean review counts; empty, too short or a usage message does not', () => {
  for (const t of ['No issues found in this diff.', '\n\n  No issues found in this diff.\n', 'LGTM: no findings on this change.', 'x'.repeat(20)]) expect([t, isReport(t)]).toEqual([t, true])
  for (const t of ['', '  \n \n', 'No issues found.', 'x'.repeat(19), 'Usage: codex exec [OPTIONS] [PROMPT]', 'usage: agy [-p PROMPT] [--model M]\nmore text here',
    '\nerror: unknown flag; see codex exec --help for usage']) expect([t, isReport(t)]).toEqual([t, false])
})

test('gateFiring names the missing roles and words; design words never gate; nothing missing is null', () => {
  expect(gateFiring([D], [])).toBeNull()
  expect(gateFiring([], [])).toBeNull()
  const both = gateFiring([J, R, D], [])!
  expect(both.kinds).toEqual(['judgement', 'review'])
  expect(both.roles).toEqual(['deep', 'review'])
  expect(both.words).toEqual(['对比', '差距', 'review'])
  expect(both.text).toContain('hinted as a verdict (对比, 差距, review) and no deep run completed')
  // a review done by Codex leaves the judgement missing
  const j = gateFiring([J, R], [{ lane: 'Codex', isReview: true, status: 'completed', outputChars: 500, isReport: true }])!
  expect(j.kinds).toEqual(['judgement'])
  expect(gateFiring([J, R], [{ lane: 'deep', status: 'completed' }])).toBeNull()
  const r = gateFiring([R], [])!
  expect(r.text).toContain('hinted as a review (review) and no review lane call returned cleanly')
  expect(r.text).toContain('`Kept:`')
})

test('KEPT_RE and keptLine take a line starting with Kept: or 自留:, nothing mid-line', () => {
  expect(KEPT_RE.test('answer\nKept: a lookup')).toBe(true)
  expect(KEPT_RE.test('the word Kept: mid-line')).toBe(false)
  expect(keptLine('answer\n  Kept: the deliverable is a diff.\nmore')).toBe('Kept: the deliverable is a diff.')
  expect(keptLine('答案\n自留：纯查阅')).toBe('自留：纯查阅')
  expect(keptLine('no line')).toBeNull()
})

test('gateOutcome: the role completed is delegated, else a Kept: line is kept, else nothing yet', () => {
  expect(gateOutcome('x\nKept: y', true)).toBe('delegated')
  expect(gateOutcome('x\nKept: y', false)).toBe('kept')
  expect(gateOutcome('x', false)).toBeNull()
})

test('sendBackText joins every reason and ends with the once rule', () => {
  const t = sendBackText(['spick gate: a', 'spick guard: b'])
  expect(t).toBe('spick gate: a\n\nspick guard: b\n\nspick sends a turn back once: after this, nothing more this turn.')
})
