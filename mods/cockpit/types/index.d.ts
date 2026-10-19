export type Reading = {
  /** What the pane shows. */
  text: string
  /** The numeric value, when the reading is a number; history and the sparkline follow it. */
  num?: number
  history: number[]
  /** `$.clock.now()` of the last successful reading. */
  at: number
  /** The last failure, shown dimmed beside the old value. */
  error?: string
}

export type InboxItem = { at: number; from: string; text: string }

export type AwayInfo = { idleSeconds?: number; lastSentAt?: number; lastText?: string; note?: string }

declare module 'claude-code' {
  interface PluginState {
    cockpit: {
      readings: Record<string, Reading>
      inbox: InboxItem[]
      away: AwayInfo
      configError: string
    }
  }
}
