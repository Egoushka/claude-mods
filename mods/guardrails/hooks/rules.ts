// Pure rules, kept apart from the hooks so tests can hit them directly.

export type Boundary = {
  paths?: RegExp
  fencedTools?: RegExp
  fencedHosts?: RegExp
  insideOnlyTools?: RegExp
}

export function compile(source: unknown): RegExp | undefined {
  if (typeof source !== 'string' || source.trim() === '') return undefined
  try {
    return new RegExp(source)
  } catch {
    return undefined
  }
}

// What a call would cross: a fenced session reaching out, or an outside session writing in.
export function boundaryDenial(b: Boundary, isInside: boolean, tool: string, input: Record<string, unknown>): string | undefined {
  if (isInside) {
    if (b.fencedTools?.test(tool)) return `${tool} is outside this session's boundary.`
    const url = typeof input.url === 'string' ? input.url : ''
    if (tool === 'WebFetch' && b.fencedHosts?.test(url)) return `${url} is outside this session's boundary.`
    const command = typeof input.command === 'string' ? input.command : ''
    if (tool === 'Bash' && b.fencedHosts?.test(command)) return 'this command reaches a host outside this session\'s boundary.'
    return undefined
  }
  if (b.insideOnlyTools?.test(tool)) return `${tool} may be called only from inside the boundary.`
  return undefined
}

const SECRETS: [string, RegExp][] = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['anthropic', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g],
  ['github', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['gitlab', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['aws', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['slack', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['google', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['stripe', /\b[rs]k_live_[A-Za-z0-9]{20,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['telegram-bot', /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g],
  // key=value assignments of things named like secrets; keeps the name, masks the value
  ['assignment', /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*["']?([^\s"'`]{8,})/gi],
  ['conn-string', /\b(Password|Pwd)=([^;"'\s]{4,})/gi],
]

export function maskSecrets(text: string): { text: string; count: number } {
  let count = 0
  let out = text
  for (const [kind, re] of SECRETS) {
    out = out.replace(re, (match, name?: string, value?: string) => {
      if (match.includes('[masked:')) return match
      count += 1
      if ((kind === 'assignment' || kind === 'conn-string') && name && value) {
        if (/^\$\{?[A-Z_]+\}?$|^<.*>$|^\*+$|^(true|false|null|undefined)$/i.test(value)) {
          count -= 1
          return match
        }
        return match.replace(value, `[masked:${kind}]`)
      }
      return `[masked:${kind}]`
    })
  }
  return { text: out, count }
}

const IRREVERSIBLE: [string, RegExp][] = [
  ['force push', /\bgit\s+push\b[^;&|]*(\s--force\b|\s-f\b|\s\+\S+)/],
  ['hard reset', /\bgit\s+reset\s+--hard\b/],
  ['git clean', /\bgit\s+clean\s+-[a-z]*f/],
  ['branch delete', /\bgit\s+branch\s+-D\b/],
  ['recursive delete', /\brm\s+-[a-z]*r[a-z]*f?\b(?![^;&|]*(\$TMPDIR|\/tmp\/claude|node_modules|\bbin\/|\bobj\/|dist\/|\.cache))/],
  ['sql drop', /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i],
  ['sql delete without where', /\bDELETE\s+FROM\s+\S+\s*(;|$|")/i],
  ['migration', /\bdotnet\s+ef\s+database\s+update\b/],
  ['container wipe', /\b(docker\s+(system|volume)\s+prune|docker\s+rm\s+-f|kubectl\s+delete|terraform\s+destroy)\b/],
  ['repo delete', /\bgh\s+repo\s+delete\b/],
]

export function irreversibleKind(command: string): string | undefined {
  return IRREVERSIBLE.find(([, re]) => re.test(command))?.[0]
}

export type Correction = { command: string; why: string }

// gh subcommands that accept -R owner/repo
const GH_REPO_SCOPED = /^gh\s+(pr|issue|run|workflow|release|label|cache|secret|variable|repo\s+view)\b/

export function shellCorrection(command: string): { deny?: string; cdGh?: { dir: string; gh: string }; fix?: Correction } {
  const trimmed = command.trim()
  const cdGh = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*(gh\s.+)$/s.exec(trimmed)
  if (cdGh) {
    const dir = cdGh[1]!.replace(/^["']|["']$/g, '')
    const gh = cdGh[2]!.trim()
    if (/[|>]/.test(gh)) return { deny: ghPipeAdvice }
    if (GH_REPO_SCOPED.test(gh) && !/\s(-R|--repo)\s/.test(gh)) return { cdGh: { dir, gh } }
    return { deny: 'gh leaves the sandbox only as a standalone call: drop the `cd … &&` and pass `-R owner/repo`.' }
  }
  if (/^gh\s/.test(trimmed) && /\|\s*(jq|head|grep)|\s>\s?\S/.test(trimmed)) return { deny: ghPipeAdvice }

  const timeout = /^timeout\s+\d+[smh]?\s+(.+)$/s.exec(trimmed)
  if (timeout) return { fix: { command: timeout[1]!, why: 'macOS has no `timeout`; dropped it (use the Bash tool timeout).' } }

  if (/^(echo|printf)\s/.test(trimmed) && /(^|\s)=[^\s'"]*/.test(trimmed)) {
    const quoted = trimmed.replace(/(^|\s)(=[^\s'"]*)/g, (_, pre: string, word: string) => `${pre}'${word}'`)
    if (quoted !== trimmed) return { fix: { command: quoted, why: "quoted words starting with `=` (zsh expands them)." } }
  }
  return {}
}

const ghPipeAdvice =
  'gh leaves the sandbox only as a standalone call: no pipes or redirects. Use `--json <fields> --jq <expr>` instead of `| jq`.'

export function repoFromRemote(url: string): string | undefined {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(\.git)?\s*$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : undefined
}

export function budgetFor(size: string | undefined): number {
  return { tiny: 40, small: 150, medium: 500, large: 1500 }[size ?? ''] ?? 500
}
