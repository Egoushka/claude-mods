export type Recalled = { query: string; items: string[]; at: number }
export type Candidate = { id: string; summary: string }
export type FrictionKind = 'denied' | 'errors' | 'correction' | 'interrupt'
export type FrictionEntry = { at: number; kind: FrictionKind; evidence: string }

declare module 'claude-code' {
  interface PluginState {
    recall: {
      memories: Recalled | null
      candidate: Candidate | null
      friction: FrictionEntry[]
    }
  }
}
