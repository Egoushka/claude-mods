import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { baseName, keepWarned, newlyOver, parseSpender, topSpenders, toastText } from './lib'

const warned = atom({ plugin: 'ratewatch', key: 'warned' } as const, [] as string[], { shape: 'warned-1' })

type Engine = EngineInterface

const WRITE_EVERY_MS = 30_000
const cfg = { percent: 80, share: true, custom: '' }
// What this session knows about its own file; a reload starts it over.
const me = { id: '', name: 'session', dir: '', lastWrite: 0, lastUsd: -1 }

async function folder($: Engine): Promise<string> {
  if (me.dir) return me.dir
  me.dir = cfg.custom || `${(await $.env.get('HOME')) ?? ''}/.claude/ratewatch`
  return me.dir
}

async function writeCost($: Engine, usd: number | undefined): Promise<void> {
  if (!cfg.share || !me.id || usd === undefined || usd === me.lastUsd) return
  const now = await $.clock.now()
  if (now - me.lastWrite < WRITE_EVERY_MS) return
  me.lastWrite = now
  me.lastUsd = usd
  await $.fs.write(`${await folder($)}/${me.id}.json`, JSON.stringify({ id: me.id, name: me.name, usd, at: now })).catch(() => undefined)
}

async function others($: Engine) {
  const base = await folder($)
  const files = await $.fs.list(base).catch(() => [])
  const rows = []
  for (const f of files) {
    if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
    const text = await $.fs.read(`${base}/${f.name}`).catch(() => '')
    const row = typeof text === 'string' ? parseSpender(text) : undefined
    if (row) rows.push(row)
  }
  return rows
}

export const register: Register = (on, options) => {
  const pct = typeof options.percent === 'number' ? options.percent : 80
  cfg.percent = Math.min(100, Math.max(10, pct))
  cfg.share = options.share !== false
  cfg.custom = typeof options.dir === 'string' ? options.dir.trim() : ''

  on('session.start', async ($, e, next) => {
    me.id = await $.session.id()
    me.name = baseName(await $.session.root())
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (cfg.share && me.id) await $.process.run(['rm', '-f', `${await folder($)}/${me.id}.json`]).catch(() => undefined)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await writeCost($, e.cost?.usd)
    const seen = await read($, warned)
    const over = newlyOver(e.rateLimits, cfg.percent, seen)
    const kept = keepWarned(seen, e.rateLimits)
    if (over.length === 0) {
      if (kept.length !== seen.length) await update($, warned, () => kept)
      return next(e)
    }
    await update($, warned, () => [...kept, ...over.map(l => `${l.kind}@${l.resetsAt ?? ''}`)])
    const now = await $.clock.now()
    // The warning is for the window, so this session's own cost goes in even when its last write is still queued.
    const rows = cfg.share ? await others($) : []
    if (e.cost && !rows.some(r => r.id === me.id)) rows.push({ id: me.id, name: me.name, usd: e.cost.usd, at: now })
    const mine = rows.map(r => (r.id === me.id && e.cost ? { ...r, usd: e.cost.usd, at: now } : r))
    $.ui.toast(toastText(over, now, topSpenders(mine, now, 3), me.id), { timeoutMs: 20_000 })
    return next(e)
  })
}
