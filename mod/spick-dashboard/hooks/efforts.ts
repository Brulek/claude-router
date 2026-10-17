// The effort a coder, planner or deep call runs at when the Agent call names none: the user's defaults from spick.json
// (`efforts`, written by setup from the rules file), else the rules' own defaults. Filled on the call itself, so the
// default holds whether or not the main session remembered the table. Pure; register.tsx reads spick.json.

export type Efforts = Record<'coder' | 'planner' | 'deep', string>

/** the rules' defaults (skills/spick/assets/rules.json `efforts.*.default`) */
export const DEFAULT_EFFORTS: Efforts = { coder: 'medium', planner: 'high', deep: 'medium' }
const LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/**
 * The defaults from spick.json's text: `efforts.<role>` as a level, or as `{ "default": level }` the way rules.json
 * writes it. Anything missing, unknown or unreadable keeps the rules' default for that role.
 */
export function effortsFrom(spickJson: string | null | undefined): Efforts {
  const out: Efforts = { ...DEFAULT_EFFORTS }
  let cfg: unknown
  try { cfg = JSON.parse(spickJson ?? '') } catch { return out }
  const e = cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>).efforts : undefined
  if (!e || typeof e !== 'object') return out
  for (const role of Object.keys(out) as (keyof Efforts)[]) {
    const v = (e as Record<string, unknown>)[role]
    const level = typeof v === 'string' ? v : v && typeof v === 'object' ? (v as Record<string, unknown>).default : undefined
    if (typeof level === 'string' && LEVELS.has(level)) out[role] = level
  }
  return out
}

/** the effort to fill for an Agent call, or null when it names one or is not one of the three roles */
export function effortToFill(subagentType: string | undefined, effort: unknown, efforts: Efforts): string | null {
  if (effort !== undefined && effort !== null && effort !== '') return null
  return subagentType === 'coder' || subagentType === 'planner' || subagentType === 'deep' ? efforts[subagentType] : null
}
