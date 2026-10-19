// Pure helpers: no engine, so the tests import them directly.

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** Parses an argument template and replaces `{{key}}` in every string. Undefined when it is not a JSON object. */
export function fillTemplate(template: string, key: string, value: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(template)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const token = `{{${key}}}`
  const walk = (node: Json): Json => {
    if (typeof node === 'string') return node.split(token).join(value)
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]))
    return node
  }
  return walk(parsed as Json) as Record<string, unknown>
}

type McpLike = { content?: readonly { type: string; text?: string }[]; structuredContent?: unknown }

const LIST_KEYS = ['results', 'memories', 'items', 'facts', 'data', 'matches']
const TEXT_KEYS = ['text', 'content', 'memory', 'summary', 'fact', 'snippet', 'body']

function listIn(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') {
    for (const key of LIST_KEYS) {
      const inner = (value as Record<string, unknown>)[key]
      if (Array.isArray(inner)) return inner
    }
  }
  return undefined
}

function itemText(item: unknown): string {
  if (typeof item === 'string') return item
  if (item && typeof item === 'object') {
    for (const key of TEXT_KEYS) {
      const v = (item as Record<string, unknown>)[key]
      if (typeof v === 'string' && v.trim()) return v
    }
  }
  return JSON.stringify(item)
}

/** Memories out of an MCP result: a JSON list when the server sends one, else paragraphs and bullets. Capped at `maxChars` in all. */
export function extractMemories(result: McpLike, maxChars: number): string[] {
  const text = (result.content ?? [])
    .map(block => (block.type === 'text' ? (block.text ?? '') : ''))
    .join('\n')
    .trim()
  let raw: string[] = []
  const structured = listIn(result.structuredContent)
  if (structured) raw = structured.map(itemText)
  else {
    try {
      const list = listIn(JSON.parse(text))
      if (list) raw = list.map(itemText)
    } catch {
      // plain text
    }
    if (raw.length === 0 && text)
      raw = text.split(/\n\s*\n|\n(?=\s*(?:[-*•]|\d+[.)])\s)/).map(part => part.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''))
  }
  const items: string[] = []
  let used = 0
  for (const part of raw.map(p => p.trim()).filter(Boolean)) {
    const room = maxChars - used
    if (room <= 0) break
    items.push(part.length > room ? `${part.slice(0, Math.max(1, room - 1))}…` : part)
    used += part.length
  }
  return items
}

export function memoryContext(items: readonly string[]): string {
  return `Memories recalled for this prompt (may be stale; verify before relying on them):\n${items.map(i => `- ${i.replace(/\n+/g, ' ')}`).join('\n')}`
}

export const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2)
    .join(' ')

/** Jaccard overlap of the words of two summaries. */
export function similarity(a: string, b: string): number {
  const x = new Set(normalize(a).split(' ').filter(Boolean))
  const y = new Set(normalize(b).split(' ').filter(Boolean))
  if (x.size === 0 || y.size === 0) return 0
  let both = 0
  for (const word of x) if (y.has(word)) both += 1
  return both / (x.size + y.size - both)
}

export type Group = { id: string; summary: string; count: number; at: number; status: 'open' | 'dismissed' | 'drafted' }

export function nextCandidate(groups: readonly Group[]): Group | undefined {
  return groups.find(g => g.status === 'open' && g.count >= 2)
}

const TEST_DIR = /(^|\/)(tests?|__tests__|specs?)\//i
const TEST_NAME = /([._-](test|spec)s?\.[a-z0-9]+$)|(^test_)|((Tests?|Specs?)\.[a-z0-9]+$)/

/** Files whose name holds the mentioned file's stem and looks like a test. */
export function likelyTests(files: readonly string[], rel: string, cap = 5): string[] {
  const base = rel.split('/').pop() ?? rel
  const stem = base.replace(/\.[^.]+$/, '').toLowerCase()
  if (stem.length < 2) return []
  return files
    .filter(file => {
      if (file === rel) return false
      const name = file.split('/').pop() ?? file
      return name.toLowerCase().includes(stem) && (TEST_DIR.test(file) || TEST_NAME.test(name))
    })
    .slice(0, cap)
}

export const stemOf = (path: string) => (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '')

export function mentionContext(label: string, commits: readonly string[], tests: readonly string[], refs: readonly string[], stem: string): string | undefined {
  const parts: string[] = []
  if (commits.length) parts.push(`Last ${commits.length} commits touching it:\n${commits.map(c => `- ${c}`).join('\n')}`)
  if (tests.length) parts.push(`Likely test files (by name):\n${tests.map(t => `- ${t}`).join('\n')}`)
  if (refs.length) parts.push(`Files that mention "${stem}" (git grep):\n${refs.map(r => `- ${r}`).join('\n')}`)
  return parts.length ? `Context for @${label}, added by the recall plugin:\n${parts.join('\n\n')}` : undefined
}

export const brief = (text: string, max = 120) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

// Friction lines are stored and may be written to a file, so anything secret-shaped is masked first.
export function maskSecrets(text: string): string {
  return text
    .replace(/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY)[A-Z0-9_]*)\s*[=:]\s*\S+/gi, '$1=[masked]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|xox[abprs]-[\w-]{10,}|AKIA[A-Z0-9]{16}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})/g, '[masked]')
    .replace(/(-H\s+['"]?Authorization:\s*\w+\s+)\S+/gi, '$1[masked]')
}

/** One short line saying what a tool call was about. */
export function describeCall(tool: string, input: Record<string, unknown>): string {
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'query']) {
    const v = input[key]
    if (typeof v === 'string' && v) return `${tool} ${brief(maskSecrets(v), 80)}`
  }
  return tool
}

export function frictionLine(at: number, kind: string, evidence: string): string {
  return `- ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} **${kind}**: ${evidence}`
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

export function quoted(text: string): string {
  return clip(text.trim(), 4000).replace(/^/gm, '> ')
}

export const VERB_PROMPTS = {
  verify:
    'Verify the claim quoted below. Check it against the code, files or commands that can settle it, then answer CONFIRMED, PARTIALLY CONFIRMED, REJECTED or UNKNOWN, each with the evidence.',
  why: 'Explain why the quoted text below is the way it is: what in this conversation or the code led to it, what the alternatives were, and what would change it.',
} as const

export function verbPrompt(kind: keyof typeof VERB_PROMPTS, selected: string, args: string): string {
  const extra = args.trim() ? `\n\n${args.trim()}` : ''
  return `${VERB_PROMPTS[kind]}\n\n${quoted(selected)}${extra}\n`
}

export function draftRulePrompt(summary: string, file: string): string {
  return (
    `I have corrected you on the same thing more than once: "${summary}".\n\n` +
    `Propose a rule that prevents it as an edit to ${file}: say where it goes and show the exact lines. ` +
    'Keep it to one or two lines in the style of that file. Do not apply it until I confirm.'
  )
}
