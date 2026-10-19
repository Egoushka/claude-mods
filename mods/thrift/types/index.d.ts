export type Tier = 'trivial' | 'normal' | 'hard'

export type Route = {
  tier: Tier | null
  /** The model the tier maps to; null while nothing is classified. */
  model: string | null
  /** True when the turn runs on `model`; false when it is only a suggestion. */
  isApplied: boolean
}

export type Coach = {
  tokens: number | null
  /** Counts each time the context passes the threshold from below. */
  crossing: number
  dismissedCrossing: number
}

export type Weather = {
  /** Context size at the end of each turn, oldest first. */
  points: number[]
  /** Tokens at which the engine compacts, or fills the window; null until read. */
  limit: number | null
  isCompaction: boolean
}

export type DietSection = { id: string; tokens: number; isPinned: boolean }

export type Diet = {
  cwd: string
  dropped: string[]
  sections: DietSection[]
}

declare module 'claude-code' {
  interface PluginState {
    thrift: { route: Route; coach: Coach; weather: Weather; diet: Diet }
  }
}
