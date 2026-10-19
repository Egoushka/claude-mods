export type ForgeFile = { path: string; content: string }

export type ForgeProposal = {
  id: string
  name: string
  purpose: string
  dir: string
  files: ForgeFile[]
  status: 'pending' | 'approved' | 'rejected' | 'failed'
  result: string
}

export type ForgeSuggestion = { sequence: string[]; count: number }

declare module 'claude-code' {
  interface PluginState {
    forge: { proposal: ForgeProposal | null; suggestion: ForgeSuggestion | null }
  }
}
