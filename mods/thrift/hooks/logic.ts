import type { DietSection, Tier } from '../types'

export const TIERS: readonly Tier[] = ['trivial', 'normal', 'hard']

// Sections that carry the engine's tool and safety rules; dropping them breaks the session.
const PINNED = new Set(['bare', 'lean_body', 'intro', 'system', 'tools', 'actions'])

export const isPinnedSection = (id: string) => PINNED.has(id)

// One token is about four characters of English or code.
export const estimateTokens = (text: string) => Math.ceil(text.length / 4)

export const fmtTokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(Math.round(n)))

export function parseTier(label: string | undefined): Tier | null {
  const t = (label ?? '').trim().toLowerCase()
  return TIERS.find(tier => t.startsWith(tier)) ?? null
}

export function modelForTier(options: Record<string, unknown>, tier: Tier): string {
  const fallback = { trivial: 'haiku', normal: 'sonnet', hard: 'opus' }[tier]
  const key = `${tier}Model`
  const value = options[key]
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

// True when `current` (a full id such as claude-sonnet-x) already is the wanted alias or id.
export const isSameModel = (current: string, wanted: string) => current.toLowerCase().includes(wanted.toLowerCase())

// Least-squares slope over the last `window` points, in tokens per turn.
export function slope(points: readonly number[], window = 6): number {
  const p = points.slice(-window)
  if (p.length < 2) return 0
  const n = p.length
  const meanX = (n - 1) / 2
  const meanY = p.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  p.forEach((y, x) => {
    num += (x - meanX) * (y - meanY)
    den += (x - meanX) ** 2
  })
  return num / den
}

export function turnsLeft(points: readonly number[], limit: number | null): number | null {
  const last = points[points.length - 1]
  if (limit === null || last === undefined) return null
  const s = slope(points)
  if (s <= 0) return null
  return Math.max(0, Math.ceil((limit - last) / s))
}

export function weatherLine(points: readonly number[], limit: number | null, isCompaction: boolean): string | undefined {
  const last = points[points.length - 1]
  if (last === undefined) return undefined
  const s = slope(points)
  const trend = points.length < 2 ? '' : s > 0 ? ` ▲ ${fmtTokens(s)}/turn` : ' ▬ steady'
  const left = turnsLeft(points, limit)
  const goal = isCompaction ? 'compaction' : 'the window limit'
  const tail = left === null ? '' : left === 0 ? ` · past ${goal}` : ` · ~${left} turn${left === 1 ? '' : 's'} to ${goal}`
  return `context ${fmtTokens(last)}${trend}${tail}`
}

// A compaction or /clear shows as a sharp fall; the trend starts over from there.
export const isReset = (prev: number | undefined, next: number) => prev !== undefined && next < prev * 0.7

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
const level = (value: number, limit: number) => Math.min(BLOCKS.length - 1, Math.max(0, Math.floor((value / limit) * BLOCKS.length)))

export const sparkText = (points: readonly number[], limit: number | null, width = 16) => {
  const top = limit ?? Math.max(1, ...points)
  return points.slice(-width).map(v => BLOCKS[level(v, top)]).join('')
}

const colorFor = (ratio: number) => (ratio < 0.6 ? 0x3fb950 : ratio < 0.85 ? 0xd29922 : 0xf85149)
const DEFAULT = 0x01000000

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
export function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=') + (i + 2 < bytes.length ? B64[n & 63]! : '=')
  }
  return out
}

// One row of cells for a Raster: a block glyph per turn, colored by how full the context was.
export function sparkRaster(points: readonly number[], limit: number | null, width = 16): { columns: number; rows: 1; cells: string } {
  const shown = points.slice(-width)
  const top = limit ?? Math.max(1, ...shown)
  const words = new Uint32Array(shown.length * 3)
  shown.forEach((v, i) => {
    words[i * 3] = BLOCKS[level(v, top)]!.codePointAt(0)!
    words[i * 3 + 1] = colorFor(v / top)
    words[i * 3 + 2] = DEFAULT
  })
  const bytes = new Uint8Array(words.length * 4)
  words.forEach((w, i) => {
    bytes[i * 4] = w & 255
    bytes[i * 4 + 1] = (w >> 8) & 255
    bytes[i * 4 + 2] = (w >> 16) & 255
    bytes[i * 4 + 3] = (w >>> 24) & 255
  })
  return { columns: Math.max(1, shown.length), rows: 1, cells: base64(bytes) }
}

export const measureSections = (sections: readonly { id: string; text: string }[]): DietSection[] =>
  sections.map(s => ({ id: s.id, tokens: estimateTokens(s.text), isPinned: isPinnedSection(s.id) }))

// Drops the named sections, never a pinned one; order is kept so shared sections stay ahead of session ones.
export function applyDiet<T extends { id: string; text: string }>(sections: readonly T[], dropped: readonly string[]): { sections: T[]; saved: number } {
  const gone = new Set(dropped.filter(id => !isPinnedSection(id)))
  const kept = sections.filter(s => !gone.has(s.id))
  const saved = sections.filter(s => gone.has(s.id)).reduce((sum, s) => sum + estimateTokens(s.text), 0)
  return { sections: kept, saved }
}

export const savedTokens = (sections: readonly DietSection[], dropped: readonly string[]) =>
  sections.filter(s => dropped.includes(s.id) && !s.isPinned).reduce((sum, s) => sum + s.tokens, 0)
