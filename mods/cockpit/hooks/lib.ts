// Pure helpers of the cockpit mod: parsing, extraction, drawing math. No engine calls here.

export type GaugeSpec = {
  label: string
  kind: 'mcp' | 'command' | 'http'
  server?: string
  tool?: string
  args?: Record<string, unknown>
  argv?: string[]
  url?: string
  every: number
  pick?: string
}

export const MIN_EVERY = 5
export const DEFAULT_EVERY = 60
export const HISTORY = 40

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// A bad entry is reported and skipped; the rest still load.
export function parseGauges(raw: string): { gauges: GaugeSpec[]; errors: string[] } {
  const text = raw.trim()
  if (!text) return { gauges: [], errors: [] }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { gauges: [], errors: ['gauges: not valid JSON'] }
  }
  if (!Array.isArray(json)) return { gauges: [], errors: ['gauges: expected a JSON array'] }
  const gauges: GaugeSpec[] = []
  const errors: string[] = []
  json.forEach((item: unknown, i) => {
    const at = `gauges[${i}]`
    if (!isRecord(item)) return void errors.push(`${at}: not an object`)
    const label = typeof item.label === 'string' ? item.label.trim() : ''
    if (!label) return void errors.push(`${at}: label is required`)
    const every = typeof item.every === 'number' && Number.isFinite(item.every) ? Math.max(MIN_EVERY, item.every) : DEFAULT_EVERY
    const pick = typeof item.pick === 'string' && item.pick !== '' ? item.pick : undefined
    const base = { label, every, pick }
    if (item.kind === 'mcp') {
      if (typeof item.server !== 'string' || typeof item.tool !== 'string' || !item.server || !item.tool)
        return void errors.push(`${at} (${label}): mcp needs server and tool`)
      const args = isRecord(item.args) ? item.args : undefined
      gauges.push({ ...base, kind: 'mcp', server: item.server, tool: item.tool, args })
    } else if (item.kind === 'command') {
      if (!Array.isArray(item.argv) || item.argv.length === 0 || !item.argv.every(a => typeof a === 'string'))
        return void errors.push(`${at} (${label}): command needs argv, an array of strings`)
      gauges.push({ ...base, kind: 'command', argv: item.argv as string[] })
    } else if (item.kind === 'http') {
      if (typeof item.url !== 'string' || !/^https?:\/\//i.test(item.url)) return void errors.push(`${at} (${label}): http needs an http(s) url`)
      gauges.push({ ...base, kind: 'http', url: item.url })
    } else {
      errors.push(`${at} (${label}): kind must be mcp, command or http`)
    }
  })
  return { gauges, errors }
}

function walk(value: unknown, path: string): unknown {
  let cur: unknown = value
  for (const part of path.split('.').filter(Boolean)) {
    if (Array.isArray(cur)) cur = cur[Number(part)]
    else if (isRecord(cur)) cur = cur[part]
    else return undefined
  }
  return cur
}

// `pick` is /regex/ (first capture group, else the match) or a dotted path into JSON (`data.items.0.count`).
// No pick: the first non-empty line. Returns undefined when nothing matched.
export function pickValue(raw: string, pick: string | undefined): string | undefined {
  if (!pick) return raw.split('\n').find(l => l.trim())?.trim() || undefined
  const re = /^\/(.+)\/([a-z]*)$/s.exec(pick)
  if (re) {
    let rx: RegExp
    try {
      rx = new RegExp(re[1] ?? '', (re[2] ?? '').replace(/[^imsu]/g, ''))
    } catch {
      return undefined
    }
    const m = rx.exec(raw)
    return m ? (m[1] ?? m[0]) : undefined
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return undefined
  }
  const found = walk(json, pick)
  if (found === undefined || found === null) return undefined
  return typeof found === 'object' ? JSON.stringify(found) : String(found)
}

// A strict number: "42", "-3.5", "12%" and "1,200" count; "v2 ok" does not.
export function toNumber(text: string): number | undefined {
  const m = /^\s*(-?\d[\d,]*(?:\.\d+)?)\s*%?\s*$/.exec(text)
  if (!m) return undefined
  const n = Number((m[1] ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : undefined
}

export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

export function pushHistory(history: readonly number[], n: number): number[] {
  return [...history, n].slice(-HISTORY)
}

const BARS = '▁▂▃▄▅▆▇█'

// Eight levels per cell, scaled to the series' own min and max; a flat series draws the lowest bar.
export function levels(values: readonly number[], width: number): number[] {
  const v = values.slice(-width)
  if (v.length === 0) return []
  const lo = Math.min(...v)
  const hi = Math.max(...v)
  return v.map(n => (hi === lo ? 0 : Math.min(7, Math.floor(((n - lo) / (hi - lo)) * 8))))
}

export function textSparkline(values: readonly number[], width = 20): string {
  return levels(values, width)
    .map(l => BARS[l] ?? '▁')
    .join('')
}

const DEFAULT_COLOR = 0x01000000

// One row of cells for a Raster: [codePoint, foreground, background] u32 triplets, base64.
export function sparkCells(values: readonly number[], width: number, color: number): { columns: number; cells: string } {
  const ls = levels(values, width)
  const columns = Math.max(1, ls.length)
  const words = new Uint32Array(columns * 3)
  for (let i = 0; i < columns; i += 1) {
    words[i * 3] = (ls.length ? (BARS[ls[i] ?? 0] ?? '▁') : ' ').codePointAt(0) ?? 0x20
    words[i * 3 + 1] = color
    words[i * 3 + 2] = DEFAULT_COLOR
  }
  return { columns, cells: base64(new Uint8Array(words.buffer)) }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
export function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += (B64[(n >> 18) & 63] ?? '') + (B64[(n >> 12) & 63] ?? '')
    out += i + 1 < bytes.length ? (B64[(n >> 6) & 63] ?? '') : '='
    out += i + 2 < bytes.length ? (B64[n & 63] ?? '') : '='
  }
  return out
}

// `git status --porcelain -b`: the branch line, then one line per changed path.
export function parseGitStatus(out: string): { branch: string; dirty: number } {
  const lines = out.split('\n').filter(Boolean)
  const head = lines[0]?.startsWith('## ') ? (lines.shift() ?? '') : ''
  let branch = head.slice(3).split('...')[0] ?? ''
  branch = branch.replace(/^No commits yet on /, '').replace(/^Initial commit on /, '')
  if (!branch || branch.startsWith('HEAD')) branch = 'detached'
  return { branch, dirty: lines.length }
}

export type CheckSummary = { text: string; failing: number; pending: number; total: number }

// `gh pr checks --json name,state`: states are SUCCESS, FAILURE, PENDING, SKIPPED, CANCELLED, ...
export function parseChecks(out: string): CheckSummary | undefined {
  let json: unknown
  try {
    json = JSON.parse(out)
  } catch {
    return undefined
  }
  if (!Array.isArray(json) || json.length === 0) return undefined
  let ok = 0
  let failing = 0
  let pending = 0
  let other = 0
  for (const c of json) {
    const state = String(isRecord(c) ? c.state : '').toUpperCase()
    if (state === 'SUCCESS') ok += 1
    else if (['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(state)) failing += 1
    else if (['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'].includes(state)) pending += 1
    else other += 1
  }
  const parts = [`${ok}✓`]
  if (failing) parts.push(`${failing}✗`)
  if (pending) parts.push(`${pending}…`)
  if (other) parts.push(`${other} skipped`)
  return { text: parts.join(' '), failing, pending, total: json.length }
}

// `ioreg -c IOHIDSystem`: HIDIdleTime is nanoseconds since the last keyboard or mouse event.
export function parseIdleSeconds(ioreg: string): number | undefined {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioreg)
  return m ? Math.floor(Number(m[1]) / 1e9) : undefined
}

// A presence tool answers a bare number of seconds, or JSON with the number somewhere.
export function parseIdleText(text: string): number | undefined {
  const n = toNumber(text)
  if (n !== undefined) return n
  const m = /-?\d+(?:\.\d+)?/.exec(text)
  return m ? Number(m[0]) : undefined
}

// Fills "{{text}}" in every string of a JSON template; walking the value avoids breaking the JSON with quotes in the text.
export function fillTemplate(template: unknown, text: string): unknown {
  if (typeof template === 'string') return template.split('{{text}}').join(text)
  if (Array.isArray(template)) return template.map(t => fillTemplate(t, text))
  if (isRecord(template)) return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, fillTemplate(v, text)]))
  return template
}

export function parseJsonObject(raw: string): { value?: Record<string, unknown>; error?: string } {
  if (!raw.trim()) return {}
  try {
    const v: unknown = JSON.parse(raw)
    return isRecord(v) ? { value: v } : { error: 'expected a JSON object' }
  } catch {
    return { error: 'not valid JSON' }
  }
}

export function summarize(answer: string, max = 300): string {
  return clip(answer, max)
}

export function formatUsd(usd: number): string {
  return usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`
}

export function mcpText(result: { content: readonly { type: string; text?: string }[]; structuredContent?: unknown }): string {
  const text = result.content
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
  if (text) return text
  return result.structuredContent === undefined ? '' : JSON.stringify(result.structuredContent)
}
