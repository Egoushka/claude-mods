import type { RivalFinding } from '../types'

export const REVIEWER_TYPE = 'rival:reviewer'
export const REVIEWER_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'] as const
const MAX_DIFF_CHARS = 60_000

export const REVIEWER_PROMPT = `You are a second reviewer. Another engineer just changed this working tree; you review the diff for correctness bugs only.

Report a finding only if you can name a concrete input or sequence of events under which the code does the wrong thing: wrong result, crash, data loss, race, security hole, broken contract with a caller you have read. Read the surrounding code and the callers before you decide. Do not report style, naming, formatting, missing tests, missing comments, speculative "might" concerns, or taste.

You may read files and run git diff, git log and git show. You cannot change anything.

Finish with one JSON object and nothing after it:
{"findings":[{"file":"path/relative/to/repo","line":123,"title":"one line","scenario":"the concrete input or sequence that fails, and what goes wrong","confidence":0-100}]}
"confidence" is how sure you are, as a whole number. If you find nothing, answer {"findings":[]}.`

export function changedLines(diff: string): number {
  let n = 0
  for (const line of diff.split('\n')) {
    if ((line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))) n += 1
  }
  return n
}

// FNV-1a: a cheap stable fingerprint of `git diff --stat`.
export function hashText(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}

export function buildTask(diff: string): string {
  const isCut = diff.length > MAX_DIFF_CHARS
  const body = isCut ? diff.slice(0, MAX_DIFF_CHARS) : diff
  return (
    'Review this uncommitted diff (git diff HEAD).' +
    (isCut ? ' It is cut; run `git diff HEAD -- <path>` to read the rest.' : '') +
    `\n\n\`\`\`diff\n${body}\n\`\`\``
  )
}

// The reviewer's Bash is git diff, log or show and nothing else: no chaining, no redirects, no output files.
export function isReviewerBash(command: string): boolean {
  const c = command.trim()
  if (!/^git (-C \S+ )?(diff|log|show)( |$)/.test(c)) return false
  if (/[;&|`$()<>\n\\]/.test(c)) return false
  return !/(--output|--ext-diff|--textconv|\s-c\s|--config|--exec)/.test(c)
}

export function isReviewerTool(tool: string): boolean {
  return (REVIEWER_TOOLS as readonly string[]).includes(tool)
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/g
  const candidates: string[] = []
  for (const m of text.matchAll(fenced)) if (m[1]) candidates.push(m[1])
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))
  for (const c of candidates.reverse()) {
    try {
      return JSON.parse(c)
    } catch {
      /* try the next candidate */
    }
  }
  return undefined
}

// undefined: no JSON at all. []: the reviewer found nothing (or nothing above minConfidence).
export function parseFindings(text: string, minConfidence: number): RivalFinding[] | undefined {
  const json = extractJson(text)
  const list = Array.isArray(json) ? json : (json as { findings?: unknown } | undefined)?.findings
  if (!Array.isArray(list)) return undefined
  const out: RivalFinding[] = []
  for (const raw of list) {
    const f = raw as Record<string, unknown> | null
    if (!f || typeof f.file !== 'string' || typeof f.title !== 'string') continue
    const line = Number(f.line)
    const rawConfidence = Number(f.confidence)
    const confidence = Number.isFinite(rawConfidence) ? Math.round(rawConfidence <= 1 ? rawConfidence * 100 : rawConfidence) : 50
    if (confidence < minConfidence) continue
    out.push({
      file: f.file,
      line: Number.isFinite(line) && line > 0 ? Math.floor(line) : 0,
      title: f.title.slice(0, 200),
      scenario: typeof f.scenario === 'string' ? f.scenario.slice(0, 1000) : '',
      confidence: Math.max(0, Math.min(100, confidence)),
    })
  }
  return out.sort((a, b) => b.confidence - a.confidence)
}

export const where = (f: RivalFinding) => (f.line > 0 ? `${f.file}:${f.line}` : f.file)

export function fixPrompt(findings: readonly RivalFinding[]): string {
  const list = findings
    .map((f, i) => `${i + 1}. ${where(f)} (confidence ${f.confidence}%): ${f.title}\n   Failure: ${f.scenario}`)
    .join('\n')
  return (
    'A second reviewer read my uncommitted diff and reports these possible correctness bugs:\n\n' +
    `${list}\n\n` +
    'Verify each one against the code first: open the file, trace the scenario, and decide whether it is real. ' +
    'Fix the real ones with the smallest change, and for each one you reject say in one line why. Do not touch anything else.'
  )
}
