import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { failingChecks, fixPrompt, healthVerdict, parseArgv, rowText, signature } from '../hooks/lib'

describe('helpers', () => {
  test('only failed checks count; pending and passed do not', () => {
    const out = JSON.stringify([
      { name: 'build', state: 'SUCCESS' },
      { name: 'lint', state: 'FAILURE' },
      { name: 'e2e', state: 'PENDING' },
      { name: 'unit', state: 'TIMED_OUT' },
    ])
    expect(failingChecks(out)).toEqual(['lint', 'unit'])
    expect(failingChecks('no pull requests found')).toEqual([])
    expect(failingChecks('{}')).toEqual([])
  })

  test('health by exit code', () => {
    expect(healthVerdict(0, 'fine', '')).toEqual({ kind: 'ok' })
    expect(healthVerdict(2, 'a\nweb unhealthy\n', '')).toEqual({ kind: 'red', line: 'web unhealthy' })
    expect(healthVerdict(2, '', '')).toEqual({ kind: 'red', line: 'exit 2' })
  })

  test('health by pattern: a command that cannot run stays silent', () => {
    expect(healthVerdict(0, 'x\nneeds a look: nothing', 'needs a look: nothing$')).toEqual({ kind: 'ok' })
    expect(healthVerdict(0, 'x\nneeds a look: web (unhealthy)', 'needs a look: nothing$')).toEqual({ kind: 'red', line: 'needs a look: web (unhealthy)' })
    expect(healthVerdict(255, 'Permission denied', 'needs a look: nothing$')).toEqual({ kind: 'unknown' })
    expect(healthVerdict(0, 'x', '(')).toEqual({ kind: 'unknown' })
  })

  test('the command setting is a JSON argv or nothing', () => {
    expect(parseArgv('["lab","status"]')).toEqual(['lab', 'status'])
    expect(parseArgv('lab status')).toBeUndefined()
    expect(parseArgv('')).toBeUndefined()
    expect(parseArgv('[1]')).toBeUndefined()
  })

  test('one row reads health first, then CI, and fits the room', () => {
    expect(rowText({ health: 'web unhealthy', ci: ['lint'] }, 'Homelab', 80)).toBe('Homelab: web unhealthy · CI failing: lint')
    expect(rowText({ ci: ['lint', 'unit', 'e2e'] }, 'x', 80)).toBe('CI failing: lint +2 more')
    expect(rowText({ health: 'a very long line indeed' }, 'Homelab', 12).length).toBeLessThanOrEqual(12)
  })

  test('the fix prompt names what is red', () => {
    const p = fixPrompt({ health: 'web unhealthy', ci: ['lint'] }, 'Homelab')
    expect(p).toContain('homelab check is red: "web unhealthy"')
    expect(p).toContain('CI is failing on this branch\'s PR (lint)')
  })

  test('the signature changes when what is red changes', () => {
    expect(signature({ ci: ['a'] })).not.toBe(signature({ ci: ['a', 'b'] }))
    expect(signature({})).toBe(signature({ ci: [] }))
  })
})

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const BAND = { plugin: 'redline', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 80 } } as const
const GREEN = JSON.stringify([{ name: 'build', state: 'SUCCESS' }])
const RED = JSON.stringify([{ name: 'lint', state: 'FAILURE' }, { name: 'build', state: 'SUCCESS' }])

function world(on: On, answers: { gh: () => string; health?: () => { exitCode: number; stdout: string } }) {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const filled: string[] = []
  const ran: string[][] = []
  mock.store(on)
  on('session.start', ($, e) => e)
  on('session.root', () => ({ value: '/home/me/app' }) as never)
  on('process.run', (_$, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    ran.push(argv)
    if (argv[0] === 'gh') return { value: { exitCode: 1, stdout: answers.gh(), stderr: '' } } as never
    const h = answers.health?.() ?? { exitCode: 0, stdout: '' }
    return { value: { ...h, stderr: '' } } as never
  })
  on('prompt.fill', (_$, e) => {
    filled.push((e as unknown as { text: string }).text)
    return { isFilled: true } as never
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }) as never)
  return { clock, filled, ran }
}

const start = ($: Parameters<Parameters<typeof test>[1]>[0]) => $.session.start({ cwd: '/home/me/app', surface: 'terminal', isInteractive: true })

describe('the row', () => {
  test('is silent while everything is green', async ($, on) => {
    world(on, { gh: () => GREEN })
    await start($)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /failing|red/i })).toBeUndefined()
    await ui.unmount()
  })

  test('appears for a failing check on every surface', async ($, on) => {
    world(on, { gh: () => RED })
    await start($)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /CI failing: lint/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('watching CI can be switched off', { options: { watchCi: false } }, async ($, on) => {
    const w = world(on, { gh: () => RED })
    await start($)
    expect(w.ran.some(a => a[0] === 'gh')).toBe(false)
  })

  test('a configured health command shows its last line when it is not ok', {
    options: { watchCi: false, healthCommand: '["my-status"]', healthOkPattern: 'all good$', healthLabel: 'Box' },
  }, async ($, on) => {
    world(on, { gh: () => GREEN, health: () => ({ exitCode: 0, stdout: 'summary\nneeds a look: web' }) })
    await start($)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Box: needs a look: web/ })).toBeDefined()
    await ui.unmount()
  })

  test('Fix puts the prompt in the box, it does not send it', async ($, on) => {
    const w = world(on, { gh: () => RED })
    await start($)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'fix' })
    expect(w.filled).toHaveLength(1)
    expect(w.filled[0]).toContain('lint')
    await ui.unmount()
  })

  test('Hide removes the row until what is red changes, and it clears when green', async ($, on) => {
    let out = RED
    const w = world(on, { gh: () => out })
    await start($)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'hide' })
    expect(await ui.find({ type: 'Text', text: /CI failing/ })).toBeUndefined()
    await w.clock.advance(120_000)
    expect(await ui.find({ type: 'Text', text: /CI failing/ })).toBeUndefined()
    out = JSON.stringify([{ name: 'lint', state: 'FAILURE' }, { name: 'unit', state: 'FAILURE' }])
    await w.clock.advance(120_000)
    expect(await ui.find({ type: 'Text', text: /CI failing: lint \+1 more/ })).toBeDefined()
    out = GREEN
    await w.clock.advance(120_000)
    expect(await ui.find({ type: 'Text', text: /CI failing/ })).toBeUndefined()
    out = RED
    await w.clock.advance(120_000)
    expect(await ui.find({ type: 'Text', text: /CI failing: lint/ })).toBeDefined()
    await ui.unmount()
  })

  test('a health command that cannot run keeps the last answer instead of flashing', {
    options: { watchCi: false, healthCommand: '["my-status"]', healthOkPattern: 'all good$' },
  }, async ($, on) => {
    let h = { exitCode: 0, stdout: 'needs a look: web' }
    const w = world(on, { gh: () => GREEN, health: () => h })
    await start($)
    h = { exitCode: 255, stdout: 'Permission denied' }
    await w.clock.advance(120_000)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Health: needs a look: web/ })).toBeDefined()
    await ui.unmount()
  })
})
