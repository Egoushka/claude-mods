import type { ForgeFile } from '../types'

const MAX_FILES = 24
const MAX_FILE_CHARS = 120_000
const MAX_TOTAL_CHARS = 400_000
const MAX_PURPOSE = 2000
const ALLOWED_EXT = /\.(ts|tsx|json|md)$/ // covers .d.ts
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
const SEGMENT = /^[A-Za-z0-9._-]+$/
const FORBIDDEN_SEGMENT = /^(\.git|\.env.*|node_modules|\.ssh)$/i

export type Proposal = { name: string; purpose: string; files: ForgeFile[] }
export type Checked = { ok: true; proposal: Proposal } | { ok: false; error: string }

export function checkPath(path: string): string | undefined {
  if (path.length === 0 || path.length > 120) return `path "${path.slice(0, 40)}" is empty or longer than 120 characters`
  if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) return `path "${path}" must be relative and use /`
  const segments = path.split('/')
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..') return `path "${path}" may not contain empty, "." or ".." segments`
    if (!SEGMENT.test(s)) return `path "${path}" uses characters outside letters, digits, . _ -`
    if (FORBIDDEN_SEGMENT.test(s)) return `path "${path}" names a folder or file a mod has no reason to hold (${s})`
  }
  if (!ALLOWED_EXT.test(path)) return `path "${path}" must end in .ts, .tsx, .json or .md`
  return undefined
}

// Everything a proposal is held to before the person sees it.
export function checkProposal(raw: Record<string, unknown>): Checked {
  const name = raw.name
  if (typeof name !== 'string' || !NAME.test(name)) return { ok: false, error: 'name must be 1-40 characters of a-z, 0-9 and "-", starting with a letter or digit' }
  const purpose = raw.purpose
  if (typeof purpose !== 'string' || purpose.trim() === '') return { ok: false, error: 'purpose must say what the mod is for' }
  if (purpose.length > MAX_PURPOSE) return { ok: false, error: `purpose is longer than ${MAX_PURPOSE} characters` }
  const map = raw.files
  if (typeof map !== 'object' || map === null || Array.isArray(map)) return { ok: false, error: 'files must be an object of path to file content' }
  const entries = Object.entries(map as Record<string, unknown>)
  if (entries.length === 0) return { ok: false, error: 'files is empty' }
  if (entries.length > MAX_FILES) return { ok: false, error: `more than ${MAX_FILES} files` }

  const files: ForgeFile[] = []
  const seen = new Set<string>()
  let total = 0
  for (const [path, content] of entries) {
    const bad = checkPath(path)
    if (bad) return { ok: false, error: bad }
    if (typeof content !== 'string') return { ok: false, error: `content of ${path} must be a string` }
    if (content.length > MAX_FILE_CHARS) return { ok: false, error: `${path} is longer than ${MAX_FILE_CHARS} characters` }
    const lower = path.toLowerCase()
    if (seen.has(lower)) return { ok: false, error: `${path} appears twice (paths compare without case)` }
    seen.add(lower)
    total += content.length
    if (path.endsWith('.json')) {
      try {
        JSON.parse(content)
      } catch {
        return { ok: false, error: `${path} is not valid JSON` }
      }
    }
    files.push({ path, content })
  }
  if (total > MAX_TOTAL_CHARS) return { ok: false, error: `the files total more than ${MAX_TOTAL_CHARS} characters` }

  const manifest = files.find(f => f.path === '.claude-plugin/plugin.json')
  if (!manifest) return { ok: false, error: 'files must include .claude-plugin/plugin.json' }
  const declared = (JSON.parse(manifest.content) as { name?: unknown }).name
  if (declared !== name) return { ok: false, error: `.claude-plugin/plugin.json "name" must be "${name}"` }
  return { ok: true, proposal: { name, purpose: purpose.trim(), files } }
}

// `~` is the home folder; `<name>` is the mod's name, appended when the template lacks it.
export function expandDir(template: string, name: string, home: string | undefined): string | undefined {
  let dir = template.trim() || '~/.claude/forged-mods/<name>/'
  dir = dir.includes('<name>') ? dir.replaceAll('<name>', name) : `${dir.replace(/\/+$/, '')}/${name}`
  if (dir === '~' || dir.startsWith('~/')) {
    if (!home) return undefined
    dir = home.replace(/\/+$/, '') + dir.slice(1)
  }
  if (!dir.startsWith('/') || dir.split('/').includes('..')) return undefined
  return dir.replace(/\/+$/, '')
}

export function loadHint(dir: string): string {
  return `claude --plugin-dir ${dir}   (or CLAUDE_CODE_PLUGIN_DIRS=${dir} in the environment of a session that cannot take the flag)`
}

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n... (${text.length - max} more characters)` : text)
