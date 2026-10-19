import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Spawn, SpawnKind } from '../types'

const spawns = atom({ plugin: 'arcade', key: 'spawns' } as const, [] as Spawn[])
const round = atom({ plugin: 'arcade', key: 'round' } as const, 0)
const isOpen = atom({ plugin: 'arcade', key: 'isOpen' } as const, true)
const best = atom({ plugin: 'arcade', key: 'best' } as const, 0)
const score = atom({ plugin: 'arcade', key: 'score' } as const, 0)

// Read-only tools drop a coin, tools that change files a gold coin, the shell and every failed call a hazard.
const GOLD = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const HAZARD = new Set(['Bash', 'PowerShell'])
const kindFor = (tool: string): SpawnKind => (GOLD.has(tool) ? 'g' : HAZARD.has(tool) ? 'h' : 'c')

// Ids count up for the whole session, so the game can tell a spawn it has seen from a new one.
async function drop($: EngineInterface, ...kinds: SpawnKind[]) {
  await update($, spawns, list => {
    let id = list[list.length - 1]?.id ?? 0
    return [...list, ...kinds.map(k => ({ id: (id += 1), k }))].slice(-24)
  })
}

async function newRound($: EngineInterface) {
  await update($, round, n => n + 1)
  await update($, score, () => 0)
}

export const register: Register = (on, options) => {
  if (options.enabled === false) return
  const startCollapsed = options.startCollapsed === true
  let ambient: Timer | undefined

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('best')
    await update($, best, () => (typeof stored === 'number' ? stored : 0))
    await update($, isOpen, () => !startCollapsed)
    return next(e)
  })

  // A turn is a round; between tool calls a coin drifts in now and then so the game does not stall while Claude thinks.
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      ambient?.cancel()
      await newRound($)
      ambient = $.clock.every(3500, () => void drop($, 'c'))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      ambient?.cancel()
      ambient = undefined
      const points = await read($, score)
      if (points > 0) $.ui.toast(`arcade: ${points} pts, best ${await read($, best)}`)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    await drop($, kindFor(String(e.tool)))
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError) await drop($, 'h', 'h')
    return ran
  })

  // The game posts its score as it changes; the best one is kept between sessions.
  on('ui.message', async ($, e, next) => {
    const data = e.data as { score?: unknown } | null
    if (e.element === 'arcade' && typeof data?.score === 'number' && Number.isFinite(data.score)) {
      const points = Math.max(0, Math.floor(data.score))
      await update($, score, () => points)
      if (points > (await read($, best))) {
        await update($, best, () => points)
        await $.store.set('best', points)
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    // The game needs eight rows; a short band, a survey or an idle session gets nothing of it.
    if (e.props.hasSurvey || !e.props.isWorking || e.props.maxRows < 9) return rest
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return rest

    const { Box, Text, Button, Client } = $.ui.resolve(e)
    const open = await read($, isOpen)
    const props = { spawns: await read($, spawns), round: await read($, round), best: await read($, best) }
    const mine = (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>arcade · tool calls feed it · ←/→ or the mouse · </Text>
          <Button key="toggle" plain label={open ? 'hide' : 'play'} onPress={() => update($, isOpen, o => !o)} />
        </Box>
        {open && <Client key="arcade" module="./game.tsx" width={24} props={props} />}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {mine}
        {rest}
      </Box>
    )
  })
}
