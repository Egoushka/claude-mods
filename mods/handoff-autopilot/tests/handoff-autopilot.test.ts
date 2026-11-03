import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { failureNote, rowText, shouldOffer, startPrompt } from '../hooks/draft'

describe('helpers', () => {
  test('the offer waits for the threshold and stays off at 0', () => {
    expect(shouldOffer(59, 60)).toBe(false)
    expect(shouldOffer(60, 60)).toBe(true)
    expect(shouldOffer(undefined, 60)).toBe(false)
    expect(shouldOffer(90, 0)).toBe(false)
    expect(shouldOffer(90, Infinity)).toBe(false)
  })

  test('each step reads in plain words', () => {
    expect(rowText({ step: 'offer', percent: 62.4 })).toBe('This session has used 62% of its context. Draft a handoff before it grows?')
    expect(rowText({ step: 'ready', file: 'docs/HANDOFF.draft.md' })).toBe('Handoff saved to docs/HANDOFF.draft.md.')
    expect(rowText({ step: 'failed', note: 'the turn was interrupted' })).toContain('interrupted')
    expect(rowText({ step: 'idle' })).toBe('')
  })

  test('failures are named, not dumped', () => {
    expect(failureNote('nothing-to-fork')).toBe('nothing to hand off yet')
    expect(failureNote('api-error', 529)).toBe('the API answered 529')
  })

  test('the start prompt names the file and says to check git', () => {
    expect(startPrompt('docs/H.md')).toBe('Continue: read docs/H.md, check it against git, and carry on.')
  })
})

const NOW = 1_800_000_000_000
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const BAND = { plugin: 'handoff-autopilot', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 80 } } as const

function world(on: On, percent: number | (() => number), fork: () => unknown = () => ({ isAnswered: true, text: '# Handoff: x\n', usage: {} })) {
  const written: Record<string, string> = {}
  const forks: string[] = []
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.start', ($, e) => e)
  on('command.register', () => ({ value: { command: 'handoff-draft' } }) as never)
  on('session.root', () => ({ value: '/home/me/app' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: typeof percent === 'function' ? percent() : percent }, rateLimits: [] } }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('model.fork', (_$, e) => {
    forks.push((e as unknown as { prompt: string }).prompt)
    return { value: fork() } as never
  })
  on('fs.write', (_$, e) => {
    const w = e as unknown as { path: string; text: string }
    written[w.path] = w.text
    return { value: undefined } as never
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }) as never)
  return { written, forks }
}

const start = ($: Parameters<Parameters<typeof test>[1]>[0]) => $.session.start({ cwd: '/home/me/app', surface: 'terminal', isInteractive: true })
const finish = ($: Parameters<Parameters<typeof test>[1]>[0]) => $.turn.complete({ reason: 'answer' } as never)

describe('the row', () => {
  test('stays quiet below the threshold', async ($, on) => {
    world(on, 30)
    await start($)
    await finish($)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /handoff/i })).toBeUndefined()
    await ui.unmount()
  })

  test('offers once the context passes the threshold, on every surface', async ($, on) => {
    world(on, 64)
    await start($)
    await finish($)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /64% of its context/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('is off when the threshold is 0', { options: { atPercent: 0 } }, async ($, on) => {
    world(on, 95)
    await start($)
    await finish($)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /handoff/i })).toBeUndefined()
    await ui.unmount()
  })

  test('Draft forks the session, writes the file and says where', async ($, on) => {
    const w = world(on, 64)
    await start($)
    await finish($)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'draft' })
    expect(w.forks).toHaveLength(1)
    expect(w.forks[0]).toContain('Never invent a commit')
    const text = w.written['/home/me/app/docs/HANDOFF.draft.md'] ?? ''
    expect(text).toContain('# Handoff: x')
    expect(text.startsWith('<!-- drafted by handoff-autopilot 2027-')).toBe(true)
    expect(await ui.find({ type: 'Text', text: /Handoff saved to docs\/HANDOFF\.draft\.md/ })).toBeDefined()
    await ui.unmount()
  })

  test('a failed fork shows the reason and can be tried again', async ($, on) => {
    let n = 0
    const w = world(on, 64, () => (n++ === 0 ? { isAnswered: false, reason: 'nothing-to-fork', usage: {} } : { isAnswered: true, text: 'ok', usage: {} }))
    await start($)
    await finish($)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'draft' })
    expect(await ui.find({ type: 'Text', text: /nothing to hand off yet/ })).toBeDefined()
    expect(Object.keys(w.written)).toHaveLength(0)
    await ui.press({ key: 'again' })
    expect(Object.keys(w.written)).toHaveLength(1)
    await ui.unmount()
  })

  test('Not now stays silent until the context grows 15 points', async ($, on) => {
    const usage = { percent: 64 }
    world(on, () => usage.percent)
    await start($)
    await finish($)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'later' })
    expect(await ui.find({ type: 'Text', text: /handoff/i })).toBeUndefined()
    usage.percent = 70
    await finish($)
    expect(await ui.find({ type: 'Text', text: /handoff/i })).toBeUndefined()
    usage.percent = 80
    await finish($)
    expect(await ui.find({ type: 'Text', text: /80% of its context/ })).toBeDefined()
    await ui.unmount()
  })

  test('/handoff-draft drafts on demand with no row needed', async ($, on) => {
    const w = world(on, 10)
    await start($)
    const r = await $.command.run({ command: 'handoff-draft', args: '' })
    expect(r.text).toBe('Handoff saved to docs/HANDOFF.draft.md.')
    expect(Object.keys(w.written)).toEqual(['/home/me/app/docs/HANDOFF.draft.md'])
  })

  test('a subagent finishing does not raise the offer', async ($, on) => {
    world(on, 90)
    await start($)
    await $.turn.complete({ reason: 'answer', agentId: 'a1' } as never)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /handoff/i })).toBeUndefined()
    await ui.unmount()
  })
})
