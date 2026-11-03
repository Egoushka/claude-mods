import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

import { ago, doneText, readSeen, rowText, startedRun, structuredOf } from '../hooks/lib'

const STARTED = JSON.stringify({ contract_version: 'run-status/v1', status: 'running', run_id: 'run_8f3a21c0d4e5' })

describe('helpers', () => {
  test('only an answer that says the run goes on starts a track', () => {
    expect(startedRun(STARTED)).toBe('run_8f3a21c0d4e5')
    expect(startedRun(JSON.stringify({ contract_version: 'result/v1', status: 'done', run_id: 'x' }))).toBeUndefined()
    expect(startedRun('no json here')).toBeUndefined()
    expect(startedRun(undefined)).toBeUndefined()
  })

  test('result reads as running, finished or lost', () => {
    expect(readSeen({ contract_version: 'run-status/v1', status: 'running', usd_total: 1.5, stage: 'verify' })).toEqual({ kind: 'running', usd: 1.5, stage: 'verify' })
    expect(readSeen({ contract_version: 'run-status/v1', status: 'queued' })).toEqual({ kind: 'running' })
    expect(readSeen({ contract_version: 'run-status/v1', status: 'lost' })).toEqual({ kind: 'lost' })
    expect(readSeen({ contract_version: 'run-status/v1', status: 'failed' })).toEqual({ kind: 'finished', status: 'failed' })
    expect(readSeen({ contract_version: 'result/v1', status: 'completed' })).toEqual({ kind: 'finished', status: 'completed' })
    expect(readSeen({ something: 'else' })).toBeUndefined()
    expect(readSeen('text')).toBeUndefined()
  })

  test('structured content wins, text JSON is the fallback', () => {
    expect(structuredOf({ content: [], structuredContent: { a: 1 } })).toEqual({ a: 1 })
    expect(structuredOf({ content: [{ type: 'text', text: '{"a":2}' }] })).toEqual({ a: 2 })
    expect(structuredOf({ content: [{ type: 'text', text: 'oops' }] })).toBeUndefined()
  })

  test('elapsed time is short', () => {
    expect(ago(12_000)).toBe('12s')
    expect(ago(4 * 60_000)).toBe('4m')
    expect(ago(3_600_000)).toBe('1h')
    expect(ago(5_400_000)).toBe('1h 30m')
  })

  test('the row names the count and as many runs as fit', () => {
    const r = (id: string, usd?: number) => ({ id, server: 'chargehand', since: 0, ...(usd === undefined ? {} : { usd }) })
    expect(rowText([r('run_8f3a21c0d4e5', 3.1)], 120_000, 80)).toBe('Chargehand: 1 running: run_8f3a… 2m $3.10')
    expect(rowText([r('run_8f3a21c0d4e5'), r('run_aaaaaaaaaaaa')], 60_000, 200)).toBe('Chargehand: 2 running: run_8f3a… 1m, run_aaaa… 1m')
    expect(rowText([r('run_8f3a21c0d4e5'), r('run_aaaaaaaaaaaa'), r('run_bbbbbbbbbbbb')], 0, 50)).toContain('+2 more')
    expect(rowText([r('run_8f3a21c0d4e5')], 0, 10).length).toBeLessThanOrEqual(10)
  })

  test('the finish note says the outcome and the cost', () => {
    const run = { id: 'run_8f3a21c0d4e5', server: 'chargehand', since: 0, usd: 3.1 }
    expect(doneText(run, { kind: 'finished', status: 'completed' })).toBe('Chargehand run run_8f3a… completed, $3.10.')
    expect(doneText({ ...run, usd: undefined }, { kind: 'finished', status: 'budget_exhausted' })).toBe('Chargehand run run_8f3a… budget exhausted.')
    expect(doneText(run, { kind: 'lost' })).toContain('was lost')
  })
})

const NOW = 1_800_000_000_000
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const BAND = { plugin: 'runstrip', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 100 } } as const
const ON = { options: { servers: 'chargehand' } }

type Answer = { structured?: unknown; isError?: boolean; throws?: boolean }

function world(on: On, answer: () => Answer) {
  const toasts: string[] = []
  const asked: { server: string; tool: string; args: unknown }[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.start', ($, e) => e)
  on('ui.toast', (_$, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined } as never
  })
  on('tool.call', () => ({ result: STARTED, text: STARTED }) as never)
  on('mcp.call', (_$, e) => {
    const c = e as unknown as { server: string; tool: string; args: unknown }
    asked.push(c)
    const a = answer()
    return { value: { content: [], isError: a.isError ?? false, structuredContent: a.structured } } as never
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }) as never)
  return { toasts, asked, clock }
}

const start = ($: Parameters<Parameters<typeof test>[1]>[0]) => $.session.start({ cwd: '/home/me/app', surface: 'terminal', isInteractive: true })
const orchestrate = ($: Parameters<Parameters<typeof test>[1]>[0], tool = 'mcp__chargehand__orchestrate') => $.tool.call({ tool, question: 'why?' } as never)
const running = (usd?: number) => ({ structured: { contract_version: 'run-status/v1', status: 'running', ...(usd === undefined ? {} : { usd_total: usd }) } })

describe('the row', () => {
  test('does nothing when no server is named', async ($, on) => {
    const w = world(on, () => running())
    await start($)
    await orchestrate($)
    await w.clock.advance(60_000)
    expect(w.asked).toEqual([])
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Chargehand/ })).toBeUndefined()
    await ui.unmount()
  })

  test('appears when this session starts a run, on every surface, with the cost so far', ON, async ($, on) => {
    const w = world(on, () => running(3.1))
    await start($)
    await orchestrate($)
    await w.clock.advance(15_000)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /Chargehand: 1 running: run_8f3a… .* \$3\.10/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('leaves the cost out where the credential is not priced', ON, async ($, on) => {
    const w = world(on, () => running())
    await start($)
    await orchestrate($)
    await w.clock.advance(15_000)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /1 running/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$/ })).toBeUndefined()
    await ui.unmount()
  })

  test('ignores orchestrate on a server it was not told about', ON, async ($, on) => {
    const w = world(on, () => running())
    await start($)
    await orchestrate($, 'mcp__other__orchestrate')
    await w.clock.advance(15_000)
    expect(w.asked).toEqual([])
  })

  test('reads each run with the result tool', ON, async ($, on) => {
    const w = world(on, () => running())
    await start($)
    await orchestrate($)
    await w.clock.advance(15_000)
    expect(w.asked[0]).toMatchObject({ server: 'chargehand', tool: 'result', args: { run_id: 'run_8f3a21c0d4e5' } })
  })

  test('goes away with one toast when the run finishes', ON, async ($, on) => {
    let a: Answer = running(2)
    const w = world(on, () => a)
    await start($)
    await orchestrate($)
    await w.clock.advance(15_000)
    a = { structured: { contract_version: 'result/v1', status: 'completed' } }
    await w.clock.advance(15_000)
    await w.clock.advance(15_000)
    expect(w.toasts).toEqual(['Chargehand run run_8f3a… completed, $2.00.'])
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Chargehand/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a failed read keeps the run instead of dropping it', ON, async ($, on) => {
    let a: Answer = running()
    const w = world(on, () => a)
    await start($)
    await orchestrate($)
    await w.clock.advance(15_000)
    a = { isError: true }
    await w.clock.advance(15_000)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /1 running/ })).toBeDefined()
    expect(w.toasts).toEqual([])
    await ui.unmount()
  })

  test('the same run started twice shows once', ON, async ($, on) => {
    const w = world(on, () => running())
    await start($)
    await orchestrate($)
    await orchestrate($)
    await w.clock.advance(15_000)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /1 running/ })).toBeDefined()
    await ui.unmount()
  })
})
