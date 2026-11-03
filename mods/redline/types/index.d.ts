export type Red = {
  health?: string
  ci?: string[]
}

declare module 'claude-code' {
  interface PluginState {
    redline: { red: Shaped<Red>; hide: Shaped<string> }
  }
}
