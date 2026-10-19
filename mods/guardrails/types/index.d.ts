export type GuardStats = {
  isInside: boolean
  masked: number
  corrected: number
  denied: number
  added: number
  removed: number
  budget: number | null
}

declare module 'claude-code' {
  interface PluginState {
    guardrails: { stats: GuardStats }
  }
}
