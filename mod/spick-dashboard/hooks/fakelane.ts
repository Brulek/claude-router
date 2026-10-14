import type { TestBody } from 'claude-code/testing'
import type { LaneRow } from '../types'

/** the script path the mod runs when HOME is /h */
export const SCRIPT = '/h/.claude/skills/spick/scripts/set_lane.py'

export const LANES: LaneRow[] = [
  { id: 'gemini', name: 'Gemini', enabled: true, tags: ['search'], data: 'public', notes: null, kind: 'cli-subscription' },
  { id: 'grok', name: 'Grok', enabled: true, tags: ['x-data'], data: 'public', notes: null, kind: 'cli-subscription' },
  { id: 'codex', name: 'Codex', enabled: true, tags: ['code'], data: 'code', notes: null, kind: 'cli-subscription' },
  { id: 'openrouter', name: 'OpenRouter', enabled: true, tags: ['gateway'], data: 'text', notes: 'Pay per use', kind: 'api-key' },
]

const exit = (exitCode: number, stdout: string, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

/**
 * A stand-in for `python3 set_lane.py`: the tests run in a world with no process, so $.process.run is answered
 * from memory. It keeps the lanes in `rows`, applies --id/--field/--value the way the script's rules read (unknown
 * id, unknown field and secret-looking values refused with exit 2), and records every argv in `calls`.
 */
export function fakeSetLane(on: Parameters<TestBody>[1], start: readonly LaneRow[] = LANES) {
  const rows: LaneRow[] = start.map(r => ({ ...r, tags: [...r.tags] }))
  const calls: string[][] = []
  on('process.run', async (_$, e) => {
    calls.push([...e.argv])
    const [py, script, ...rest] = e.argv
    if (py !== 'python3' || script !== SCRIPT) return exit(127, '', `not the lanes script: ${script}`)
    if (rest.length === 1 && rest[0] === '--list') return exit(0, JSON.stringify(rows))
    const arg = (flag: string) => rest[rest.indexOf(flag) + 1] ?? ''
    const id = arg('--id'), field = arg('--field'), value = arg('--value')
    const row = rows.find(r => r.id === id)
    if (!row) return exit(2, '', `set_lane: unknown lane id ${id}; to add a new lane use add_lane.py\nsecond line that the mod must not show\n`)
    if (/^sk-/.test(value)) return exit(2, '', 'set_lane: the value looks like a secret; not written\n')
    if (field === 'enabled') {
      if (value !== 'yes' && value !== 'no') return exit(2, '', 'set_lane: enabled must be yes or no\n')
      row.enabled = value === 'yes'
    } else if (field === 'tags') row.tags = value === '-' ? [] : value.split(',').map(t => t.trim().toLowerCase())
    else if (field === 'notes') row.notes = value === '-' ? null : value
    else if (field === 'name') row.name = value
    else if (field === 'data') row.data = value === 'unset' ? null : value
    else if (field === 'model' || field === 'base_url') { /* a field the list does not carry */ }
    else return exit(2, '', `set_lane: unknown field ${field}; fields: name, tags, data\n`)
    return exit(0, `set ${id}.${field}; backup at spick.json.bak\n`)
  })
  return { rows, calls, writes: () => calls.filter(c => c.includes('--field')) }
}
