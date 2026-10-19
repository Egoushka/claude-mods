const MIN = 2
const MAX = 8
const TIMES = 3
export const HISTORY_CAP = 400

// A call joins the history only when it is shell or MCP work: the loop of reading, editing and testing is normal work, not something to automate.
export function normalizeCall(tool: string, input: { command?: unknown }): string | undefined {
  if (tool === 'mcp__forge__forge') return undefined
  if (tool.startsWith('mcp__')) return tool
  if (tool !== 'Bash' || typeof input.command !== 'string') return undefined
  const first = (input.command.split('\n')[0] ?? '').replace(/^\s*cd\s+\S+\s*&&\s*/, '')
  const key = first
    .replace(/"[^"]*"|'[^']*'/g, '"…"')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
    .replace(/(?:~|[\w.@+-]*)(?:\/[\w.@+-]+)+/g, '<path>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
  return key === '' ? undefined : key.slice(0, 80)
}

const contains = (haystack: readonly string[], needle: readonly string[]) => {
  for (let i = 0; i + needle.length <= haystack.length; i += 1) if (needle.every((x, j) => haystack[i + j] === x)) return true
  return false
}

function occurrences(history: readonly string[], gram: readonly string[]): number {
  let count = 0
  for (let i = 0; i + gram.length <= history.length; ) {
    if (gram.every((x, j) => history[i + j] === x)) {
      count += 1
      i += gram.length
    } else i += 1
  }
  return count
}

// A run like a→b→a→b is the unit a→b repeated; the unit is what gets suggested.
const isPeriodic = (gram: readonly string[]) => {
  for (let p = 1; p < gram.length; p += 1) if (gram.every((x, i) => x === gram[i % p])) return true
  return false
}

// The longest sequence of 2-8 calls (two or more different ones) that ran 3 times without overlapping, unless an
// earlier suggestion already covers it. `seen` holds what was suggested.
export function findRepeat(history: readonly string[], seen: readonly (readonly string[])[]): string[] | undefined {
  for (let len = Math.min(MAX, Math.floor(history.length / TIMES)); len >= MIN; len -= 1) {
    const tried = new Set<string>()
    for (let i = 0; i + len <= history.length; i += 1) {
      const gram = history.slice(i, i + len)
      const key = gram.join('\u0001')
      if (tried.has(key)) continue
      tried.add(key)
      if (new Set(gram).size < 2 || isPeriodic(gram)) continue
      if (seen.some(s => contains(s, gram))) continue
      if (occurrences(history, gram) >= TIMES) return gram
    }
  }
  return undefined
}

// mcp__server__tool reads as its tool name; long shell lines are cut.
export const describeSequence = (sequence: readonly string[]) =>
  sequence.map(s => (s.startsWith('mcp__') ? (s.split('__').slice(2).join('__') || s) : s.length > 32 ? `${s.slice(0, 31)}…` : s)).join(' → ')

export function suggestionPrompt(sequence: readonly string[]): string {
  return (
    `The same sequence of ${sequence.length} tool calls has now run ${TIMES} times in this session:\n\n` +
    sequence.map((s, i) => `${i + 1}. ${s}`).join('\n') +
    '\n\nIf this is worth automating, call the `forge` tool once to propose a Claude Code mod for it ' +
    '(a plugin whose hooks module is one TypeScript file; give name, purpose and every file). ' +
    'Write nothing yourself: the person approves the proposal in a dialog first. ' +
    'If it is not worth automating, say why in one line and do not call forge.'
  )
}
