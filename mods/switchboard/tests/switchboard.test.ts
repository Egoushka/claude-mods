import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { ago, bandText, isLive, order, parseRow, rowName, waitingLong } from '../hooks/board'
import type { BoardRow } from '../types'

const NOW = 10_000_000
const row = (over: Partial<BoardRow> = {}): BoardRow => ({ id: 'a', name: 'app', state: 'waiting', since: NOW - 180_000, at: NOW, ...over })

describe('helpers', () => {
  test('a row is read back, junk is refused', () => {
    expect(parseRow(JSON.stringify(row({ context: 41 })))).toEqual(row({ context: 41 }))
    expect(parseRow('not json')).toBeUndefined()
    expect(parseRow(JSON.stringify({ ...row(), state: 'sleeping' }))).toBeUndefined()
    expect(parseRow(JSON.stringify({ id: 'a' }))).toBeUndefined()
  })

  test('a row not refreshed for 90 seconds is gone', () => {
    expect(isLive(row({ at: NOW - 60_000 }), NOW)).toBe(true)
    expect(isLive(row({ at: NOW - 91_000 }), NOW)).toBe(false)
  })

  test('waiting first, then working, then done; oldest first inside a group', () => {
    const rows = [row({ id: 'i', state: 'idle' }), row({ id: 'b', state: 'busy' }), row({ id: 'w2', since: NOW - 10 }), row({ id: 'w1', since: NOW - 999 })]
    expect(order(rows).map(r => r.id)).toEqual(['w1', 'w2', 'b', 'i'])
  })

  test('only sessions that waited long enough count', () => {
    const rows = [row({ id: 'long' }), row({ id: 'short', since: NOW - 5_000 }), row({ id: 'busy', state: 'busy' })]
    expect(waitingLong(rows, NOW, 30).map(r => r.id)).toEqual(['long'])
  })

  test('times read short', () => {
    expect([ago(4_000), ago(180_000), ago(3_600_000), ago(5_400_000), ago(90_000_000)]).toEqual(['4s', '3m', '1h', '1h 30m', '1d'])
  })

  test('the band text fits the room and says how many it left out', () => {
    const many = ['alpha', 'bravo', 'charlie'].map((name, i) => row({ id: String(i), name }))
    expect(bandText(many.slice(0, 1), NOW, 80)).toBe('1 session needs you: alpha 3m')
    expect(bandText(many, NOW, 80)).toBe('3 sessions need you: alpha 3m, bravo 3m, charlie 3m')
    expect(bandText(many, NOW, 45)).toBe('3 sessions need you: alpha 3m +2 more')
    expect(bandText(many, NOW, 10).length).toBeLessThanOrEqual(10)
  })

  test('a session is named by its repo and branch', () => {
    expect(rowName('/home/me/app', 'feat-x')).toBe('app · feat-x')
    expect(rowName('/home/me/app', 'app')).toBe('app')
    expect(rowName('/home/me/app', 'HEAD')).toBe('app')
    expect(rowName('/home/me/app', undefined)).toBe('app')
  })
})

// The world beneath the plugin: an in-memory folder, a clock, one session.
function world(on: On, files: Record<string, string> = {}, branch = 'main') {
  const written: Record<string, string> = {}
  const removed: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/me' })
  mock.store(on)
  on('session.start', ($, e) => e)
  on('command.register', () => ({ value: { command: 'board' } }) as never)
  on('session.id', () => ({ value: 'me-1' }) as never)
  on('session.root', () => ({ value: '/home/me/app' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 12 }, rateLimits: [] } }) as never)
  on('process.run', (_$, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    if (argv[0] === 'rm') removed.push(argv[2] ?? '')
    return { value: { exitCode: 0, stdout: argv[0] === 'git' ? `${branch}\n` : '', stderr: '' } } as never
  })
  on('fs.list', () => ({ value: Object.keys({ ...files, ...written }).map(p => ({ name: p.split('/').pop(), kind: 'file' })) }) as never)
  on('fs.read', (_$, e) => ({ value: written[(e as { path: string }).path] ?? files[(e as { path: string }).path.split('/').pop() ?? ''] ?? '' }) as never)
  on('fs.write', (_$, e) => {
    const w = e as unknown as { path: string; text: string }
    written[w.path.split('/').pop() ?? w.path] = w.text
    return { value: undefined } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  return { clock, written, removed }
}

const start = ($: Parameters<Parameters<typeof test>[1]>[0]) => $.session.start({ cwd: '/home/me/app', surface: 'terminal', isInteractive: true })
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const BAND = { plugin: 'switchboard', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 80 } } as const
const PANE = {
  plugin: 'switchboard',
  component: 'Pane',
  requestId: 'switchboard',
  props: { title: 'Sessions', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

describe('the board', () => {
  test('this session writes its own row on start', async ($, on) => {
    const w = world(on)
    await start($)
    const mine = parseRow(w.written['me-1.json'] ?? '')
    expect(mine).toMatchObject({ id: 'me-1', name: 'app · main', state: 'idle', context: 12 })
  })

  test('the row follows the turn: working, then needs you, then done', async ($, on) => {
    const w = world(on)
    on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
    on('tool.check', () => ({ decision: 'ask' }) as never)
    on('turn.complete', () => ({ text: '' }))
    await start($)
    await $.prompt.submit({ text: 'do it', asUser: true })
    expect(parseRow(w.written['me-1.json'] ?? '')?.state).toBe('busy')
    await $.tool.check({ tool: 'Bash', command: 'make' } as never)
    expect(parseRow(w.written['me-1.json'] ?? '')?.state).toBe('waiting')
    await $.turn.complete({ reason: 'answer' } as never)
    expect(parseRow(w.written['me-1.json'] ?? '')?.state).toBe('idle')
  })

  test('a session that has waited long shows in the band, on every surface', async ($, on) => {
    world(on, { 'other.json': JSON.stringify(row({ id: 'other', name: 'infra · deploy', at: NOW })) })
    await start($)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /1 session needs you: infra · deploy 3m/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the band is silent when nobody waits, or only just started to', async ($, on) => {
    world(on, {
      'busy.json': JSON.stringify(row({ id: 'busy', state: 'busy' })),
      'new.json': JSON.stringify(row({ id: 'new', since: NOW - 5_000 })),
    })
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }) as never)
    await start($)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /needs you/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a stale row is not shown', async ($, on) => {
    world(on, { 'dead.json': JSON.stringify(row({ id: 'dead', at: NOW - 200_000 })) })
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }) as never)
    await start($)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /needs you/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a row older than a day is removed from the folder', async ($, on) => {
    const w = world(on, { 'old.json': JSON.stringify(row({ id: 'old', at: NOW - 25 * 3_600_000 })) })
    await start($)
    expect(w.removed).toContain('/home/me/.claude/switchboard/old.json')
  })

  test('the band is off when switched off', { options: { showBand: false } }, async ($, on) => {
    world(on, { 'other.json': JSON.stringify(row({ id: 'other' })) })
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }) as never)
    await start($)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /needs you/ })).toBeUndefined()
    await ui.unmount()
  })

  test('the pane lists every session, waiting first, on every surface', async ($, on) => {
    world(on, {
      'w.json': JSON.stringify(row({ id: 'w', name: 'infra · deploy' })),
      'b.json': JSON.stringify(row({ id: 'b', name: 'web · fix', state: 'busy', context: 70 })),
    })
    await start($)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /infra · deploy.*needs you/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /web · fix.*working/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /app.*this one/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the pane says so when there is no other session', async ($, on) => {
    world(on)
    await start($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /No other sessions are running/ })).toBeDefined()
    await ui.unmount()
  })

  test('/board opens the pane', async ($, on) => {
    world(on)
    await start($)
    const r = await $.command.run({ command: 'board', args: '' })
    expect(r.text).toContain('opened')
  })

  test('a board seen at the next tick picks up a session that appeared', async ($, on) => {
    const files: Record<string, string> = {}
    const w = world(on, files)
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }) as never)
    await start($)
    files['late.json'] = JSON.stringify(row({ id: 'late', name: 'late one', at: w.clock.now() }))
    await w.clock.advance(15_000)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /late one/ })).toBeDefined()
    await ui.unmount()
  })
})
