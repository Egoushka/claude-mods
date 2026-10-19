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

// One line: the context size once and how fast it grows per turn (each turn re-sends all of it).
export function contextLine(points: readonly number[]): string | undefined {
  const last = points[points.length - 1]
  if (last === undefined) return undefined
  if (points.length < 2) return `context ${fmtTokens(last)}`
  const s = slope(points)
  return s > 0 ? `context ${fmtTokens(last)}, growing ~${fmtTokens(s)} per turn` : `context ${fmtTokens(last)}, steady`
}

const TIER_WORDS: Record<string, string> = { trivial: 'simple', normal: 'routine', hard: 'hard' }

// The router's line, shown only when it would change something.
export function routeLine(r: { tier: string | null; model: string | null; isApplied: boolean; current: string | null }, isSame: boolean): string | undefined {
  if (!r.tier || !r.model || isSame) return undefined
  const kind = TIER_WORDS[r.tier] ?? r.tier
  return r.isApplied
    ? `${kind} prompt: this turn runs on ${r.model}`
    : `${kind} prompt: ${r.model} would do${r.current ? ` (you're on ${r.current})` : ''}; /model ${r.model} to switch`
}

// A compaction or /clear shows as a sharp fall; the trend starts over from there.
export const isReset = (prev: number | undefined, next: number) => prev !== undefined && next < prev * 0.7

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
