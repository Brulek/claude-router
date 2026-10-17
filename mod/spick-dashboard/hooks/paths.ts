// Where spick keeps its files. The skill's scripts/paths.py is the Python twin: both honour CLAUDE_CONFIG_DIR and fall
// back to HOME/.claude, so the mod and the hook agree on one state directory. Pure: register.tsx reads the two
// variables through $.env.get (names spelled as literals there, the validator lists them) and passes them in.

export type SpickPaths = {
  /** the Claude config dir: CLAUDE_CONFIG_DIR, else HOME/.claude */
  config: string
  /** spick.json stays beside settings.json */
  spickJson: string
  /** the skill's scripts (set_lane.py, spend.py, audit.py) */
  scripts: string
  /** <config>/spick/: everything spick writes as it runs */
  state: string
  quota: string
  turns: string
  modActive: string
}

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p)

/** the paths from the two variables; null when neither is set (nowhere safe to read or write) */
export function spickPaths(configDir: string | undefined, home: string | undefined): SpickPaths | null {
  // an empty CLAUDE_CONFIG_DIR is unset, as Claude Code itself reads it
  const config = configDir ? trimSlash(configDir) : home ? `${trimSlash(home)}/.claude` : ''
  if (!config) return null
  const state = `${config}/spick`
  return {
    config,
    spickJson: `${config}/spick.json`,
    scripts: `${config}/skills/spick/scripts`,
    state,
    quota: `${state}/quota.json`,
    turns: `${state}/turns.jsonl`,
    modActive: `${state}/mod-active`,
  }
}

/** a session id as a file name: anything but letters, digits, dot, dash and underscore becomes _, so it cannot leave the directory */
export function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')
}

/** the per-session marker the hook looks for: it stays silent while this file is younger than 24 hours */
export function markerPath(p: SpickPaths, sessionId: string): string {
  return `${p.modActive}/${safeName(sessionId)}`
}
