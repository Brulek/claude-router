// The gate by required role: a hinted verdict names the role that must deliver it (judgement -> deep, review -> the
// review lane or deep), and the gate sends a stop back once when that role did not complete in the turn. Pure;
// register.tsx tracks which delegates ran and how they ended, and decides when the gate applies (routing in force,
// the gate on, a substantive turn, no Kept: line). The Hint findings come from hint.ts.
import type { Hint, HintKind } from './hint'

/** how a delegate (an Agent call or an outside CLI call) stands */
export type DelegateStatus = 'completed' | 'running' | 'failed' | 'refused'

/**
 * What confirmed a completed Agent call: its subagent's turn.complete without failure, or, when the call returned before
 * any completion event, the call's own non-empty result (the engine does not guarantee a foreground subagent's events
 * reach the hooks before the call returns, so this is the honest fallback).
 */
export type ConfirmedBy = 'turn.complete' | 'tool.result'

/**
 * What the gate reads of a delegate: its lane (a subagent type or a CLI lane), whether it is a review call (a single
 * `codex exec` or review-lane command with a review prompt), how it stands, and for a CLI call how much it printed.
 */
export type RoleRun = { lane: string; isReview?: boolean; status: DelegateStatus; confirmedBy?: ConfirmedBy; outputChars?: number }

/** the least a review call must print to count as a review: an error line or a usage text is shorter */
export const MIN_REVIEW_CHARS = 200

/** a reply with one line starting with Kept: states why a hinted task stayed with the main session */
export const KEPT_RE = /(^|\n)\s*(Kept|自留)[:：]/

/** the Kept: line itself, for the turn record; null when there is none */
export function keptLine(answer: string): string | null {
  const m = (answer ?? '').match(/(?:^|\n)\s*((?:Kept|自留)[:：][^\n]*)/)
  return m ? m[1]!.trim() : null
}

/** the kinds the gate acts on; design words stay a Hint line and never send a turn back (round 1) */
const ROLE_OF: Partial<Record<HintKind, 'deep' | 'review'>> = { judgement: 'deep', review: 'review' }
const MAX_SHOWN = 3

/**
 * Whether a role completed: deep when a deep subagent finished without failure, or is still running in the background
 * (its relay comes in a later turn); review when a review call returned cleanly with at least MIN_REVIEW_CHARS of
 * output, or deep did. A refused, failed or timed-out call does not count.
 */
export function roleDone(role: 'deep' | 'review', runs: readonly RoleRun[]): boolean {
  const deep = runs.some(r => r.lane === 'deep' && (r.status === 'completed' || r.status === 'running'))
  if (role === 'deep') return deep
  return deep || runs.some(r => r.isReview === true && r.status === 'completed' && (r.outputChars ?? 0) >= MIN_REVIEW_CHARS)
}

/** `kinds` and `words` are what the gate fired on, `roles` what it asked for; `text` is what the model reads */
export type GateFiring = { kinds: HintKind[]; words: string[]; roles: ('deep' | 'review')[]; text: string }

/**
 * The gate's reason to send a stop back, or null when every role the hints require completed (or none is required).
 * The text names what was missing and the two ways out.
 */
export function gateFiring(hints: readonly Hint[], runs: readonly RoleRun[]): GateFiring | null {
  const missing = hints.filter(h => ROLE_OF[h.kind] !== undefined && !roleDone(ROLE_OF[h.kind]!, runs))
  if (missing.length === 0) return null
  const kinds = missing.map(h => h.kind)
  const roles = [...new Set(kinds.map(k => ROLE_OF[k]!))]
  const words = missing.flatMap(h => h.words.slice(0, MAX_SHOWN))
  const isReviewOnly = roles.length === 1 && roles[0] === 'review'
  const what = isReviewOnly ? 'a review' : 'a verdict'
  const lacking = isReviewOnly ? 'no review lane call returned cleanly and no deep run completed' : 'no deep run completed'
  const fix = isReviewOnly
    ? 'run the review lane on the diff, or dispatch Agent(deep), and relay its findings in place of yours'
    : 'dispatch Agent(deep) with the facts you gathered and relay its answer in place of yours'
  const text = `spick gate: this prompt was hinted as ${what} (${words.join(', ')}) and ${lacking} this turn, so the ${isReviewOnly ? 'review' : 'verdict'} came from the triage session itself. Do one of two things now: ${fix}; or, if the deliverable really was a plain lookup, reply with one line starting with \`Kept:\` that says why, and stop.`
  return { kinds, words, roles, text }
}

/** what became of a turn the gate sent back, judged at a later stop of it: the role completed, or a Kept: line; else null */
export function gateOutcome(answer: string, roleCompleted: boolean): 'kept' | 'delegated' | null {
  if (roleCompleted) return 'delegated'
  return KEPT_RE.test(answer) ? 'kept' : null
}

/** the one block a stop is sent back with: every reason at once (the gate's and the guard's), the once-per-turn rule last */
export function sendBackText(reasons: readonly string[]): string {
  return `${reasons.join('\n\n')}\n\nspick sends a turn back once: after this, nothing more this turn.`
}
