import type { Red } from '../types'

const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

// `gh pr checks --json name,state`: the names of the checks that failed.
export const failingChecks = (out: string): string[] => {
  try {
    const json: unknown = JSON.parse(out)
    if (!Array.isArray(json)) return []
    const names: string[] = []
    for (const c of json) {
      const r = c as { name?: unknown; state?: unknown }
      if (typeof r.name === 'string' && FAILED.includes(String(r.state).toUpperCase())) names.push(r.name)
    }
    return names
  } catch {
    return []
  }
}

export type Verdict = { kind: 'ok' } | { kind: 'red'; line: string } | { kind: 'unknown' }

const lastLine = (text: string): string => text.split('\n').map(l => l.trim()).filter(Boolean).pop() ?? ''

export const healthVerdict = (exitCode: number, out: string, okPattern: string): Verdict => {
  let ok: RegExp | undefined
  if (okPattern) {
    try {
      ok = new RegExp(okPattern, 'm')
    } catch {
      return { kind: 'unknown' }
    }
  }
  if (ok) {
    if (exitCode !== 0) return { kind: 'unknown' }
    return ok.test(out) ? { kind: 'ok' } : { kind: 'red', line: lastLine(out) || 'not ok' }
  }
  return exitCode === 0 ? { kind: 'ok' } : { kind: 'red', line: lastLine(out) || `exit ${exitCode}` }
}

export const parseArgv = (text: string): string[] | undefined => {
  if (!text.trim()) return undefined
  try {
    const v: unknown = JSON.parse(text)
    return Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string') ? (v as string[]) : undefined
  } catch {
    return undefined
  }
}

export const isRed = (r: Red): boolean => r.health !== undefined || (r.ci?.length ?? 0) > 0

// What a Hide press remembers: the row comes back when this changes.
export const signature = (r: Red): string => JSON.stringify([r.health ?? null, r.ci ?? []])

export const rowText = (r: Red, label: string, room: number): string => {
  const parts: string[] = []
  if (r.health !== undefined) parts.push(`${label}: ${r.health}`)
  const ci = r.ci ?? []
  if (ci.length > 0) parts.push(ci.length === 1 ? `CI failing: ${ci[0]}` : `CI failing: ${ci[0]} +${ci.length - 1} more`)
  const text = parts.join(' · ')
  return text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1))}…`
}

export const fixPrompt = (r: Red, label: string): string => {
  const asks: string[] = []
  if (r.health !== undefined) asks.push(`The ${label.toLowerCase()} check is red: "${r.health}". Find the cause with read-only commands and propose a fix.`)
  if ((r.ci?.length ?? 0) > 0) asks.push(`CI is failing on this branch's PR (${r.ci?.join(', ')}). Read the failed logs, fix the cause and say what you changed.`)
  return asks.join('\n')
}
