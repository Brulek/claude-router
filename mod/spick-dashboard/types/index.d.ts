export type NoteKind = 'warning' | 'error'
export type Note = { kind: NoteKind; text: string }

export type TurnRecord = {
  turnId: string
  startedAt: number
  endedAt?: number
  /** 'you' for the main session, a subagent type, or 'Gemini' | 'Grok' | 'Codex' */
  lane: string
  /** display name, e.g. 'Haiku 5.5' or 'gemini-3.8-flash'; '' when unknown */
  model: string
  effort?: string
  /** subagents spawned in this turn */
  agents: number
  /** attention cause, shown in color on the band and in the pane's note column */
  note?: Note
  costUsd?: number | null
}

export type LaneTotals = {
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
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
