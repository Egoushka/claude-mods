import type { Spender } from '../types'

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// A session whose file was not refreshed for this long is gone.
export const LIVE_MS = 10 * 60_000

const NAMES: Record<string, string> = { five_hour: '5-hour limit', seven_day: 'weekly limit', spend_limit: 'spend limit' }

export const windowName = (kind: string): string => NAMES[kind] ?? kind.replace(/_/g, ' ')

export const windowKey = (l: Limit): string => `${l.kind}@${l.resetsAt ?? ''}`

// Windows over the line that have not been warned about yet. A window that reset has a new key, so it warns again.
export const newlyOver = (limits: readonly Limit[], percent: number, warned: readonly string[]): Limit[] =>
  limits.filter(l => l.percentUsed >= percent && !warned.includes(windowKey(l)))

// Keeps the list short: only the windows that still exist can matter.
export const keepWarned = (warned: readonly string[], limits: readonly Limit[]): string[] => {
  const live = new Set(limits.map(windowKey))
  return warned.filter(k => live.has(k))
}

export const resetsIn = (resetsAt: string | undefined, now: number): string | undefined => {
  const t = resetsAt ? Date.parse(resetsAt) : NaN
  if (Number.isNaN(t) || t <= now) return undefined
  const mins = Math.round((t - now) / 60_000)
  if (mins < 60) return `${Math.max(1, mins)}m`
  const h = Math.floor(mins / 60)
  if (h < 48) return mins % 60 === 0 ? `${h}h` : `${h}h ${mins % 60}m`
  return `${Math.round(h / 24)}d`
}

export const parseSpender = (text: string): Spender | undefined => {
  try {
    const j = JSON.parse(text) as Partial<Spender>
    if (typeof j.id !== 'string' || typeof j.name !== 'string' || typeof j.usd !== 'number' || typeof j.at !== 'number') return undefined
    return { id: j.id, name: j.name, usd: j.usd, at: j.at }
  } catch {
    return undefined
  }
}

export const money = (usd: number): string => `$${usd.toFixed(2)}`

// The sessions that spent the most, live ones only, biggest first.
export const topSpenders = (rows: readonly Spender[], now: number, n: number): Spender[] =>
  rows
    .filter(r => now - r.at <= LIVE_MS && r.usd > 0)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, n)

export const toastText = (over: readonly Limit[], now: number, spenders: readonly Spender[], myId: string): string => {
  const parts = over.map(l => {
    const left = resetsIn(l.resetsAt, now)
    return `${windowName(l.kind)} ${Math.round(l.percentUsed)}% used${left ? `, resets in ${left}` : ''}`
  })
  const head = `Usage: ${parts.join('; ')}.`
  if (spenders.length === 0) return head
  const who = spenders.map(s => `${s.name} ${money(s.usd)}${s.id === myId ? ' (this one)' : ''}`).join(', ')
  return `${head} Spent so far: ${who}.`
}

export const baseName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || 'session'
