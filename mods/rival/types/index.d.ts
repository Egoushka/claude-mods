export type RivalFinding = {
  file: string
  line: number
  title: string
  scenario: string
  confidence: number
}

export type RivalReview = {
  status: 'idle' | 'running' | 'done' | 'error'
  findings: RivalFinding[]
  lines: number
  message: string
  isDismissed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    rival: { review: RivalReview }
  }
}
