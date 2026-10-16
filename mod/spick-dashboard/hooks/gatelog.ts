// The gate's log: one JSON line each time the gate sends a turn back, and one for what became of it, in
// ~/.claude/spick-gate.jsonl, so its false positives can be counted. $.fs.write writes a whole file only, so a write
// reads the file, appends one line and writes it back (as the spend record does). The pure parts live here.

/** where the log lives, under HOME */
export const GATE_LOG = '.claude/spick-gate.jsonl'

/** a reply whose one line starting with Kept: states why a hinted task stayed with the main session */
export const KEPT_RE = /(^|\n)\s*(Kept|自留)[:：]/

/** sent-back when the gate fires; kept or delegated at a later stop of that turn */
export type GateOutcome = 'sent-back' | 'kept' | 'delegated'
/** `kind` is the hinted kinds the gate fired on, joined by `+` (judgement, review) */
export type GateLogEntry = { at: string; sessionId: string; kind: string; words: string[]; outcome: GateOutcome }

export const gateLogPath = (home: string): string => `${home}/${GATE_LOG}`

/** one entry as one line, its keys in a fixed order */
export function gateLogLine(e: GateLogEntry): string {
  return JSON.stringify({ at: e.at, sessionId: e.sessionId, kind: e.kind, words: e.words, outcome: e.outcome })
}

/** the file's text with one more line; a last line missing its newline gets one first */
export function appendGateLog(prev: string, e: GateLogEntry): string {
  const base = prev && !prev.endsWith('\n') ? `${prev}\n` : prev
  return `${base}${gateLogLine(e)}\n`
}

const OUTCOMES: readonly string[] = ['sent-back', 'kept', 'delegated']
const isEntry = (v: unknown): v is GateLogEntry => {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.at === 'string' && typeof o.sessionId === 'string' && typeof o.kind === 'string' &&
    Array.isArray(o.words) && o.words.every(w => typeof w === 'string') && typeof o.outcome === 'string' && OUTCOMES.includes(o.outcome)
}

/** the entries of a log's text; a line that is not an entry (torn by a crash, hand-edited) is skipped */
export function parseGateLog(text: string): GateLogEntry[] {
  const out: GateLogEntry[] = []
  for (const line of (text ?? '').split('\n')) {
    if (!line.trim()) continue
    try {
      const v: unknown = JSON.parse(line)
      if (isEntry(v)) out.push(v)
    } catch {}
  }
  return out
}

/** what became of a turn the gate sent back, judged at a later stop of it: a delegate ran, or a Kept: line; else null */
export function gateOutcome(answer: string, delegated: boolean): 'kept' | 'delegated' | null {
  if (delegated) return 'delegated'
  return KEPT_RE.test(answer) ? 'kept' : null
}
