import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { keepWarned, money, newlyOver, parseSpender, resetsIn, toastText, topSpenders, windowName } from '../hooks/lib'

const NOW = Date.parse('2026-11-03T10:00:00Z')
const at = (mins: number) => new Date(NOW + mins * 60_000).toISOString()

describe('helpers', () => {
  test('windows are named in plain words', () => {
    expect([windowName('five_hour'), windowName('seven_day'), windowName('spend_limit'), windowName('some_new_kind')]).toEqual([
      '5-hour limit',
      'weekly limit',
      'spend limit',
      'some new kind',
    ])
  })

  test('a window warns once per reset, and again after it resets', () => {
    const l = { kind: 'five_hour', percentUsed: 82, resetsAt: at(80) }
    expect(newlyOver([l], 80, [])).toEqual([l])
    expect(newlyOver([{ ...l, percentUsed: 79.9 }], 80, [])).toEqual([])
    expect(newlyOver([l], 80, [`five_hour@${at(80)}`])).toEqual([])
    expect(newlyOver([{ ...l, resetsAt: at(380) }], 80, [`five_hour@${at(80)}`])).toHaveLength(1)
  })

  test('old warnings are dropped once their window is gone', () => {
    expect(keepWarned([`five_hour@${at(80)}`, 'seven_day@old'], [{ kind: 'five_hour', percentUsed: 5, resetsAt: at(80) }])).toEqual([`five_hour@${at(80)}`])
  })

  test('the reset reads short', () => {
    expect([resetsIn(at(0.4), NOW), resetsIn(at(45), NOW), resetsIn(at(60), NOW), resetsIn(at(80), NOW), resetsIn(at(60 * 72), NOW), resetsIn(at(-5), NOW), resetsIn(undefined, NOW)]).toEqual([
      '1m',
      '45m',
      '1h',
      '1h 20m',
      '3d',
      undefined,
      undefined,
    ])
  })

  test('a spender file is read back, junk is refused', () => {
    expect(parseSpender(JSON.stringify({ id: 'a', name: 'app', usd: 1.5, at: NOW }))).toEqual({ id: 'a', name: 'app', usd: 1.5, at: NOW })
    expect(parseSpender('nope')).toBeUndefined()
    expect(parseSpender(JSON.stringify({ id: 'a' }))).toBeUndefined()
  })

  test('the top spenders are live, non-zero, biggest first', () => {
    const rows = [
      { id: 'a', name: 'a', usd: 1, at: NOW },
      { id: 'b', name: 'b', usd: 9, at: NOW },
      { id: 'dead', name: 'dead', usd: 99, at: NOW - 3_600_000 },
      { id: 'zero', name: 'zero', usd: 0, at: NOW },
      { id: 'c', name: 'c', usd: 4, at: NOW },
    ]
    expect(topSpenders(rows, NOW, 2).map(r => r.id)).toEqual(['b', 'c'])
  })

  test('the toast says the window, the reset and who spent', () => {
    const over = [{ kind: 'five_hour', percentUsed: 82.4, resetsAt: at(80) }]
    expect(toastText(over, NOW, [], 'me')).toBe('Usage: 5-hour limit 82% used, resets in 1h 20m.')
    expect(toastText(over, NOW, [{ id: 'me', name: 'app', usd: 4.2, at: NOW }, { id: 'x', name: 'infra', usd: 1, at: NOW }], 'me')).toBe(
      'Usage: 5-hour limit 82% used, resets in 1h 20m. Spent so far: app $4.20 (this one), infra $1.00.',
    )
    expect(money(0.5)).toBe('$0.50')
  })
})

type Limits = { kind: string; percentUsed: number; resetsAt?: string }[]
const measure = (rateLimits: Limits, usd = 2) => ({ context: { window: 200000 }, rateLimits, cost: { usd }, changed: ['rateLimits'] }) as never

function world(on: On, files: Record<string, string> = {}) {
  const toasts: string[] = []
  const written: Record<string, string> = {}
  const removed: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/me' })
  mock.store(on)
  on('session.start', ($, e) => e)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.end', (_$, e) => ({ sessionId: 'me-1' }) as never)
  on('session.id', () => ({ value: 'me-1' }) as never)
  on('session.root', () => ({ value: '/home/me/app' }) as never)
  on('ui.toast', (_$, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined } as never
  })
  on('process.run', (_$, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    if (argv[0] === 'rm') removed.push(argv[2] ?? '')
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('fs.list', () => ({ value: Object.keys({ ...files, ...written }).map(p => ({ name: p, kind: 'file' })) }) as never)
  on('fs.read', (_$, e) => ({ value: written[(e as { path: string }).path.split('/').pop() ?? ''] ?? files[(e as { path: string }).path.split('/').pop() ?? ''] ?? '' }) as never)
  on('fs.write', (_$, e) => {
    const w = e as unknown as { path: string; text: string }
    written[w.path.split('/').pop() ?? w.path] = w.text
    return { value: undefined } as never
  })
  return { toasts, written, removed, clock }
}

const start = ($: Parameters<Parameters<typeof test>[1]>[0]) => $.session.start({ cwd: '/home/me/app', surface: 'terminal', isInteractive: true })
const FIVE = (p: number) => ({ kind: 'five_hour', percentUsed: p, resetsAt: at(80) })

describe('the toast', () => {
  test('stays quiet below the line', async ($, on) => {
    const w = world(on)
    await start($)
    await $.session.measure(measure([FIVE(60), { kind: 'seven_day', percentUsed: 30, resetsAt: at(5000) }]))
    expect(w.toasts).toEqual([])
  })

  test('fires once when a window passes 80%, not again while it stays over', async ($, on) => {
    const w = world(on)
    await start($)
    await $.session.measure(measure([FIVE(81)]))
    await $.session.measure(measure([FIVE(83)]))
    await $.session.measure(measure([FIVE(95)]))
    expect(w.toasts).toHaveLength(1)
    expect(w.toasts[0]).toContain('5-hour limit 81% used, resets in 1h 20m')
  })

  test('fires again after the window resets', async ($, on) => {
    const w = world(on)
    await start($)
    await $.session.measure(measure([FIVE(85)]))
    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 2, resetsAt: at(380) }]))
    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 81, resetsAt: at(380) }]))
    expect(w.toasts).toHaveLength(2)
  })

  test('both windows over at once make one toast', async ($, on) => {
    const w = world(on)
    await start($)
    await $.session.measure(measure([FIVE(90), { kind: 'seven_day', percentUsed: 88, resetsAt: at(5000) }]))
    expect(w.toasts).toHaveLength(1)
    expect(w.toasts[0]).toMatch(/5-hour limit 90% used.*weekly limit 88% used/)
  })

  test('names the sessions that spent the most, this one marked', async ($, on) => {
    const other = JSON.stringify({ id: 'x', name: 'infra', usd: 12.5, at: NOW })
    const w = world(on, { 'x.json': other })
    await start($)
    await $.session.measure(measure([FIVE(90)], 3))
    expect(w.toasts[0]).toContain('Spent so far: infra $12.50, app $3.00 (this one).')
  })

  test('a session closed long ago is not named', async ($, on) => {
    const w = world(on, { 'old.json': JSON.stringify({ id: 'old', name: 'gone', usd: 50, at: NOW - 3_600_000 }) })
    await start($)
    await $.session.measure(measure([FIVE(90)], 3))
    expect(w.toasts[0]).not.toContain('gone')
  })

  test('the threshold is a setting', { options: { percent: 50 } }, async ($, on) => {
    const w = world(on)
    await start($)
    await $.session.measure(measure([FIVE(55)]))
    expect(w.toasts).toHaveLength(1)
  })

  test('with sharing off it writes nothing and names only this session', { options: { share: false } }, async ($, on) => {
    const w = world(on, { 'x.json': JSON.stringify({ id: 'x', name: 'infra', usd: 12.5, at: NOW }) })
    await start($)
    await $.session.measure(measure([FIVE(90)], 3))
    expect(w.written).toEqual({})
    expect(w.toasts[0]).toContain('app $3.00 (this one)')
    expect(w.toasts[0]).not.toContain('infra')
  })

  test('writes its cost at most every 30 seconds, and removes the file on exit', async ($, on) => {
    const w = world(on)
    await start($)
    await $.session.measure(measure([], 1))
    expect(JSON.parse(w.written['me-1.json'] ?? '{}')).toMatchObject({ id: 'me-1', name: 'app', usd: 1 })
    await $.session.measure(measure([], 2))
    expect(JSON.parse(w.written['me-1.json'] ?? '{}').usd).toBe(1)
    await w.clock.advance(31_000)
    await $.session.measure(measure([], 3))
    expect(JSON.parse(w.written['me-1.json'] ?? '{}').usd).toBe(3)
    await $.session.end({ reason: 'exit' } as never)
    expect(w.removed).toContain('/home/me/.claude/ratewatch/me-1.json')
  })
})
