// Active seconds per repo root and local day, e.g. { '/home/me/app': { '2026-10-19': 5_400_000 } } (milliseconds).
export type Hours = Record<string, Record<string, number>>

declare module 'claude-code' {
  interface PluginState {
    ledger: { hours: Hours }
  }
}
