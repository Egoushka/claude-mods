import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run } from '../types'
import { doneText, readSeen, rowText, startedRun, parseServers, structuredOf } from './lib'

const runs = atom({ plugin: 'runstrip', key: 'runs' } as const, [] as Run[], { shape: 'runs-1' })

type Engine = EngineInterface

// Set from the settings at register.
const cfg = { servers: [] as string[], everyMs: 15_000 }

// `result` waits up to a minute for a run, so a read must not start while the last one is out.
const busy = new Set<string>()

// A run that never reports back is dropped after this long.
const GIVE_UP_MS = 6 * 3_600_000

function serverOf(tool: string): string | undefined {
  const m = /^mcp__(.+)__orchestrate$/.exec(tool)
  return m && cfg.servers.includes(m[1] ?? '') ? m[1] : undefined
}

async function look($: Engine, run: Run): Promise<void> {
  if (busy.has(run.id)) return
  busy.add(run.id)
  try {
    const res = await $.mcp.call(run.server, 'result', { run_id: run.id }).catch(() => undefined)
    const seen = res && !res.isError ? readSeen(structuredOf(res)) : undefined
    if (!seen) {
      if ((await $.clock.now()) - run.since > GIVE_UP_MS) await update($, runs, all => all.filter(r => r.id !== run.id))
      return
    }
    if (seen.kind === 'running') {
      await update($, runs, all => all.map(r => (r.id === run.id ? { ...r, usd: seen.usd ?? r.usd, stage: seen.stage ?? r.stage } : r)))
      return
    }
    await update($, runs, all => all.filter(r => r.id !== run.id))
    await $.ui.toast(doneText(run, seen), { timeoutMs: 20_000 })
  } finally {
    busy.delete(run.id)
  }
}

async function tick($: Engine): Promise<void> {
  const all = await read($, runs)
  await Promise.all(all.map(r => look($, r)))
}

export const register: Register = (on, options) => {
  cfg.servers = parseServers(typeof options.servers === 'string' ? options.servers : '')
  cfg.everyMs = Math.max(5, typeof options.everySeconds === 'number' ? options.everySeconds : 15) * 1000
  if (cfg.servers.length === 0) return

  on('session.start', async ($, e, next) => {
    await tick($).catch(() => undefined)
    void $.clock.every(cfg.everyMs, () => tick($).catch(() => undefined))
    return next(e)
  })

  on('tool.call', { tool: /^mcp__.+__orchestrate$/ }, async ($, e, next) => {
    const out = await next(e)
    const server = serverOf(e.tool)
    const id = server ? startedRun(out.text) : undefined
    if (server && id) {
      const since = await $.clock.now()
      await update($, runs, all => (all.some(r => r.id === id) ? all : [...all, { id, server, since }]))
    }
    return out
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const all = await read($, runs)
    if (all.length === 0) return next(e)

    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text color="suggestion">{rowText(all, now, Math.max(20, e.props.bodyColumns - 2))}</Text>
      </Box>
    )
  })
}
