import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Phase } from '../types'
import { BUMP, DRAFT_PROMPT, failureNote, rowText, shouldOffer, startPrompt } from './draft'

const phase = atom({ plugin: 'handoff-autopilot', key: 'phase' } as const, { step: 'idle' } as Phase, { shape: 'phase-1' })

type Engine = EngineInterface

// What this session decided so far; a reload starts it over.
const cfg = { atPercent: 60, file: 'docs/HANDOFF.draft.md' }
const seen = { nextAt: 60 }

const set = ($: Engine, next: Phase) => update($, phase, () => next)

async function draft($: Engine): Promise<void> {
  await set($, { step: 'working' })
  const r = await $.model.fork({ prompt: DRAFT_PROMPT }).catch(() => undefined)
  if (!r?.isAnswered) {
    const note = r ? failureNote(r.reason, 'status' in r ? (r.status as number | undefined) : undefined) : 'the request failed'
    await set($, { step: 'failed', note })
    return
  }
  const root = await $.session.root()
  const path = cfg.file.startsWith('/') ? cfg.file : `${root}/${cfg.file}`
  const now = await $.clock.now()
  const usage = await $.session.usage().catch(() => undefined)
  const pct = usage?.context.percent
  const stamp = `<!-- drafted by handoff-autopilot ${new Date(now).toISOString()}${pct === undefined ? '' : `, context ${Math.round(pct)}%`} -->`
  await $.fs.write(path, `${stamp}\n${r.text.trim()}\n`)
  seen.nextAt = Infinity
  await set($, { step: 'ready', file: cfg.file })
}

async function later($: Engine, percent: number | undefined): Promise<void> {
  seen.nextAt = (percent ?? seen.nextAt) + BUMP
  await set($, { step: 'idle' })
}

export const register: Register = (on, options) => {
  cfg.atPercent = typeof options.atPercent === 'number' ? options.atPercent : 60
  cfg.file = typeof options.file === 'string' && options.file.trim() ? options.file.trim() : 'docs/HANDOFF.draft.md'
  seen.nextAt = cfg.atPercent

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'handoff-draft', description: 'Draft a handoff for this session now' })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && cfg.atPercent > 0) {
      const now = await read($, phase)
      if (now.step === 'idle') {
        const usage = await $.session.usage().catch(() => undefined)
        const percent = usage?.context.percent
        if (shouldOffer(percent, seen.nextAt)) await set($, { step: 'offer', percent }).catch(() => undefined)
      }
    }
    return next(e)
  })

  on('command.run', { command: 'handoff-draft' }, async $ => {
    await draft($)
    const now = await read($, phase)
    return { text: now.step === 'ready' ? `Handoff saved to ${now.file}.` : rowText(now) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const now = await read($, phase)
    if (now.step === 'idle') return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const color = now.step === 'ready' ? 'success' : now.step === 'failed' ? 'error' : undefined
    return (
      <Box>
        <Text color={color} dimColor={now.step === 'working'}>{rowText(now)} </Text>
        {now.step === 'offer' && <Button key="draft" label="Draft" onPress={() => draft($)} />}
        {now.step === 'offer' && <Button key="later" label="Not now" onPress={() => later($, now.percent)} />}
        {now.step === 'ready' && <Button key="copy" label="Copy start prompt" onPress={press => $.ui.copy({ text: startPrompt(now.file ?? cfg.file), surface: press.surface })} />}
        {now.step === 'ready' && <Button key="done" label="Done" onPress={() => set($, { step: 'idle' })} />}
        {now.step === 'failed' && <Button key="again" label="Try again" onPress={() => draft($)} />}
        {now.step === 'failed' && <Button key="drop" label="Dismiss" onPress={() => later($, undefined)} />}
      </Box>
    )
  })
}
