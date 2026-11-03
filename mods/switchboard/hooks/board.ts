import type { BoardRow, SessionState } from '../types'

export const STALE_MS = 90_000
export const CLEAN_MS = 24 * 60 * 60 * 1000

export const parseRow = (text: string): BoardRow | undefined => {
  try {
    const v = JSON.parse(text) as Partial<BoardRow>
    const state = v.state
    if (typeof v.id !== 'string' || typeof v.name !== 'string') return undefined
    if (state !== 'busy' && state !== 'waiting' && state !== 'idle') return undefined
    if (typeof v.since !== 'number' || typeof v.at !== 'number') return undefined
    const context = typeof v.context === 'number' ? v.context : undefined
    return { id: v.id, name: v.name, state, since: v.since, at: v.at, ...(context === undefined ? {} : { context }) }
  } catch {
    return undefined
  }
}

export const isLive = (row: BoardRow, now: number): boolean => now - row.at <= STALE_MS

const ORDER: Record<SessionState, number> = { waiting: 0, busy: 1, idle: 2 }

export const order = (rows: readonly BoardRow[]): BoardRow[] =>
  [...rows].sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.since - b.since)

export const waitingLong = (rows: readonly BoardRow[], now: number, minSeconds: number): BoardRow[] =>
  order(rows.filter(r => r.state === 'waiting' && now - r.since >= minSeconds * 1000))

export const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${Math.floor(h / 24)}d`
}

export const WORDS: Record<SessionState, string> = { waiting: 'needs you', busy: 'working', idle: 'done' }

export const bandText = (waiting: readonly BoardRow[], now: number, room: number): string => {
  const head = waiting.length === 1 ? '1 session needs you: ' : `${waiting.length} sessions need you: `
  const parts = waiting.map(r => `${r.name} ${ago(now - r.since)}`)
  let text = head + parts.join(', ')
  if (text.length <= room) return text
  let kept = parts.length
  while (kept > 1) {
    kept -= 1
    text = `${head}${parts.slice(0, kept).join(', ')} +${parts.length - kept} more`
    if (text.length <= room) return text
  }
  return text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1))}…`
}

export const repoName = (root: string): string => root.split('/').filter(Boolean).pop() ?? root

export const rowName = (root: string, branch: string | undefined): string => {
  const repo = repoName(root)
  return branch && branch !== 'HEAD' && branch !== repo ? `${repo} · ${branch}` : repo
}
