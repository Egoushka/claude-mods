export type Pet = {
  name: string
  xp: number
  level: number
  // 0 is fed, 100 is starving; the value at `fedAt`, rising with time.
  hunger: number
  fedAt: number
  sickUntil: number
  happyUntil: number
  // The last time the pet was stroked, the cooldown for its xp.
  strokedAt: number
  said: string
  saidUntil: number
}

declare module 'claude-code' {
  interface PluginState {
    pet: { current: Pet | null }
  }
}
