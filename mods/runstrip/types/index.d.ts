export type Run = {
  id: string
  server: string
  // When this session first saw the run, in ms.
  since: number
  // Batch cost so far; absent where the credential is not priced.
  usd?: number
  stage?: string
}

declare module 'claude-code' {
  interface PluginState {
    runstrip: { runs: Shaped<Run[]> }
  }
}
