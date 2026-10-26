import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  base64,
  fillTemplate,
  levels,
  parseChecks,
  parseGauges,
  parseGitStatus,
  parseIdleSeconds,
  parseIdleText,
  pickValue,
  textSparkline,
  toNumber,
} from '../hooks/lib'

describe('gauge config', () => {
  test('parses the three kinds, clamps every and reports bad entries', () => {
    const r = parseGauges(
      JSON.stringify([
        { label: 'Queue', kind: 'mcp', server: 'ops', tool: 'depth', args: { q: 'main' }, every: 1, pick: 'data.count' },
        { label: 'Load', kind: 'command', argv: ['uptime'] },
        { label: 'Up', kind: 'http', url: 'https://example.com/health', every: 30 },
        { label: 'No tool', kind: 'mcp', server: 'ops' },
        { kind: 'http', url: 'https://x' },
        { label: 'Bad url', kind: 'http', url: 'file:///etc/passwd' },
      ]),
    )
    expect(r.gauges.map(g => g.label)).toEqual(['Queue', 'Load', 'Up'])
    expect(r.gauges[0]?.every).toBe(5)
    expect(r.gauges[1]?.every).toBe(60)
    expect(r.errors.length).toBe(3)
    expect(parseGauges('').gauges).toEqual([])
    expect(parseGauges('{').errors).toEqual(['gauges: not valid JSON'])
  })
})

describe('extraction', () => {
  test('dotted path, array index and regex', () => {
    const json = '{"data":{"items":[{"n":7},{"n":9}],"ok":true}}'
    expect(pickValue(json, 'data.items.1.n')).toBe('9')
    expect(pickValue(json, 'data.ok')).toBe('true')
    expect(pickValue(json, 'data.missing')).toBeUndefined()
    expect(pickValue('load average: 1.52, 1.1', '/average: ([\\d.]+)/')).toBe('1.52')
    expect(pickValue('abc', '/b/')).toBe('b')
    expect(pickValue('\n  first\nsecond', undefined)).toBe('first')
  })

  test('strict numbers', () => {
    expect(toNumber('42')).toBe(42)
    expect(toNumber(' 12.5% ')).toBe(12.5)
    expect(toNumber('1,200')).toBe(1200)
    expect(toNumber('v2 ok')).toBeUndefined()
  })
})

describe('drawing math', () => {
  test('levels scale to the series and a flat series stays low', () => {
    expect(levels([1, 2, 3, 4, 5, 6, 7, 8], 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(levels([5, 5, 5], 8)).toEqual([0, 0, 0])
    expect(textSparkline([0, 10], 5)).toBe('▁█')
  })

  test('base64 matches the known encodings', () => {
    const enc = (s: string) => base64(new TextEncoder().encode(s))
    expect(enc('')).toBe('')
    expect(enc('f')).toBe('Zg==')
    expect(enc('fo')).toBe('Zm8=')
    expect(enc('foo')).toBe('Zm9v')
  })
})

describe('parsers', () => {
  test('git status', () => {
    expect(parseGitStatus('## main...origin/main [ahead 1]\n M a.ts\n?? b.ts\n')).toEqual({ branch: 'main', dirty: 2 })
    expect(parseGitStatus('## HEAD (no branch)\n')).toEqual({ branch: 'detached', dirty: 0 })
    expect(parseGitStatus('## No commits yet on trunk\n')).toEqual({ branch: 'trunk', dirty: 0 })
  })

  test('pr checks', () => {
    const out = JSON.stringify([
      { name: 'a', state: 'SUCCESS' },
      { name: 'b', state: 'FAILURE' },
      { name: 'c', state: 'PENDING' },
      { name: 'd', state: 'SKIPPED' },
    ])
    expect(parseChecks(out)).toEqual({ text: '1✓ 1✗ 1… 1 skipped', failing: 1, pending: 1, total: 4 })
    expect(parseChecks('[]')).toBeUndefined()
    expect(parseChecks('no pull requests found')).toBeUndefined()
  })

  test('idle time', () => {
    expect(parseIdleSeconds('| |   "HIDIdleTime" = 3500000000\n')).toBe(3)
    expect(parseIdleSeconds('nothing')).toBeUndefined()
    expect(parseIdleText('420')).toBe(420)
    expect(parseIdleText('{"idle": 12.5}')).toBe(12.5)
  })

  test('template fills every string, quotes and all', () => {
    expect(fillTemplate({ chat: 1, body: ['{{text}}', { t: 'x {{text}}' }] }, 'say "hi"')).toEqual({ chat: 1, body: ['say "hi"', { t: 'x say "hi"' }] })
  })
})

// What the engine answers beneath the plugin in a session.
function engine(on: On, idleNs = 0, hasClock = false) {
  on('session.start', ($, e) => e)
  on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200000, tokens: 50000, percent: 25 }, cost: { usd: 1.5 } } }) as never)
  if (!hasClock) {
    on('clock.every', () => ({ value: undefined }) as never)
    on('clock.now', () => ({ value: 1000 }) as never)
  }
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('process.run', (_$, e) => {
    const cmd = e.argv[0]
    if (cmd === 'ioreg') return { value: { exitCode: 0, stdout: `"HIDIdleTime" = ${idleNs}`, stderr: '' } } as never
    if (cmd === 'git') return { value: { exitCode: 0, stdout: '## feature/x\n M a.ts\n', stderr: '' } } as never
    if (cmd === 'echo') return { value: { exitCode: 0, stdout: '17', stderr: '' } } as never
    return { value: { exitCode: 1, stdout: '', stderr: 'not here' } } as never
  })
}

const PANE = { title: 'Cockpit', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: {}, view: {} } as never
const GAUGES = JSON.stringify([{ label: 'Answer', kind: 'command', argv: ['echo', '17'], every: 60 }])

describe('hooks', () => {
  test('the pane shows built-in and custom gauges on terminal and desktop', { options: { gauges: GAUGES } }, async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })
    await $.command.run({ command: 'cockpit', args: '' } as never)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', props: PANE, requestId: 'cockpit' })
      expect(await ui.find({ type: 'Text', text: /feature\/x · 1 changed/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /17/ })).toBeDefined()
      expect(await ui.find({ key: 'refresh-g0' })).toBeDefined()
      // Two readings of the same number: a Raster on the terminal, block characters elsewhere.
      if (surface === 'terminal') expect(await ui.find({ key: 'spark-g0' })).toBeDefined()
      else expect(await ui.find({ type: 'Text', text: /▁▁/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the inbox keeps a message and, when quiet, consumes it', { options: { quietInbox: true } }, async ($, on) => {
    engine(on)
    on('session.receive', (_$, e) => ({ text: e.text }) as never)
    await $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })
    const peer = await $.session.receive({ origin: { kind: 'peer' }, text: 'build is green' } as never)
    expect(JSON.stringify(peer)).toContain('consumed')
    const own = await $.session.receive({ origin: { kind: 'bridge' }, text: 'typed on the phone' } as never)
    expect(JSON.stringify(own)).not.toContain('consumed')
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'cockpit' })
    expect(await ui.find({ type: 'Text', text: /build is green/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /typed on the phone/ })).toBeUndefined()
  })

  test('an idle person gets a notification after a turn', async ($, on) => {
    const clock = mock.clock(on)
    engine(on, 10 * 60 * 1e9, true)
    on('turn.complete', (_$, e) => ({ text: e.answer }) as never)
    const sent: string[] = []
    on('ui.notify', (_$, e) => (sent.push(e.text), { value: { isSent: true, channel: 'kitty' } }) as never)
    await $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })
    await $.turn.complete({ answer: 'Fixed the bug in parser.ts and added a test.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await clock.settle()
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('Fixed the bug')
  })

  test('a present person gets nothing', async ($, on) => {
    const clock = mock.clock(on)
    engine(on, 2 * 1e9, true)
    on('turn.complete', (_$, e) => ({ text: e.answer }) as never)
    const sent: string[] = []
    on('ui.notify', (_$, e) => (sent.push(e.text), { value: { isSent: true, channel: 'kitty' } }) as never)
    await $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })
    await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId: 't2', reason: 'answer' } as never)
    await clock.settle()
    expect(sent.length).toBe(0)
  })

  test('a gauge that hangs is not asked again until it answers', { options: { gauges: JSON.stringify([{ label: 'Slow', kind: 'mcp', server: 'ops', tool: 'depth', every: 5 }]) } }, async ($, on) => {
    const clock = mock.clock(on)
    engine(on, 0, true)
    let calls = 0
    let release: () => void = () => undefined
    const hang = new Promise<void>(resolve => (release = resolve))
    on('mcp.call', async () => {
      calls += 1
      await hang
      return { value: { content: [{ type: 'text', text: '3' }] } } as never
    })
    await $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })
    await $.command.run({ command: 'cockpit', args: '' } as never)
    await $.command.run({ command: 'cockpit', args: '' } as never)
    expect(calls).toBe(1)
    release()
    await clock.settle()
    await $.command.run({ command: 'cockpit', args: '' } as never)
    expect(calls).toBe(2)
  })

  test('a gauge whose source is down is asked less and less often until it answers', { options: { gauges: JSON.stringify([{ label: 'Down', kind: 'mcp', server: 'ops', tool: 'depth', every: 5 }]) } }, async ($, on) => {
    const clock = mock.clock(on)
    engine(on, 0, true)
    let calls = 0
    let isUp = false
    on('mcp.call', () => {
      calls += 1
      return (isUp ? { value: { content: [{ type: 'text', text: '3' }] } } : { value: { isError: true, content: [{ type: 'text', text: 'Server homelab unavailable' }] } }) as never
    })
    await $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })
    await clock.settle()
    expect(calls).toBe(1)
    for (let i = 0; i < 12; i += 1) await clock.advance(5000)
    expect(calls).toBe(3)
    isUp = true
    await $.command.run({ command: 'cockpit', args: '' } as never)
    expect(calls).toBe(4)
    await clock.advance(5000)
    expect(calls).toBe(5)
  })
})
