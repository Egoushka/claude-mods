export type Phase = {
  step: 'idle' | 'offer' | 'working' | 'ready' | 'failed'
  percent?: number
  file?: string
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'handoff-autopilot': { phase: Shaped<Phase> }
  }
}
