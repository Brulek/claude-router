import { test, expect } from 'claude-code/testing'
import { markerPath, safeName, spickPaths, turnsFile } from './paths'

test('the config dir is CLAUDE_CONFIG_DIR when set, else HOME/.claude; state lives in <config>/spick', () => {
  const p = spickPaths(undefined, '/h')!
  expect(p).toEqual({
    config: '/h/.claude', spickJson: '/h/.claude/spick.json', scripts: '/h/.claude/skills/spick/scripts', state: '/h/.claude/spick',
    quota: '/h/.claude/spick/quota.json', turns: '/h/.claude/spick/turns', modActive: '/h/.claude/spick/mod-active',
  })
  const c = spickPaths('/cfg/claude/', '/h')!
  expect(c.config).toBe('/cfg/claude')
  expect(c.quota).toBe('/cfg/claude/spick/quota.json')
  expect(c.spickJson).toBe('/cfg/claude/spick.json')
})

test('an empty CLAUDE_CONFIG_DIR counts as unset; neither variable gives null', () => {
  expect(spickPaths('', '/h')?.config).toBe('/h/.claude')
  expect(spickPaths(undefined, undefined)).toBeNull()
  expect(spickPaths('', '')).toBeNull()
})

test('the marker is one file per session under mod-active, its name unable to leave the directory', () => {
  const p = spickPaths(undefined, '/h')!
  expect(markerPath(p, 'abc-123')).toBe('/h/.claude/spick/mod-active/abc-123')
  expect(markerPath(p, '../../x')).toBe('/h/.claude/spick/mod-active/__.._x')
  expect(safeName('.hidden')).toBe('_hidden')
})

test('the turn record is one file per session under turns/', () => {
  expect(turnsFile(spickPaths(undefined, '/h')!, 's/1')).toBe('/h/.claude/spick/turns/s_1.jsonl')
  expect(turnsFile(spickPaths(undefined, '/h')!, 's1', 1)).toBe('/h/.claude/spick/turns/s1.2.jsonl')
})
