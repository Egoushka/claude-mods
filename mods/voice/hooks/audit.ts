// Pure helpers of the evidence auditor.

const SIGNAL =
  /`[^`\n]+`|```|\b[\w./-]+\.(?:ts|tsx|js|jsx|py|cs|go|rs|java|json|ya?ml|toml|md|sh|sql|rb|php|kt|swift|cpp|c|h)\b|\b\w+\(\)|\b(?:function|class|method|endpoint|config|service|container|database|query|handler|module|package|version|branch|commit|server|deploy\w*|migration|schema|column|api|bug|error|test|build|repo|file|files)\b/gi

/** A long answer that talks about code or systems; chat and short replies are skipped. */
export function shouldAudit(answer: string, minLength: number): boolean {
  if (answer.length < Math.max(1, minLength)) return false
  return (answer.match(SIGNAL) ?? []).length >= 3
}

export function buildAuditPrompt(answer: string, evidence: readonly string[] = []): string {
  const seen = evidence.length
    ? 'Tool output the assistant saw while writing it (a claim this output supports counts as backed, even when the answer does not quote it):\n' +
      `<tool_output>\n${evidence.join('\n---\n').slice(0, 16000)}\n</tool_output>\n\n`
    : ''
  return (
    'Below is an answer an AI assistant gave about code or a system. List the factual claims it states as certain ' +
    'about code, files, configuration, behaviour, versions or infrastructure that carry NO evidence: ' +
    'no file:line reference, no quoted command output, no URL in the text, and no support in the tool output. Skip opinions, plans, questions, advice, ' +
    'claims marked UNKNOWN or unverified, and claims the text or the tool output backs up. At most 8, each one short sentence in the answer\'s own words.\n' +
    'Reply with JSON only: {"claims": ["...", "..."]}. If every claim is backed, reply {"claims": []}.\n\n' +
    seen +
    `<answer>\n${answer.slice(0, 12000)}\n</answer>`
  )
}

// Keeps the newest tool results of a turn, each cut short, as evidence for the auditor.
export function keepEvidence(list: readonly string[], tool: string, text: string, max = 20): string[] {
  const one = `${tool}: ${text.replace(/\s+/g, ' ').trim().slice(0, 1200)}`
  return [...list, one].slice(-max)
}

const MAX_CLAIMS = 8

/** Reads the model's reply as JSON, tolerating fences, prose around it, arrays and objects. */
export function parseClaims(raw: string): string[] {
  const text = raw.replace(/```(?:json)?/gi, '').trim()
  let value: unknown
  const attempts = [text]
  const obj = [text.indexOf('{'), text.lastIndexOf('}')] as const
  const arr = [text.indexOf('['), text.lastIndexOf(']')] as const
  if (obj[0] >= 0 && obj[1] > obj[0]) attempts.push(text.slice(obj[0], obj[1] + 1))
  if (arr[0] >= 0 && arr[1] > arr[0]) attempts.push(text.slice(arr[0], arr[1] + 1))
  for (const a of attempts) {
    try {
      value = JSON.parse(a)
      break
    } catch {
      // try the next slice
    }
  }
  const list: unknown = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? ((value as Record<string, unknown>).claims ?? (value as Record<string, unknown>).unbacked ?? (value as Record<string, unknown>).items)
      : undefined
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of list) {
    const field = item && typeof item === 'object' ? ((item as Record<string, unknown>).claim ?? (item as Record<string, unknown>).text ?? (item as Record<string, unknown>).statement) : item
    if (typeof field !== 'string') continue
    const claim = field.replace(/\s+/g, ' ').trim().slice(0, 300)
    if (!claim || seen.has(claim.toLowerCase())) continue
    seen.add(claim.toLowerCase())
    out.push(claim)
    if (out.length === MAX_CLAIMS) break
  }
  return out
}

export function buildBackupPrompt(claims: readonly string[]): string {
  return (
    'In your last answer these claims had no evidence:\n' +
    claims.map((c, i) => `${i + 1}. ${c}`).join('\n') +
    '\n\nFor each one, check it now and cite file:line, command output or a URL. ' +
    'If you cannot verify it, mark it UNKNOWN. If it turns out wrong, correct it.'
  )
}

export const bandLabel = (n: number) => `voice: ${n} claim${n === 1 ? '' : 's'} in the last reply cite${n === 1 ? 's' : ''} no source`
