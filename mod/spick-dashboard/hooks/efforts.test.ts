import { test, expect } from 'claude-code/testing'
import { DEFAULT_EFFORTS, effortToFill, effortsFrom } from './efforts'

test('the rules\' defaults: coder medium, planner high, deep medium', () => {
  expect(DEFAULT_EFFORTS).toEqual({ coder: 'medium', planner: 'high', deep: 'medium' })
  for (const t of [null, '', 'not json', '{}', '{"efforts":3}']) expect(effortsFrom(t)).toEqual(DEFAULT_EFFORTS)
})

test('spick.json efforts: a level or { default }, an unknown level ignored', () => {
  const cfg = JSON.stringify({ efforts: { coder: 'high', planner: { default: 'xhigh', high: 'when ...' }, deep: 'extreme' } })
  expect(effortsFrom(cfg)).toEqual({ coder: 'high', planner: 'xhigh', deep: 'medium' })
})

test('effortToFill fills the three roles only, and only when the call names no effort', () => {
  expect(effortToFill('coder', undefined, DEFAULT_EFFORTS)).toBe('medium')
  expect(effortToFill('planner', '', DEFAULT_EFFORTS)).toBe('high')
  expect(effortToFill('deep', 'max', DEFAULT_EFFORTS)).toBeNull()
  expect(effortToFill('Explore', undefined, DEFAULT_EFFORTS)).toBeNull()
  expect(effortToFill(undefined, undefined, DEFAULT_EFFORTS)).toBeNull()
})
