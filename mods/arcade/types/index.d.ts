// What a tool call drops into the game: c a coin, g a gold coin, h a hazard.
export type SpawnKind = 'c' | 'g' | 'h'
export type Spawn = { id: number; k: SpawnKind }

declare module 'claude-code' {
  interface PluginState {
    arcade: {
      // Spawns of the running turn, newest last; `id` counts up for the whole session.
      spawns: Spawn[]
      // The turn the game belongs to; a new turn starts a new round.
      round: number
      isOpen: boolean
      best: number
      // The score the running round has reached.
      score: number
    }
  }
}
