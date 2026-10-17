// The turn record: one JSON line per main turn in <state>/turns/<sessionId>.jsonl, written at the main turn.complete,
// so every routing decision can be audited (scripts/audit.py) and costed (scripts/spend.py). One file per session:
// two sessions ending turns together never share a file, and $.fs.write writes a whole file only, so a write reads
// the session's file, appends and writes it back. A background agent that finishes after its main turn's line adds a
// `late: true` line with the same turnId; readers merge by turnId and the delegate's id. Pure; register.tsx gathers.
import type { ConfirmedBy, DelegateStatus } from './gate'

export const SCHEMA_VERSION = 2

/** token counts and their estimated price; costUsd null when the model has no price */
export type UsageEntry = { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number | null }
/** a turn.complete's usage as the engine reports it */
export type EngineUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

export type DelegateEntry = {
  /** the tool_use_id of the call: the key a late line updates */
  id: string
  /** a subagent type, or an outside CLI's lane (Gemini, Grok, Codex, a registry id) */
  lane: string
  /** a delegate started from inside a subagent: that subagent's id (the delegate counts for the main turn) */
  parent?: string
  model: string
  effort?: string
  isReview?: boolean
  status: DelegateStatus
  /** completed */
  ok: boolean
  /** an Agent call: what confirmed its completion (gate.ts ConfirmedBy) */
  confirmedBy?: ConfirmedBy
  /** an outside CLI call: the characters it printed */
  outputChars?: number
  /** an outside CLI call: whether its output reads as a report (gate.ts isReport); a review counts only then */
  isReport?: boolean
  startedAt: string
  /** wall time while it ran; null while it still runs */
  ms: number | null
  /** null for an outside CLI (it reports none) and for an agent still running */
  usage: UsageEntry | null
  costUsd: number | null
}

export type GateEvent = { at: string; kind: string; words: string[]; outcome: 'sent-back' | 'kept' | 'delegated' }

export type CheckEntry = {
  command: string
  startedAt: string
  finishedAt: string | null
  exitOk: boolean | null
  /** source edits in flight or started while it ran; null while it runs */
  editsDuring: number | null
  /**
   * it ran after the last completed source edit: none in flight or landing while it ran, none after. With exitOk it
   * covers the turn. The command is kept: the mod cannot see what the check exercised, so an edit outside its scope
   * still reads as checked.
   */
  afterLastEdit: boolean
  agentId?: string
}

export type TurnLine = {
  schemaVersion: 2
  at: string
  sessionId: string
  turnId: string
  cwd: string
  mainModel: string
  routing: 'on' | 'force' | 'off'
  /** the Hint line's kinds for the prompt that started the turn */
  hint: string[]
  /** the reply's `Kept:` line, null when there was none */
  kept: string | null
  /** the last gate event, as section 6 of the spec names it */
  gate: null | { kind: string; outcome: GateEvent['outcome'] }
  gateEvents: GateEvent[]
  delegates: DelegateEntry[]
  /** source files edited: distinct ones by the main session, by subagents, and all of them */
  edits: { main: number; agents: number; files: string[] }
  /** the last check of the turn, as section 6 names it; null when none ran */
  check: null | { ran: true; passed: boolean; afterLastEdit: boolean; command: string }
  checks: CheckEntry[]
  /** the escalation line the turn raised, and whether a coder or deep was dispatched after it */
  escalation: null | { command: string; followed: boolean }
  /** the main loop's own usage; null when the turn reported none (an interrupt, an API error) */
  usage: UsageEntry | null
  /** the subagents' usage that arrived before the turn ended, summed */
  agentUsage: UsageEntry
  context: { lastInput: number | null }
  ms: number
}

export type LateLine = { schemaVersion: 2; late: true; at: string; sessionId: string; turnId: string; delegate: DelegateEntry }

export const ZERO_USAGE: UsageEntry = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null }

/** an engine usage as a record entry */
export function usageEntry(u: EngineUsage, costUsd: number | null): UsageEntry {
  return { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, costUsd }
}

/** two entries summed; the cost stays null only while both are */
export function addUsage(a: UsageEntry, b: UsageEntry): UsageEntry {
  const costUsd = a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0)
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, costUsd }
}

/** a line's text: the record as one JSON line, keys in the order the type gives them */
export function lineText(line: TurnLine | LateLine): string {
  return `${JSON.stringify(line)}\n`
}

/** the file's text with lines added; a last line missing its newline gets one first */
export function appendLines(prev: string, lines: readonly string[]): string {
  const base = prev && !prev.endsWith('\n') ? `${prev}\n` : prev
  return base + lines.join('')
}

/** the record of a turn from what register.tsx gathered; the summaries (gate, check, escalation) are derived here */
export function turnLine(t: {
  at: number; sessionId: string; turnId: string; cwd: string; mainModel: string; routing: TurnLine['routing']
  hint: readonly string[]; kept: string | null; gateEvents: readonly GateEvent[]; delegates: readonly DelegateEntry[]
  mainFiles: readonly string[]; agentFiles: readonly string[]; files: readonly string[]
  checks: readonly CheckEntry[]; escalation: { command: string; at: number } | null
  usage: UsageEntry | null; lastInput: number | undefined; ms: number
}): TurnLine {
  const lastGate = t.gateEvents.at(-1)
  const lastCheck = t.checks.at(-1)
  // outside CLIs report no usage, so only subagents add here
  const agentUsage = t.delegates.reduce((sum, d) => (d.usage ? addUsage(sum, d.usage) : sum), ZERO_USAGE)
  const esc = t.escalation
  return {
    schemaVersion: SCHEMA_VERSION,
    at: new Date(t.at).toISOString(),
    sessionId: t.sessionId,
    turnId: t.turnId,
    cwd: t.cwd,
    mainModel: t.mainModel,
    routing: t.routing,
    hint: [...t.hint],
    kept: t.kept,
    gate: lastGate ? { kind: lastGate.kind, outcome: lastGate.outcome } : null,
    gateEvents: [...t.gateEvents],
    delegates: [...t.delegates],
    edits: { main: t.mainFiles.length, agents: t.agentFiles.length, files: [...t.files] },
    check: lastCheck ? { ran: true, passed: lastCheck.exitOk === true, afterLastEdit: lastCheck.afterLastEdit, command: lastCheck.command } : null,
    checks: [...t.checks],
    escalation: esc ? { command: esc.command, followed: t.delegates.some(d => (d.lane === 'coder' || d.lane === 'deep') && Date.parse(d.startedAt) >= esc.at) } : null,
    usage: t.usage,
    agentUsage,
    context: { lastInput: t.lastInput ?? null },
    ms: t.ms,
  }
}

export function lateLine(t: { at: number; sessionId: string; turnId: string; delegate: DelegateEntry }): LateLine {
  return { schemaVersion: SCHEMA_VERSION, late: true, at: new Date(t.at).toISOString(), sessionId: t.sessionId, turnId: t.turnId, delegate: t.delegate }
}
