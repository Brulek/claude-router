// The spend record: one file per session under ~/.claude/spick-spend/, rewritten whole at every row
// ($.fs.write writes a whole file only). scripts/spend.py reads the directory and sums it.

/** where the records live, under HOME */
export const SPEND_DIR = '.claude/spick-spend'

/** one row: a turn.complete that carried usage (main session or subagent), or an outside CLI call (no usage, unpriced) */
export type SpendRow = {
  at: string
  turnId: string
  agentId?: string
  lane: string
  model: string
  effort?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** null when the row cannot be priced: an outside CLI call, or a model with no price */
  costUsd: number | null
}

export type SpendFile = { sessionId: string; cwd: string; startedAt: string; rows: SpendRow[] }

/** the token counts a turn.complete's usage carries */
export type SpendUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

/**
 * A row from what the hook saw: `usage` null for an outside CLI call (tokens 0, `costUsd` null whatever is passed);
 * `agentId` and `effort` are left out when absent.
 */
export function spendRow(r: { at: number; turnId: string; agentId?: string; lane: string; model: string; effort?: string; usage: SpendUsage | null; costUsd: number | null }): SpendRow {
  const u = r.usage
  return {
    at: new Date(r.at).toISOString(),
    turnId: r.turnId,
    ...(r.agentId ? { agentId: r.agentId } : {}),
    lane: r.lane,
    model: r.model,
    ...(r.effort ? { effort: r.effort } : {}),
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
    costUsd: u ? r.costUsd : null,
  }
}

/** the file's text: the header fields, then one row per line, so a diff or a grep reads it */
export function spendFileText(f: SpendFile): string {
  const head = `{"sessionId":${JSON.stringify(f.sessionId)},"cwd":${JSON.stringify(f.cwd)},"startedAt":${JSON.stringify(f.startedAt)},"rows":[`
  if (f.rows.length === 0) return `${head}]}\n`
  return `${head}\n${f.rows.map(r => JSON.stringify(r)).join(',\n')}\n]}\n`
}

/** the session id as a file name: anything but letters, digits, dot, dash and underscore becomes _, so it cannot leave the directory */
export function spendPath(home: string, sessionId: string): string {
  // the mod can only see HOME: a CLAUDE_CONFIG_DIR user's spend dir lives under ~/.claude too (spend.py reads it there)
  const name = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')
  return `${home}/${SPEND_DIR}/${name}.json`
}

const isRow = (r: unknown): r is SpendRow =>
  !!r && typeof r === 'object' && typeof (r as SpendRow).at === 'string' && typeof (r as SpendRow).lane === 'string' && typeof (r as SpendRow).inputTokens === 'number'

/**
 * The file a resumed session left, so its rows are kept when the file is written again; null when the text is not a
 * record of this session. Rows that do not read as rows are dropped.
 */
export function parseSpendFile(text: string, sessionId: string): SpendFile | null {
  try {
    const d = JSON.parse(text) as Partial<SpendFile>
    if (!d || typeof d !== 'object' || d.sessionId !== sessionId || !Array.isArray(d.rows)) return null
    return { sessionId, cwd: typeof d.cwd === 'string' ? d.cwd : '', startedAt: typeof d.startedAt === 'string' ? d.startedAt : '', rows: d.rows.filter(isRow) }
  } catch {
    return null
  }
}
