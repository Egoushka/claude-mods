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

// Collapses `.` and `..` and repeated slashes; an absolute path stays absolute.
export function normalizePath(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `${path.startsWith('/') ? '/' : ''}${out.join('/')}`
}

// `~` and `$HOME` cannot be expanded here, so they are tested as written; a relative path is joined to `base`.
function resolveAgainst(base: string, path: string): string {
  if (path.startsWith('/') || path.startsWith('~') || path.startsWith('$') || base === '') return path
  return normalizePath(`${base}/${path}`)
}

const PATH_FIELDS = new Set(['file_path', 'path', 'notebook_path', 'cwd', 'directory', 'dir'])
const TOKEN_BREAKS = /[\s"'`;&|()<>=,]+/

// A session can start outside the boundary and later work inside it (a folder picked after launch,
// a resumed session). Any built-in tool whose input names a path under the boundary marks the session
// as inside from then on: any string in the input counts, so a mention latches too (it fails closed).
// Relative paths are resolved against `base` (the session folder): path fields, and in a shell command
// the targets of `cd`, `pushd`, `-C` and any `./x`, `../x` or `dir/x` word, following each `cd` in order.
// MCP tools are skipped: their arguments are text, not places.
export function touchesBoundary(paths: RegExp | undefined, tool: string, input: Record<string, unknown>, base = ''): boolean {
  if (!paths || tool.startsWith('mcp__')) return false
  const hit = (text: string) => paths.test(text)
  const strings: { key: string; text: string }[] = []
  const walk = (key: string, value: unknown, depth: number) => {
    if (typeof value === 'string') strings.push({ key, text: value })
    else if (depth < 3 && value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(k, v, depth + 1)
  }
  const { tool: _tool, tool_use_id: _id, ...rest } = input
  for (const [k, v] of Object.entries(rest)) walk(k, v, 0)

  return strings.some(({ key, text }) => {
    if (hit(text)) return true
    if (PATH_FIELDS.has(key) && hit(resolveAgainst(base, text))) return true
    // Shell-style text, one command at a time. After a `cd`, every plain word is a possible path.
    let cwd: string | undefined = base
    let hasMoved = false
    for (const segment of text.split(/[;&|\n]+/)) {
      const words = segment.split(TOKEN_BREAKS).filter(w => w !== '')
      const [first = ''] = words
      const isCd = first === 'cd' || first === 'pushd'
      for (let i = 0; i < words.length; i += 1) {
        const word = words[i] ?? ''
        if (hit(word)) return true
        const previous = words[i - 1] ?? ''
        const isTarget = previous === '-C' || previous === '--cwd'
        const isPlain = !word.startsWith('-') && !(isCd && i === 0)
        if (cwd === undefined) {
          if (isPlain && (i > 0 || !isCd)) return true
          continue
        }
        if (isPlain && (isTarget || word.includes('/') || hasMoved || (isCd && i > 0))) {
          const full = resolveAgainst(cwd, word)
          if (hit(full) || hit(`${full}/`)) return true
        }
      }
      if (isCd) {
        const target = words.slice(1).find(w => !w.startsWith('-') || w === '-')
        if (target === undefined || target === '-') cwd = undefined // home or the previous folder: unknown, so fail closed
        else if (cwd !== undefined) cwd = resolveAgainst(cwd, target)
        hasMoved = true
      }
    }
    return false
  })
}

// The tools a session is offered: inside, the fenced ones are hidden; outside, the inside-only ones; with no
// known folder, both.
export function visibleTools<T extends { name: string }>(b: Boundary, where: 'inside' | 'outside' | 'unknown', tools: T[]): T[] {
  const hide = (name: string) =>
    (where !== 'outside' && b.fencedTools?.test(name)) || (where !== 'inside' && b.insideOnlyTools?.test(name))
  return tools.filter(t => !hide(t.name))
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
  // KEY=value assignments of env-style names (upper case, so code like `const tokens = x` is left alone); keeps the name
  ['assignment', /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*["']?([^\s"'`]{8,})/g],
  ['conn-string', /\b(Password|Pwd)=([^;"'\s]{4,})/gi],
]

// A dotted path or a call (process.env.TOKEN, getToken()) is code that reads a secret, not the secret.
const isCodeLike = (value: string) => /^[A-Za-z_$][\w$]*(\.[\w$]+)+[;,)]*$|\(/.test(value)

export function maskSecrets(text: string): { text: string; count: number } {
  let count = 0
  let out = text
  for (const [kind, re] of SECRETS) {
    out = out.replace(re, (match, name?: string, value?: string) => {
      if (match.includes('[masked:')) return match
      count += 1
      if ((kind === 'assignment' || kind === 'conn-string') && name && value) {
        if (/^\$\{?[A-Z_]+\}?$|^<.*>$|^\*+$|^(true|false|null|undefined)$/i.test(value) || isCodeLike(value)) {
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
