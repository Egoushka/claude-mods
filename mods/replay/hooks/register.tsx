import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Change } from '../types'
import { unifiedDiff } from './diff'

const PANE = 'replay'
const changes = atom({ plugin: 'replay', key: 'changes' } as const, [] as Change[])
const turn = atom({ plugin: 'replay', key: 'turn' } as const, 0)
const viewTurn = atom({ plugin: 'replay', key: 'viewTurn' } as const, null)

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const MAX_READ = 4 * 1024 * 1024 - 1

// The file's text; null when it does not exist yet; undefined when it cannot be diffed (too big, unreadable).
async function snapshot($: EngineInterface, path: string): Promise<string | null | undefined> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (!stat) return null
  if (stat.kind !== 'file' || stat.size > MAX_READ) return undefined
  return $.fs.read(path).then(
    text => (typeof text === 'string' ? text : undefined),
    () => undefined,
  )
}

async function record(
  $: EngineInterface,
  tool: string,
  file: string,
  before: string | null | undefined,
  after: string | null | undefined,
  limits: { maxChanges: number; maxDiffChars: number },
) {
  const at = await read($, turn)
  const base = { turn: at, tool, file, added: 0, removed: 0, diff: '', omitted: 0 }
  let entry: Omit<Change, 'id'>
  if (before === undefined || after === undefined || after === null) {
    entry = { ...base, note: 'not diffed: the file is over 4 MiB or could not be read' }
  } else {
    if (before === after) return
    const d = unifiedDiff(before ?? '', after, limits.maxDiffChars)
    entry = { ...base, ...d, ...(before === null ? { note: 'new file' } : {}) }
  }
  await update($, changes, list => [...list, { ...entry, id: (list[list.length - 1]?.id ?? 0) + 1 }].slice(-limits.maxChanges))
}

const turnsOf = (list: readonly Change[]) => [...new Set(list.map(c => c.turn))].sort((a, b) => a - b)

// Moves the view to the previous (-1) or next (+1) turn that has a change.
async function step($: EngineInterface, by: number) {
  const turns = turnsOf(await read($, changes))
  if (turns.length === 0) return
  const shown = (await read($, viewTurn)) ?? turns[turns.length - 1] ?? 0
  const at = Math.max(0, turns.indexOf(shown))
  const next = turns[Math.max(0, Math.min(turns.length - 1, at + by))] ?? shown
  await update($, viewTurn, () => next)
}

export const register: Register = (on, options) => {
  const maxChanges = Math.max(1, typeof options.maxChanges === 'number' ? options.maxChanges : 100)
  const maxDiffChars = Math.max(500, typeof options.maxDiffChars === 'number' ? options.maxDiffChars : 12000)
  let cwd = ''

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({ name: 'replay', description: "Scrub through this session's file changes, turn by turn" })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, changes, () => [])
      await update($, turn, () => 0)
      await update($, viewTurn, () => null)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) await update($, turn, n => n + 1)
    return next(e)
  })

  // The old file is read before the tool runs and the new one after, so the diff is what is on disk, not what was asked for.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const path = (e as unknown as { file_path?: unknown }).file_path
    if (!FILE_TOOLS.has(tool) || typeof path !== 'string') return next(e)
    const before = await snapshot($, path)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const after = await snapshot($, path)
    const file = cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
    await record($, tool, file, before, after, { maxChanges, maxDiffChars }).catch(() => undefined)
    return ran
  })

  on('command.run', { command: 'replay' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Replay', focus: true, closeOnEscape: true })
    return { text: 'Replay pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const list = await read($, changes)
    if (list.length === 0) return <Text dimColor>No file changes yet. Edits and writes show up here as they happen.</Text>

    const turns = turnsOf(list)
    const picked = await read($, viewTurn)
    const shown = picked !== null && turns.includes(picked) ? picked : (turns[turns.length - 1] ?? 0)
    const at = turns.indexOf(shown)
    const here = list.filter(c => c.turn === shown)
    const added = here.reduce((sum, c) => sum + c.added, 0)
    const removed = here.reduce((sum, c) => sum + c.removed, 0)
    const near = turns.slice(Math.max(0, at - 4), at + 5)

    return (
      <Box flexDirection="column">
        <Box>
          <Button key="prev" label="◀" hotkey="p" onPress={() => step($, -1)} />
          <Text bold>
            {' '}
            turn {shown} ({at + 1} of {turns.length}){' '}
          </Text>
          <Button key="next" label="▶" hotkey="n" onPress={() => step($, 1)} />
          <Text dimColor>
            {'  '}
            {here.length} {here.length === 1 ? 'change' : 'changes'} +{added} −{removed}
          </Text>
        </Box>
        <Box>
          {near.map(t => (
            <Button key={`turn:${t}`} plain dimColor={t !== shown} onPress={() => update($, viewTurn, () => t)}>
              {t === shown ? `[${t}]` : String(t)}{' '}
            </Button>
          ))}
        </Box>
        {here.map(c => (
          <Box key={`change:${c.id}`} flexDirection="column" marginTop={1}>
            <Text bold>
              {c.file} <Text dimColor>{c.tool}{c.note ? `, ${c.note}` : ''} +{c.added} −{c.removed}</Text>
            </Text>
            {c.diff !== '' && <Code format="diff" source={c.diff} path={c.file} wrap="truncate-end" />}
            {c.omitted > 0 && <Text dimColor>… {c.omitted} more {c.omitted === 1 ? 'hunk' : 'hunks'} not kept</Text>}
          </Box>
        ))}
      </Box>
    )
  })
}
