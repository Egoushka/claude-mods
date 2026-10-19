import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { checkPath, checkProposal, expandDir } from '../hooks/proposal'
import { describeSequence, findRepeat, normalizeCall } from '../hooks/repeats'

const MANIFEST = JSON.stringify({ name: 'tidy', version: '0.1.0', description: 'x' })
const GOOD = {
  name: 'tidy',
  purpose: 'Trim trailing whitespace in edited files.',
  files: {
    '.claude-plugin/plugin.json': MANIFEST,
    'hooks/hooks.json': '{ "modules": ["./register.tsx"] }',
    'hooks/register.tsx': 'export const register = () => {}',
  },
}

describe('proposal checks', () => {
  test('accepts a well-formed proposal', () => {
    const r = checkProposal(GOOD)
    expect(r.ok).toBe(true)
  })

  test('refuses bad names', () => {
    for (const name of ['Tidy', 'a b', '../x', '', '-x', 'x'.repeat(41), 7]) expect(checkProposal({ ...GOOD, name }).ok).toBe(false)
  })

  test('refuses unsafe or odd paths', () => {
    for (const p of ['/etc/x.ts', '../x.ts', 'a/../b.ts', 'a//b.ts', './a.ts', 'a\\b.ts', 'run.sh', 'a.js', 'x.ts/', '.git/config.json', 'node_modules/x.ts', '.env.json', 'sp ace.ts'])
      expect(checkPath(p)).toBeDefined()
    for (const p of ['hooks/register.tsx', 'types/index.d.ts', '.claude-plugin/plugin.json', 'README.md']) expect(checkPath(p)).toBeUndefined()
  })

  test('refuses a proposal without a matching manifest, with broken JSON, or too large', () => {
    const { '.claude-plugin/plugin.json': _drop, ...noManifest } = GOOD.files
    expect(checkProposal({ ...GOOD, files: noManifest }).ok).toBe(false)
    expect(checkProposal({ ...GOOD, name: 'other' }).ok).toBe(false)
    expect(checkProposal({ ...GOOD, files: { ...GOOD.files, 'hooks/hooks.json': '{nope' } }).ok).toBe(false)
    expect(checkProposal({ ...GOOD, files: { ...GOOD.files, 'hooks/register.tsx': 'x'.repeat(120_001) } }).ok).toBe(false)
    expect(checkProposal({ ...GOOD, files: { ...GOOD.files, 'Hooks/a.ts': '', 'hooks/A.ts': '' } }).ok).toBe(false)
    expect(checkProposal({ ...GOOD, files: {} }).ok).toBe(false)
    expect(checkProposal({ ...GOOD, purpose: '  ' }).ok).toBe(false)
  })

  test('expands the folder template', () => {
    expect(expandDir('~/.claude/forged-mods/<name>/', 'tidy', '/home/me')).toBe('/home/me/.claude/forged-mods/tidy')
    expect(expandDir('/srv/mods', 'tidy', undefined)).toBe('/srv/mods/tidy')
    expect(expandDir('~/mods', 'tidy', undefined)).toBeUndefined()
    expect(expandDir('relative/<name>', 'tidy', '/home/me')).toBeUndefined()
    expect(expandDir('/a/../b/<name>', 'tidy', '/home/me')).toBeUndefined()
  })
})

describe('repetition', () => {
  test('normalizes shell commands and drops ordinary tools', () => {
    expect(normalizeCall('Bash', { command: 'cd /repo && git log -n 5 "msg here" abc1234def' })).toBe('git log -n # "…" <sha>')
    expect(normalizeCall('Bash', { command: 'npm test -- src/a/b.ts' })).toBe('npm test -- <path>')
    expect(normalizeCall('mcp__x__y', {})).toBe('mcp__x__y')
    expect(normalizeCall('Edit', {})).toBeUndefined()
    expect(normalizeCall('mcp__forge__forge', {})).toBeUndefined()
  })

  test('finds a sequence that ran three times, the longest first, once', () => {
    const cycle = ['git status', 'git diff', 'npm test', 'git add']
    const history = [...cycle, 'ls', ...cycle, ...cycle]
    const found = findRepeat(history, [])
    expect(found).toEqual(cycle)
    expect(findRepeat(history, [cycle])).toBeUndefined()
    expect(findRepeat([...cycle, ...cycle], [])).toBeUndefined()
    expect(findRepeat(['a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a'], [])).toBeUndefined()
    expect(describeSequence(['git status', 'mcp__x__y'])).toBe('git status → mcp__x__y')
  })
})

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0 }, view: {} } as never
const PANE = { title: 'forge', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0 }, view: {} } as never

type Fake = { written: Record<string, string>; validated: string[]; existing: Set<string>; opened: Promise<void> }

// What the engine answers beneath the plugin.
function engine(on: On): Fake {
  const fake: Fake = { written: {}, validated: [], existing: new Set(), opened: Promise.resolve() }
  let opened = () => {}
  fake.opened = new Promise<void>(resolve => (opened = resolve))
  const value = (v: unknown) => ({ value: v }) as never
  on('session.start', ($, e) => e)
  on('tool.register', () => value({ tool: 'mcp__forge__forge' }))
  on('command.register', () => value({ command: 'x' }))
  on('env.get', () => value('/home/me'))
  on('fs.exists', (_$, e) => value(fake.existing.has((e as unknown as { path: string }).path)))
  on('fs.write', (_$, e) => {
    const { path, text } = e as unknown as { path: string; text: string }
    fake.written[path] = text
    return value(undefined)
  })
  on('process.run', (_$, e) => {
    const { argv } = e as unknown as { argv: string[] }
    fake.validated.push(argv.join(' '))
    return value({ exitCode: 0, stdout: 'Validation passed', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  })
  on('ui.open', () => (opened(), value({ isPlaced: true })))
  on('ui.close', () => value(undefined))
  on('ui.toast', () => value(undefined))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('ui.render', ($, e) => ($.ui.resolve(e).Box as (p: object) => never)({}))
  return fake
}

const start = ($: { session: { start: (a: never) => Promise<unknown> } }) =>
  $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true } as never)
const forgeCall = { tool: 'mcp__forge__forge', ...GOOD } as never
const text = (r: unknown) => JSON.stringify(r)

describe('forge tool', () => {
  test('an invalid proposal is refused before anything is shown or written', async ($, on) => {
    const fake = engine(on)
    mock.clock(on)
    await start($)
    const r = await $.tool.call({ ...GOOD, tool: 'mcp__forge__forge', name: '../evil' } as never)
    expect(text(r)).toContain('refused before anyone saw it')
    expect(Object.keys(fake.written)).toHaveLength(0)
  })

  test('nothing is written until Approve, then the files land and validate runs', async ($, on) => {
    const fake = engine(on)
    mock.clock(on)
    await start($)
    const call = $.tool.call(forgeCall)
    await fake.opened
    expect(Object.keys(fake.written)).toHaveLength(0)

    const pane = await $.ui.mount({ plugin: 'forge', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'forge' })
    const shown = text(await pane.findAll({ type: 'Code' }))
    expect(shown).toContain('hooks/register.tsx')
    expect(Object.keys(fake.written)).toHaveLength(0)

    await pane.press({ key: 'approve' })
    const r = await call
    expect(Object.keys(fake.written).sort()).toEqual([
      '/home/me/.claude/forged-mods/tidy/.claude-plugin/plugin.json',
      '/home/me/.claude/forged-mods/tidy/hooks/hooks.json',
      '/home/me/.claude/forged-mods/tidy/hooks/register.tsx',
    ])
    expect(fake.validated).toEqual(['claude plugin validate /home/me/.claude/forged-mods/tidy'])
    expect(text(r)).toContain('not installed or enabled')
    expect(text(r)).toContain('claude --plugin-dir /home/me/.claude/forged-mods/tidy')
  })

  test('Reject writes nothing and tells the model', async ($, on) => {
    const fake = engine(on)
    mock.clock(on)
    await start($)
    const call = $.tool.call(forgeCall)
    await fake.opened
    const pane = await $.ui.mount({ plugin: 'forge', surface: 'desktop', component: 'Pane', props: PANE, requestId: 'forge' })
    await pane.press({ key: 'reject' })
    expect(text(await call)).toContain('rejected')
    expect(Object.keys(fake.written)).toHaveLength(0)
    expect(fake.validated).toHaveLength(0)
  })

  test('a slow answer returns pending, and /forge-approve completes it as a message', async ($, on) => {
    const fake = engine(on)
    const clock = mock.clock(on)
    const session = mock.session(on)
    await start($)
    const call = $.tool.call(forgeCall)
    await fake.opened
    await clock.advance(9000)
    const r = await call
    expect(text(r)).toContain('PENDING')
    expect(Object.keys(fake.written)).toHaveLength(0)

    const out = await $.command.run({ command: 'forge-approve', args: '', origin: { kind: 'composer' }, presentation: {} } as never)
    expect(text(out)).toContain('Approved')
    expect(Object.keys(fake.written)).toHaveLength(3)
    expect(text(session.appended())).toContain('forge: Approved')
  })

  test('/forge-approve from anything but the person is refused', async ($, on) => {
    const fake = engine(on)
    const clock = mock.clock(on)
    await start($)
    const call = $.tool.call(forgeCall)
    await fake.opened
    await clock.advance(9000)
    await call
    const out = await $.command.run({ command: 'forge-approve', args: '', origin: { kind: 'plugin', name: 'x' }, presentation: {} } as never)
    expect(text(out)).toContain('only the person')
    expect(Object.keys(fake.written)).toHaveLength(0)
  })

  test('an existing folder is never overwritten, and a second proposal waits its turn', async ($, on) => {
    const fake = engine(on)
    const clock = mock.clock(on)
    fake.existing.add('/home/me/.claude/forged-mods/tidy')
    await start($)
    expect(text(await $.tool.call(forgeCall))).toContain('already exists')
    fake.existing.clear()
    const first = $.tool.call(forgeCall)
    await fake.opened
    expect(text(await $.tool.call({ ...GOOD, tool: 'mcp__forge__forge', name: 'tidy' } as never))).toContain('still waiting')
    await clock.advance(9000)
    await first
  })
})

describe('repetition suggestion', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`a sequence repeated three times is offered as a band row (${surface})`, async ($, on) => {
      engine(on)
      mock.clock(on)
      on('tool.call', () => ({ result: 'ok' }) as never)
      await start($)
      const cycle = ['git status', 'git diff --stat', 'npm run build']
      for (let i = 0; i < 3; i += 1) for (const command of cycle) await $.tool.call({ tool: 'Bash', command } as never)
      await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)

      const band = await $.ui.mount({ plugin: 'forge', surface, component: 'AbovePrompt', props: BAND })
      expect(text(await band.findAll({ type: 'Text' }))).toContain('Repeated 3×: git status → git diff --stat → npm run build — Forge a tool?')
      await band.press({ key: 'forge-it' })
      const again = await $.ui.mount({ plugin: 'forge', surface, component: 'AbovePrompt', props: BAND })
      expect(text(await again.findAll({ type: 'Text' }))).not.toContain('Repeated')
    })
  }

  test('ordinary edit and read loops are not offered', async ($, on) => {
    engine(on)
    mock.clock(on)
    on('tool.call', () => ({ result: 'ok' }) as never)
    await start($)
    for (let i = 0; i < 4; i += 1) for (const tool of ['Read', 'Edit', 'Grep']) await $.tool.call({ tool } as never)
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    const band = await $.ui.mount({ plugin: 'forge', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(text(await band.findAll({ type: 'Text' }))).not.toContain('Repeated')
  })
})
