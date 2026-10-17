export type NoteKind = 'warning' | 'error'
export type Note = { kind: NoteKind; text: string }

export type TurnRecord = {
  turnId: string
  startedAt: number
  endedAt?: number
  /** 'main session', a subagent type, or 'Gemini' | 'Grok' | 'Codex' */
  lane: string
  /** display name, e.g. 'Haiku 5.5' or 'gemini-3.8-flash'; '' when unknown */
  model: string
  effort?: string
  /** subagents spawned in this turn */
  agents: number
  /** while an agent shows on the band: its ordinal among this turn's agents (1-based) */
  agentIndex?: number
  /** while an agent shows on the band: how many of that lane run now; above 1 the band reads `coder ×12` */
  laneCount?: number
  /** start time of the oldest running agent of the lane the band shows; the band's elapsed time counts from it when laneCount > 1 */
  laneSince?: number
  /** while a Codex review call shows on the band: the verb reads `is reviewing` */
  isReview?: boolean
  /** while active: the latest tick (a turn.step chunk or tool.call, at most one write per second), so the band's elapsed time moves */
  nowMs?: number
  /** attention cause, shown in color on the band and in the pane's note column */
  note?: Note
  costUsd?: number | null
  /** the main loop's last prompt size in tokens (input, cache read and cache write of its latest step) */
  contextTokens?: number
}

/** a delegate (Agent or outside CLI call) the pane's Running section lists */
export type RunningAgent = {
  /** the tool_use_id of the call that started it */
  id: string
  lane: string
  model: string
  effort?: string
  startedAt: number
  /** set when no completion signal came for 30 minutes: the row reads "timed out" until the next prompt drops it */
  timedOutAt?: number
}

export type LaneTotals = {
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** null when the lane cannot be priced (outside CLIs, unknown models) */
  costUsd: number | null
}

/** routing: `on` follows the session model (routes in a Haiku session), `force` routes on any model, `off` never */
export type Routing = 'on' | 'force' | 'off'
/** review: `auto` follows the skill's review triggers, `off` skips Codex review */
export type Review = 'auto' | 'off'
/** a lane id: the built-ins 'gemini' | 'grok' | 'codex' or any id the user registered in lane_registry */
export type LaneKey = string
/** a declared lane as the quota cache carries it (notes, urls and key_ref are never in the cache) */
export type LaneInfo = { id: string; kind?: string; tags: string[]; data?: string | null }
/** a lane as `set_lane.py --list` prints it (no key_ref, no base_url) */
export type LaneRow = { id: string; name: string; enabled: boolean; tags: string[]; data: string | null; notes: string | null; kind: string | null }
/** the lanes page's last edit and last refusal, both one line */
export type LaneNote = { change: string; error: string }
/** gate: `on` sends a verdict the main session kept (no delegate, a hinted prompt) back once at stop time, `off` never */
export type Gate = 'on' | 'off'
/**
 * guard: `on` caps the main session's own source edits at a few distinct files per turn (the next one is refused,
 * to go to a coder) and sends a turn that edited source without running a check back once at stop time; `off` never
 */
export type Guard = 'on' | 'off'
export type Controls = {
  routing: Routing
  review: Review
  gate: Gate
  guard: Guard
  /** the user picked a model by hand this session: routing is off until /spick on or /spick force */
  manualModel: boolean
}

/** a provider's meters; `sampledAt` (ms) is when the source sampled them (Claude Code's fetch, the Codex log line) */
export type QuotaWindows = { fiveHour?: number; sevenDay?: number; sampledAt?: number }
/** `readAt` is when the mod last read the sources (it paces re-reads); the pane shows each sample's own age */
export type Quota = { claude: QuotaWindows | null; codex: QuotaWindows | null; readAt: number }

declare module 'claude-code' {
  interface PluginState {
    'spick-dashboard': {
      current: TurnRecord | null
      /** delegates running now (oldest first), then any that timed out */
      running: RunningAgent[]
      last: TurnRecord | null
      turns: TurnRecord[]
      totals: Record<string, LaneTotals>
      quota: Quota | null
      hidden: boolean
      /** the switches; routing, review, the gate and the guard are also kept in $.store (the lanes' on/off lives in spick.json) */
      controls: Controls
      /** the session model id from $.session.model(), '' until read */
      sessionModel: string
      /** the lanes as set_lane.py --list last printed them, null until a command or press read them */
      laneRows: LaneRow[] | null
      /** which page the pane shows */
      page: 'main' | 'lanes'
      /** the lanes page's last edit and refusal */
      laneNote: LaneNote
      /** counts the lanes page's edit field, so a submit clears it */
      editSeq: number
    }
  }
}
