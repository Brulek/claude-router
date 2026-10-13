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
    }
  }
}
