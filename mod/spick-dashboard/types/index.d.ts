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
  /** while a Codex review call shows on the band: the verb reads `is reviewing` */
  isReview?: boolean
  /** while active: the latest tick (a turn.step chunk or tool.call, at most one write per second), so the band's elapsed time moves */
  nowMs?: number
  /** attention cause, shown in color on the band and in the pane's note column */
  note?: Note
  costUsd?: number | null
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

/** routing: `auto` follows the session model (on for Haiku), `on` / `off` force it */
export type Routing = 'auto' | 'on' | 'off'
/** review: `auto` follows the skill's review triggers, `off` skips Codex review */
export type Review = 'auto' | 'off'
/** a lane id: the built-ins 'gemini' | 'grok' | 'codex' or any id the user registered in lane_registry */
export type LaneKey = string
/** a declared lane as the quota cache carries it (notes, urls and key_ref are never in the cache) */
export type LaneInfo = { id: string; kind?: string; tags: string[]; data?: string | null }
export type Controls = {
  routing: Routing
  review: Review
  /** true = the outside lane may be used */
  lanes: Record<LaneKey, boolean>
  /** the user picked a model by hand this session: routing is off until /spick on or /spick auto */
  manualModel: boolean
}

export type QuotaWindows = { fiveHour?: number; sevenDay?: number }
export type Quota = { claude: QuotaWindows | null; codex: QuotaWindows | null; readAt: number }

declare module 'claude-code' {
  interface PluginState {
    'spick-dashboard': {
      current: TurnRecord | null
      last: TurnRecord | null
      turns: TurnRecord[]
      totals: Record<string, LaneTotals>
      quota: Quota | null
      hidden: boolean
      /** the switches; routing, review and lanes are also kept in $.store */
      controls: Controls
      /** the session model id from $.session.model(), '' until read */
      sessionModel: string
    }
  }
}
