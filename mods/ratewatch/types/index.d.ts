export type Spender = { id: string; name: string; usd: number; at: number }

declare module 'claude-code' {
  interface PluginState {
    // Windows already warned about, as `kind@resetsAt`.
    ratewatch: { warned: Shaped<string[]> }
  }
}
