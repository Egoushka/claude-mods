import type { Run } from '../types'

export type Seen = { kind: 'running'; usd?: number; stage?: string } | { kind: 'finished'; status: string } | { kind: 'lost' }

export const parseServers = (text: string): string[] =>
  text
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

// An orchestrate answer that names a run still going: its run-status/v1 text carries the run id.
export const startedRun = (text: string | undefined): string | undefined => {
  if (!text || !/"contract_version"\s*:\s*"run-status\/v1"/.test(text)) return undefined
  if (!/"status"\s*:\s*"(queued|running)"/.test(text)) return undefined
  return /"run_id"\s*:\s*"([^"]+)"/.exec(text)?.[1]
}

// What the `result` tool answered: run-status/v1 while it goes on, result/v1 once it ended.
export const readSeen = (structured: unknown): Seen | undefined => {
  if (typeof structured !== 'object' || structured === null) return undefined
  const s = structured as Record<string, unknown>
  const status = typeof s.status === 'string' ? s.status : ''
  if (s.contract_version === 'result/v1') return { kind: 'finished', status: status || 'finished' }
  if (s.contract_version !== 'run-status/v1') return undefined
  if (status === 'lost') return { kind: 'lost' }
  if (status === 'queued' || status === 'running') {
    return {
      kind: 'running',
      ...(typeof s.usd_total === 'number' ? { usd: s.usd_total } : {}),
      ...(typeof s.stage === 'string' ? { stage: s.stage } : {}),
    }
  }
  return { kind: 'finished', status: status || 'finished' }
}

// The tool's structured answer, or the JSON in its first text block when the server sent only text.
export const structuredOf = (res: { content: readonly { type: string; text?: string }[]; structuredContent?: unknown }): unknown => {
  if (res.structuredContent !== undefined) return res.structuredContent
  const text = res.content.find(b => b.type === 'text')?.text
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export const ago = (ms: number): string => {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`.replace(' 0m', '')
}

export const money = (usd: number): string => `$${usd.toFixed(2)}`

export const shortId = (id: string): string => (id.length > 10 ? `${id.slice(0, 8)}…` : id)

const one = (r: Run, now: number): string => `${shortId(r.id)} ${ago(now - r.since)}${r.stage ? ` ${r.stage}` : ''}${r.usd === undefined ? '' : ` ${money(r.usd)}`}`

// One line that fits the room and says how many runs it left out.
export const rowText = (runs: readonly Run[], now: number, room: number): string => {
  const head = `Chargehand: ${runs.length} running`
  let line = head
  let shown = 0
  for (const r of runs) {
    const next = `${shown === 0 ? ': ' : ', '}${one(r, now)}`
    const more = runs.length - shown - 1
    const tail = more > 0 ? ` +${more} more` : ''
    if (line.length + next.length + tail.length > room) break
    line += next
    shown += 1
  }
  if (shown === 0) return head.length <= room ? head : `${head.slice(0, Math.max(1, room - 1))}…`
  return shown < runs.length ? `${line} +${runs.length - shown} more` : line
}

export const doneText = (run: Run, seen: Seen): string => {
  const cost = run.usd === undefined ? '' : `, ${money(run.usd)}`
  if (seen.kind === 'lost') return `Chargehand run ${shortId(run.id)} was lost: the server stopped before it finished.`
  if (seen.kind === 'finished') return `Chargehand run ${shortId(run.id)} ${seen.status.replace(/_/g, ' ')}${cost}.`
  return ''
}
