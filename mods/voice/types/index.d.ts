export type VoiceStats = {
  /** Edits made (rewrite mode) or edits that would have been made (flag mode). */
  edits: number
  /** Answers the auditor has examined. */
  audited: number
  isAuditing: boolean
}

export type VoiceAudit = {
  /** Claims the auditor found without evidence; empty hides the band. */
  claims: string[]
}

declare module 'claude-code' {
  interface PluginState {
    voice: { stats: VoiceStats; audit: VoiceAudit }
  }
}
