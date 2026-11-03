const NEVER = new Set(['ToolSearch'])

export const parseList = (text: string): string[] =>
  text.split(',').map(s => s.trim()).filter(Boolean)

export const matches = (tool: string, patterns: readonly string[]): boolean =>
  !NEVER.has(tool) &&
  patterns.some(p => (p.endsWith('*') ? tool.startsWith(p.slice(0, -1)) : tool === p))
