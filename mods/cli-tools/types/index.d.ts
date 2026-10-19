export type ToolParam = {
  type: 'string' | 'number' | 'integer' | 'boolean'
  description: string
  required: boolean
  enum?: string[]
  /** Lets a string value start with "-" when it fills a whole argument. Off by default. */
  allowDash: boolean
}

export type CliTool = {
  name: string
  description: string
  argv: string[]
  params: Record<string, ToolParam>
  timeoutMs: number
}

declare module 'claude-code' {
  interface PluginState {
    'cli-tools': { tools: string[] }
  }
}
