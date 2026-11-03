export type SessionState = 'busy' | 'waiting' | 'idle'
export type BoardRow = {
  id: string
  name: string
  state: SessionState
  since: number
  at: number
  context?: number
}

declare module 'claude-code' {
  interface PluginState {
    switchboard: { others: Shaped<BoardRow[]> }
  }
}
