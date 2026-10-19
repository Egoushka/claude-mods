export type Change = {
  id: number
  // The prompt-turn the edit happened in, counted from 1 since the session started.
  turn: number
  tool: string
  file: string
  added: number
  removed: number
  // Unified-diff hunks (no ---/+++ header), as the Code element draws them; empty when `note` says why.
  diff: string
  // Hunks left out to keep the change small.
  omitted: number
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    replay: { changes: Change[]; turn: number; viewTurn: number | null }
  }
}
