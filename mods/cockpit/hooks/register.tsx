import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AwayInfo, InboxItem, Reading } from '../types'
import {
  clip,
  fillTemplate,
  formatUsd,
  mcpText,
  parseChecks,
  parseGauges,
  parseGitStatus,
  parseIdleSeconds,
  parseIdleText,
  parseJsonObject,
  pickValue,
  pushHistory,
  sparkCells,
  summarize,
  textSparkline,
  toNumber,
} from './lib'
import type { GaugeSpec } from './lib'

const PANE = 'cockpit'
const INBOX_LIMIT = 30
const INBOX_SHOWN = 6
// Deliveries from other sessions and agents; the user's own prompts (bridge) and the harness's wakes stay out.
const INBOX_KINDS = new Set(['peer', 'peer-send-message', 'projects-relay', 'slack-ping'])

const readings = atom({ plugin: 'cockpit', key: 'readings' } as const, {} as Record<string, Reading>)
const inbox = atom({ plugin: 'cockpit', key: 'inbox' } as const, [] as InboxItem[])
const away = atom({ plugin: 'cockpit', key: 'away' } as const, {} as AwayInfo)
const configError = atom({ plugin: 'cockpit', key: 'configError' } as const, '')

type AwayConfig = {
  isOn: boolean
  idleSeconds: number
  summary: string
  presenceServer: string
  presenceTool: string
  presenceArgs: string
  awayServer: string
  awayTool: string
  awayArgs: string
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

async function setReading($: EngineInterface, id: string, text: string, num?: number) {
  const at = await $.clock.now()
  await update($, readings, all => {
    const prev = all[id]
    const history = num === undefined ? (prev?.history ?? []) : pushHistory(prev?.history ?? [], num)
    return { ...all, [id]: { text, num, history, at } }
  })
}

async function failReading($: EngineInterface, id: string, error: string) {
  await update($, readings, all => {
    const prev = all[id]
    return { ...all, [id]: { text: prev?.text ?? '–', num: prev?.num, history: prev?.history ?? [], at: prev?.at ?? 0, error } }
  })
}

async function dropReading($: EngineInterface, id: string) {
  await update($, readings, all => {
    const { [id]: _gone, ...rest } = all
    return rest
  })
}

async function refreshSession($: EngineInterface) {
  const u = await $.session.usage().catch(() => undefined)
  if (!u) return
  await applyUsage($, u.cost?.usd, u.context.percent, u.context.tokens, u.context.window)
}

async function applyUsage($: EngineInterface, usd: number | undefined, percent: number | undefined, tokens: number | undefined, window: number) {
  if (usd !== undefined) await setReading($, 'cost', formatUsd(usd), usd)
  if (percent !== undefined) {
    const k = tokens === undefined ? '' : ` (${Math.round(tokens / 1000)}k of ${Math.round(window / 1000)}k)`
    await setReading($, 'context', `${Math.round(percent)}%${k}`, percent)
  }
}

async function refreshGit($: EngineInterface) {
  const r = await $.process.run(['git', 'status', '--porcelain', '-b'], { timeoutMs: 10000 }).catch(() => undefined)
  if (!r || r.exitCode !== 0) return dropReading($, 'git')
  const { branch, dirty } = parseGitStatus(r.stdout)
  await setReading($, 'git', `${branch}${dirty ? ` · ${dirty} changed` : ' · clean'}`, dirty)
}

// No gh, no PR for this branch or no checks: the gauge simply is not there.
async function refreshPr($: EngineInterface) {
  const r = await $.process.run(['gh', 'pr', 'checks', '--json', 'name,state'], { timeoutMs: 20000 }).catch(() => undefined)
  const summary = r ? parseChecks(r.stdout) : undefined
  if (!summary) return dropReading($, 'pr')
  await setReading($, 'pr', summary.text, summary.failing)
}

async function refreshBuiltins($: EngineInterface) {
  await Promise.all([refreshGit($), refreshPr($)])
}

async function fetchRaw($: EngineInterface, spec: GaugeSpec): Promise<string> {
  if (spec.kind === 'mcp') {
    const r = await $.mcp.call(spec.server ?? '', spec.tool ?? '', spec.args)
    const text = mcpText(r)
    if (r.isError) throw new Error(clip(text, 80) || 'the tool reported an error')
    return text
  }
  if (spec.kind === 'command') {
    const r = await $.process.run(spec.argv ?? [], { timeoutMs: 20000 })
    if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${clip(r.stderr, 80)}`)
    return r.stdout
  }
  const r = await $.http.fetch(spec.url ?? '')
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.text
}

// A gauge whose source hangs (an MCP or HTTP call has no timeout) must not stack one more call every period.
const inFlight = new Set<string>()
// A gauge whose source is down skips 1, 3, 7, then 15 scheduled ticks between tries, so an outage is not polled from every session.
const failing = new Map<string, { count: number; skip: number }>()

async function refreshGauge($: EngineInterface, id: string, spec: GaugeSpec, isScheduled = false) {
  const down = failing.get(id)
  if (isScheduled && down && down.skip > 0) {
    down.skip -= 1
    return
  }
  if (inFlight.has(id)) return
  inFlight.add(id)
  try {
    const picked = pickValue(await fetchRaw($, spec), spec.pick)
    if (picked === undefined) return await failReading($, id, spec.pick ? `nothing matched ${spec.pick}` : 'empty answer')
    failing.delete(id)
    await setReading($, id, clip(picked, 60), toNumber(picked))
  } catch (err) {
    const count = (failing.get(id)?.count ?? 0) + 1
    failing.set(id, { count, skip: 2 ** Math.min(count, 4) - 1 })
    await failReading($, id, clip(err instanceof Error ? err.message : String(err), 80))
  } finally {
    inFlight.delete(id)
  }
}

async function refreshAll($: EngineInterface, gauges: readonly GaugeSpec[]) {
  await Promise.all([refreshSession($), refreshBuiltins($), ...gauges.map((g, i) => refreshGauge($, `g${i}`, g))])
}

// Seconds since the last keyboard or mouse event; undefined when it cannot be known (then the person counts as present).
async function idleSeconds($: EngineInterface, cfg: AwayConfig): Promise<number | undefined> {
  if (cfg.presenceServer && cfg.presenceTool) {
    const args = parseJsonObject(cfg.presenceArgs).value
    const r = await $.mcp.call(cfg.presenceServer, cfg.presenceTool, args).catch(() => undefined)
    return r && !r.isError ? parseIdleText(mcpText(r)) : undefined
  }
  const r = await $.process.run(['ioreg', '-c', 'IOHIDSystem'], { timeoutMs: 5000 }).catch(() => undefined)
  return r && r.exitCode === 0 ? parseIdleSeconds(r.stdout) : undefined
}

async function sendAway($: EngineInterface, cfg: AwayConfig, text: string) {
  if (cfg.awayServer && cfg.awayTool) {
    const template = cfg.awayArgs.trim() ? parseJsonObject(cfg.awayArgs).value : { text: '{{text}}' }
    const args = fillTemplate(template ?? { text: '{{text}}' }, text) as Record<string, unknown>
    const r = await $.mcp.call(cfg.awayServer, cfg.awayTool, args).catch(() => undefined)
    if (r && !r.isError) return
    $.ui.toast('cockpit: the away message did not go through the MCP tool; using a notification')
  }
  const sent = await $.ui.notify(text, { title: 'Claude Code' })
  if (!sent.isSent) $.ui.toast(text)
}

async function awayCheck($: EngineInterface, cfg: AwayConfig, answer: string) {
  if (!cfg.isOn || !answer.trim()) return
  const idle = await idleSeconds($, cfg)
  await update($, away, a => ({ ...a, idleSeconds: idle, note: idle === undefined ? 'idle time unknown; treated as present' : undefined }))
  if (idle === undefined || idle < cfg.idleSeconds) return
  let text = summarize(answer)
  if (cfg.summary === 'haiku') {
    const r = await $.model
      .complete({
        model: 'haiku',
        prompt: `Summarize this final answer from a coding assistant in one plain sentence of at most 200 characters. Say what was done and whether anything needs the person. Reply with the sentence only.\n\n${answer.slice(0, 4000)}`,
      })
      .catch(() => undefined)
    if (r?.isAnswered && r.text.trim()) text = clip(r.text, 300)
  }
  await sendAway($, cfg, text)
  const sentAt = await $.clock.now()
  await update($, away, a => ({ ...a, lastSentAt: sentAt, lastText: text }))
}

export const register: Register = (on, options) => {
  const parsed = parseGauges(str(options.gauges))
  const gauges = parsed.gauges
  const refreshMs = Math.max(5, typeof options.refreshSeconds === 'number' ? options.refreshSeconds : 30) * 1000
  const isQuiet = options.quietInbox === true
  const awayCfg: AwayConfig = {
    isOn: options.awayMode !== false,
    idleSeconds: Math.max(0, (typeof options.awayMinutes === 'number' ? options.awayMinutes : 5) * 60),
    summary: str(options.awaySummary) || 'answer',
    presenceServer: str(options.presenceServer),
    presenceTool: str(options.presenceTool),
    presenceArgs: str(options.presenceArgs),
    awayServer: str(options.awayServer),
    awayTool: str(options.awayTool),
    awayArgs: str(options.awayArgs),
  }
  let timers: Timer[] = []

  on('session.start', async ($, e, next) => {
    for (const t of timers) t.cancel()
    failing.clear()
    await update($, readings, () => ({}))
    await update($, configError, () => parsed.errors.join('; '))
    await $.command.register({ name: 'cockpit', description: 'Open the Cockpit pane (cockpit refresh: refresh every gauge now)' })
    timers = [
      $.clock.every(refreshMs, () => void refreshBuiltins($)),
      ...gauges.map((g, i) => $.clock.every(g.every * 1000, () => void refreshGauge($, `g${i}`, g, true))),
    ]
    void refreshAll($, gauges)
    return next(e)
  })

  on('session.end', ($, e, next) => {
    for (const t of timers) t.cancel()
    timers = []
    return next(e)
  })

  on('command.run', { command: 'cockpit' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Cockpit' })
    await refreshAll($, gauges)
    return { text: 'Cockpit opened.' }
  })

  // Cost and context arrive as the engine measures them.
  on('session.measure', async ($, e, next) => {
    await applyUsage($, e.cost?.usd, e.context.percent, e.context.tokens, e.context.window)
    return next(e)
  })

  on('session.receive', async ($, e, next) => {
    if (e.agentId !== undefined || !INBOX_KINDS.has(e.origin.kind)) return next(e)
    const from = e.event?.from ?? e.origin.kind
    const item: InboxItem = { at: await $.clock.now(), from, text: e.text }
    await update($, inbox, list => [...list, item].slice(-INBOX_LIMIT))
    $.ui.toast(`inbox · ${from}: ${clip(e.text, 80)}`)
    return isQuiet ? { consumed: 'cockpit: quiet inbox' } : next(e)
  }).catch(($, e, next) => next(e)) // a failure here must never swallow a message

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      void refreshSession($)
      void refreshGit($)
      if (e.reason === 'answer') void awayCheck($, awayCfg, e.answer).catch(() => undefined)
    }
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = await read($, readings)
    const mail = await read($, inbox)
    const awayInfo = await read($, away)
    const problem = await read($, configError)
    const width = Math.max(10, Math.min(24, (e.props.bodyColumns ?? 40) - 40))

    const row = (id: string, label: string, onRefresh: () => void) => {
      const r = all[id]
      if (!r) return null
      const showSpark = r.history.length > 1
      let spark = null
      if (showSpark) {
        if (e.surface === 'terminal') {
          const { Raster } = $.ui.resolve(e)
          const s = sparkCells(r.history, width, 0x6a9fb5)
          spark = <Raster key={`spark-${id}`} columns={s.columns} rows={1} cells={s.cells} />
        } else {
          spark = <Text dimColor>{textSparkline(r.history, width)}</Text>
        }
      }
      return (
        <Box flexDirection="row">
          <Text dimColor>{label.padEnd(9)}</Text>
          <Text color={r.error ? undefined : id === 'pr' && r.num ? 'red' : undefined}>{r.text} </Text>
          {spark}
          <Button key={`refresh-${id}`} plain label=" ↻" onPress={onRefresh} />
          {r.error ? <Text dimColor> {r.error}</Text> : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {row('cost', 'cost', () => void refreshSession($))}
        {row('context', 'context', () => void refreshSession($))}
        {row('git', 'git', () => void refreshGit($))}
        {row('pr', 'pr checks', () => void refreshPr($))}
        {gauges.map((g, i) => row(`g${i}`, g.label.slice(0, 9), () => void refreshGauge($, `g${i}`, g)))}
        {problem ? <Text color="red">{problem}</Text> : null}
        <Box flexDirection="row">
          <Button key="refresh-all" plain label="↻ refresh all" onPress={() => void refreshAll($, gauges)} />
        </Box>
        <Text bold>Inbox {mail.length ? `(${mail.length})` : ''}</Text>
        {mail.length === 0 ? <Text dimColor>No messages from other sessions.</Text> : null}
        {mail.slice(-INBOX_SHOWN).map(m => (
          <Text>
            <Text dimColor>{m.from}: </Text>
            {clip(m.text, 120)}
          </Text>
        ))}
        {mail.length ? <Button key="inbox-clear" plain label="clear inbox" onPress={() => void update($, inbox, () => [])} /> : null}
        <Text dimColor>
          {awayCfg.isOn
            ? `away mode: after ${Math.round(awayCfg.idleSeconds / 60)} min idle${awayInfo.idleSeconds === undefined ? '' : ` · idle ${awayInfo.idleSeconds}s at last turn`}${awayInfo.note ? ` · ${awayInfo.note}` : ''}`
            : 'away mode: off'}
        </Text>
      </Box>
    )
  })
}
