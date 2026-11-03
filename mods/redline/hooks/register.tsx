import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Red } from '../types'
import { failingChecks, fixPrompt, healthVerdict, isRed, parseArgv, rowText, signature } from './lib'

const red = atom({ plugin: 'redline', key: 'red' } as const, {} as Red, { shape: 'red-1' })
// The signature of the state the person hid; the row returns when the state changes.
const hide = atom({ plugin: 'redline', key: 'hide' } as const, '', { shape: 'hide-1' })

type Engine = EngineInterface

// Set from the settings at register.
const cfg = { watchCi: true, argv: undefined as string[] | undefined, okPattern: '', label: 'Health', everyMs: 120_000 }

async function checkCi($: Engine): Promise<string[]> {
  const r = await $.process.run(['gh', 'pr', 'checks', '--json', 'name,state'], { cwd: await $.session.root(), timeoutMs: 20_000 }).catch(() => undefined)
  // gh exits non-zero while checks are pending or failing, but still prints the JSON.
  return r ? failingChecks(r.stdout) : []
}

async function checkHealth($: Engine, before: string | undefined): Promise<string | undefined> {
  if (!cfg.argv) return undefined
  const r = await $.process.run(cfg.argv, { timeoutMs: 30_000 }).catch(() => undefined)
  if (!r) return before
  const v = healthVerdict(r.exitCode, r.stdout || r.stderr, cfg.okPattern)
  if (v.kind === 'unknown') return before
  return v.kind === 'red' ? v.line : undefined
}

async function tick($: Engine): Promise<void> {
  const was = await read($, red)
  const next: Red = {}
  const health = await checkHealth($, was.health)
  if (health !== undefined) next.health = health
  const ci = cfg.watchCi ? await checkCi($) : []
  if (ci.length > 0) next.ci = ci
  if (signature(next) !== signature(was)) await update($, red, () => next)
  if (!isRed(next)) await update($, hide, () => '')
}

export const register: Register = (on, options) => {
  cfg.watchCi = options.watchCi !== false
  cfg.argv = parseArgv(typeof options.healthCommand === 'string' ? options.healthCommand : '')
  cfg.okPattern = typeof options.healthOkPattern === 'string' ? options.healthOkPattern.trim() : ''
  cfg.label = typeof options.healthLabel === 'string' && options.healthLabel.trim() ? options.healthLabel.trim() : 'Health'
  cfg.everyMs = Math.max(30, typeof options.everySeconds === 'number' ? options.everySeconds : 120) * 1000

  on('session.start', async ($, e, next) => {
    if (cfg.watchCi || cfg.argv) {
      await tick($).catch(() => undefined)
      void $.clock.every(cfg.everyMs, () => tick($).catch(() => undefined))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const now = await read($, red)
    if (!isRed(now) || signature(now) === (await read($, hide))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text color="error">{rowText(now, cfg.label, Math.max(20, e.props.bodyColumns - 18))} </Text>
        <Button key="fix" label="Fix" onPress={() => $.prompt.fill({ text: fixPrompt(now, cfg.label) })} />
        <Button key="hide" label="Hide" onPress={() => update($, hide, () => signature(now))} />
      </Box>
    )
  })
}
