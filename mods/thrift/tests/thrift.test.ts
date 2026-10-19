import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { applyDiet, base64, estimateTokens, isReset, isSameModel, modelForTier, parseTier, slope, sparkRaster, turnsLeft, weatherLine } from '../hooks/logic'

describe('logic', () => {
  test('parses the classifier reply and maps tiers to models', () => {
    expect(parseTier(' Hard.')).toBe('hard')
    expect(parseTier('maybe')).toBeNull()
    expect(modelForTier({ trivialModel: 'haiku' }, 'trivial')).toBe('haiku')
    expect(modelForTier({ normalModel: '  ' }, 'normal')).toBe('sonnet')
    expect(isSameModel('claude-sonnet-5-5', 'sonnet')).toBe(true)
    expect(isSameModel('claude-sonnet-5-5', 'opus')).toBe(false)
  })

  test('forecasts turns to the limit by linear trend', () => {
    const points = [100000, 106000, 112000]
    expect(Math.round(slope(points))).toBe(6000)
    expect(turnsLeft(points, 150000)).toBe(7)
    expect(weatherLine(points, 150000, true)).toBe('context 112k ▲ 6k/turn · ~7 turns to compaction')
    expect(weatherLine([50000, 50000], 150000, false)).toBe('context 50k ▬ steady')
    expect(weatherLine([], 1, false)).toBeUndefined()
    expect(isReset(120000, 20000)).toBe(true)
    expect(isReset(120000, 118000)).toBe(false)
  })

  test('the sparkline raster packs one cell per turn', () => {
    const r = sparkRaster([10, 50, 100], 100)
    expect(r.columns).toBe(3)
    // 3 cells * 3 words * 4 bytes = 36 bytes -> 48 base64 characters
    expect(r.cells).toHaveLength(48)
    expect(base64(new Uint8Array([77, 97, 110]))).toBe('TWFu')
    expect(base64(new Uint8Array([77, 97]))).toBe('TWE=')
  })

  test('the diet drops chosen sections and never a pinned one', () => {
    const sections = [
      { id: 'intro', text: 'a'.repeat(400) },
      { id: 'tone', text: 'b'.repeat(400) },
      { id: 'memory', text: 'c'.repeat(800) },
    ]
    const r = applyDiet(sections, ['intro', 'memory'])
    expect(r.sections.map(s => s.id)).toEqual(['intro', 'tone'])
    expect(r.saved).toBe(estimateTokens('c'.repeat(800)))
  })
})

type Handlers = Record<string, (...args: never[]) => unknown>

// What the engine answers beneath the plugin in a session; `over` replaces a default by event name.
function engine(on: On, over: Handlers = {}) {
  const defaults: Handlers = {
    'session.start': (($: unknown, e: unknown) => e) as never,
    'session.model': () => ({ value: 'claude-sonnet-5-5' }),
    'model.complete': () => ({ value: { isAnswered: true, text: 'normal', usage: {} } }),
    'command.register': () => ({ value: undefined }),
    'store.get': () => ({ value: undefined }),
    'store.set': () => ({ value: undefined }),
    'ui.toast': () => ({ value: undefined }),
    'ui.open': () => ({ value: { isPlaced: true } }),
    'session.usage': () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }),
    'turn.complete': () => ({ text: '' }),
    'session.measure': () => ({ changed: ['context'] }),
    'session.compact': () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }),
    'prompt.submit': (($: unknown, e: { text: string }) => ({ text: e.text })) as never,
    'prompt.compose': () => ({ sections: [] }),
    // Another plugin's row, drawn beneath the band.
    'ui.render': (($: { ui: { resolve: (e: unknown) => { Text: (p: object) => unknown } } }, e: unknown) => $.ui.resolve(e).Text({ children: 'other plugin row' })) as never,
  }
  for (const [event, handler] of Object.entries({ ...defaults, ...over })) (on as unknown as (e: string, h: unknown) => void)(event, handler)
}

const START = { cwd: '/home/me/app', surface: null, isInteractive: true } as never
const USER = { wait: false, origin: { kind: 'user' } }
const usage = (tokens: number | undefined, extra: object = {}) => ({ value: { startedAt: 0, context: { window: 200000, tokens, ...extra }, rateLimits: [] } })
const measure = (tokens: number) => ({ context: { window: 200000, tokens }, rateLimits: [], changed: ['context'] }) as never
const done = (turnId: string, agentId?: string) => ({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer', agentId }) as never

async function drain(stream: AsyncIterable<unknown>) {
  for await (const _ of stream) void _
}

// The bottom of turn.step: records the model each request names.
function stepRecorder(steps: string[]) {
  return async function* (_$: unknown, e: { agentId?: string; model: string; turnId: string; index: number }) {
    steps.push(`${e.agentId ?? 'main'}:${e.model}`)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] }
  }
}
const step = ($: { turn: { step: (e: never) => AsyncIterable<unknown> } }, agentId?: string) =>
  drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId } as never))

describe('router', () => {
  test('suggest mode toasts the better model and leaves the turn alone', async ($, on) => {
    const toasts: string[] = []
    const steps: string[] = []
    engine(on, {
      'model.complete': () => ({ value: { isAnswered: true, text: 'trivial', usage: {} } }),
      'ui.toast': ((_$: unknown, e: { text: string }) => (toasts.push(e.text), { value: undefined })) as never,
      'turn.step': stepRecorder(steps) as never,
    })
    await $.session.start(START)
    await $.prompt.submit({ text: 'rename foo to bar in utils.ts', ...USER } as never)
    expect(toasts.join()).toContain('looks trivial')
    expect(toasts.join()).toContain('haiku')
    await step($ as never)
    expect(steps).toEqual(['main:claude-sonnet-5-5'])
  })

  test('auto mode rewrites the model of the main loop only, for that turn only', { options: { routerMode: 'auto' } }, async ($, on) => {
    const steps: string[] = []
    engine(on, { 'model.complete': () => ({ value: { isAnswered: true, text: 'hard', usage: {} } }), 'turn.step': stepRecorder(steps) as never })
    await $.session.start(START)
    await $.prompt.submit({ text: 'redesign the auth flow across all services', ...USER } as never)
    await step($ as never)
    await step($ as never, 'sub1')
    await $.turn.complete(done('t1'))
    await step($ as never)
    expect(steps).toEqual(['main:opus', 'sub1:claude-sonnet-5-5', 'main:claude-sonnet-5-5'])
  })

  test('a tier already on the current model changes nothing', { options: { routerMode: 'auto' } }, async ($, on) => {
    const steps: string[] = []
    engine(on, { 'turn.step': stepRecorder(steps) as never })
    await $.session.start(START)
    await $.prompt.submit({ text: 'fix the failing test in parser', ...USER } as never)
    await step($ as never)
    expect(steps).toEqual(['main:claude-sonnet-5-5'])
  })

  test('off mode never calls the model', { options: { routerMode: 'off' } }, async ($, on) => {
    let calls = 0
    engine(on, { 'model.complete': () => (calls += 1, { value: { isAnswered: true, text: 'hard', usage: {} } }) })
    await $.session.start(START)
    await $.prompt.submit({ text: 'a long enough prompt', ...USER } as never)
    expect(calls).toBe(0)
  })
})

const band = (surface: 'terminal' | 'desktop') =>
  ({ plugin: 'thrift', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80 } }) as never

describe('coach', () => {
  test('past the threshold the band offers Hand off; the button sends the configured prompt', { options: { coachThreshold: 100000, handoffPrompt: 'write the note' } }, async ($, on) => {
    const sent: string[] = []
    engine(on, { 'prompt.submit': ((_$: unknown, e: { text: string }) => (sent.push(e.text), { text: e.text })) as never })
    await $.session.start(START)
    await $.session.measure(measure(90000))
    let ui = await $.ui.mount(band('desktop'))
    expect(await ui.find({ key: 'handoff' })).toBeUndefined()
    await $.session.measure(measure(120000))
    ui = await $.ui.mount(band('desktop'))
    expect(await ui.find({ key: 'handoff' })).toBeDefined()
    expect(await ui.find({ key: 'compact' })).toBeDefined()
    await ui.press({ key: 'handoff' })
    expect(sent).toEqual(['write the note'])
    ui = await $.ui.mount(band('desktop'))
    expect(await ui.find({ key: 'handoff' })).toBeUndefined()
  })

  test('Dismiss hides the row until the context crosses again', { options: { coachThreshold: 100000 } }, async ($, on) => {
    engine(on)
    await $.session.start(START)
    await $.session.measure(measure(120000))
    let ui = await $.ui.mount(band('desktop'))
    await ui.press({ key: 'dismiss' })
    await $.session.measure(measure(130000))
    ui = await $.ui.mount(band('desktop'))
    expect(await ui.find({ key: 'dismiss' })).toBeUndefined()
    await $.session.measure(measure(40000))
    await $.session.measure(measure(110000))
    ui = await $.ui.mount(band('desktop'))
    expect(await ui.find({ key: 'dismiss' })).toBeDefined()
  })

  test('Compact asks the engine to compact', { options: { coachThreshold: 100000 } }, async ($, on) => {
    let compacted = 0
    engine(on, { 'session.compact': () => (compacted += 1, { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }) })
    await $.session.start(START)
    await $.session.measure(measure(120000))
    const ui = await $.ui.mount(band('desktop'))
    await ui.press({ key: 'compact' })
    expect(compacted).toBe(1)
  })

  test('a threshold of 0 turns the coach off', { options: { coachThreshold: 0 } }, async ($, on) => {
    engine(on)
    await $.session.start(START)
    await $.session.measure(measure(190000))
    const ui = await $.ui.mount(band('desktop'))
    expect(await ui.find({ key: 'handoff' })).toBeUndefined()
  })
})

describe('weather', () => {
  async function runTurns($: never, on: On, sizes: number[]) {
    let i = 0
    engine(on, {
      'session.usage': ((_$: unknown, e: { breakdown?: string }) =>
        e.breakdown
          ? usage(sizes[0], { breakdown: { isAutoCompactEnabled: true, autoCompactThreshold: 150000, rawMaxTokens: 200000 } })
          : usage(sizes[i++])) as never,
    })
    await ($ as { session: { start: (e: never) => Promise<unknown> } }).session.start(START)
    for (const n of sizes) await ($ as { turn: { complete: (e: never) => Promise<unknown> } }).turn.complete(done(`t${n}`))
  }

  test('the forecast line shows growth per turn and a sparkline: Raster on the terminal, text elsewhere', async ($, on) => {
    await runTurns($ as never, on, [100000, 106000, 112000])
    const term = await $.ui.mount(band('terminal'))
    expect(await term.find({ text: 'context 112k ▲ 6k/turn · ~7 turns to compaction' })).toBeDefined()
    expect(await term.find({ text: 'context 112k ▲ 6k/turn · ~7 turns to compaction' })).toBeDefined()
    expect(await term.find({ type: 'Raster' })).toBeDefined()
    const desk = await $.ui.mount(band('desktop'))
    expect(await desk.find({ type: 'Raster' })).toBeUndefined()
    expect(await desk.find({ text: /[▁▂▃▄▅▆▇█]{3}/ })).toBeDefined()
  })

  test('a compaction starts the trend over', async ($, on) => {
    await runTurns($ as never, on, [100000, 110000, 120000, 30000])
    const ui = await $.ui.mount(band('desktop'))
    expect(await ui.find({ text: /^context 30k/ })).toBeDefined()
    expect(await ui.find({ text: /▲/ })).toBeUndefined()
  })

  test('a subagent turn does not enter the trend', async ($, on) => {
    engine(on, { 'session.usage': () => usage(50000) })
    await $.session.start(START)
    await $.turn.complete(done('t1', 'sub1'))
    const ui = await $.ui.mount(band('desktop'))
    expect(await ui.find({ text: /context/ })).toBeUndefined()
  })

  test('the band keeps what the engine drew beneath it', async ($, on) => {
    engine(on, { 'session.usage': () => usage(50000) })
    await $.session.start(START)
    await $.turn.complete(done('t1'))
    const ui = await $.ui.mount(band('desktop'))
    expect(await ui.find({ text: /context 50k/ })).toBeDefined()
    expect(await ui.find({ text: 'other plugin row' })).toBeDefined()
  })
})

describe('diet', () => {
  const sections = [
    { id: 'intro', text: 'i'.repeat(400), scope: 'shared' },
    { id: 'tone', text: 't'.repeat(4000), scope: 'shared' },
    { id: 'memory', text: 'm'.repeat(2000), scope: 'session' },
  ]
  const FACTS = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never
  const PANE = { plugin: 'thrift', surface: 'desktop', component: 'Pane', requestId: 'thrift-diet', props: { bodyColumns: 80 } } as never
  const ids = (r: { sections: readonly { id: string }[] }) => r.sections.map(s => s.id)

  test('/diet lists sections; Drop removes one from the prompt; pinned ones have no button; the choice persists per folder', async ($, on) => {
    const kept: Record<string, unknown> = {}
    engine(on, {
      'prompt.compose': () => ({ sections }),
      'store.set': ((_$: unknown, e: { key: string; value: unknown }) => (kept[e.key] = e.value, { value: undefined })) as never,
      'command.run': () => ({ text: 'bottom' }),
    })
    await $.session.start(START)
    await $.command.run({ command: 'diet' } as never)
    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ key: 'toggle-intro' })).toBeUndefined()
    expect(await ui.find({ key: 'toggle-tone' })).toBeDefined()
    await ui.press({ key: 'toggle-tone' })
    expect(ids(await $.prompt.compose(FACTS))).toEqual(['intro', 'memory'])
    expect(kept['diet:/home/me/app']).toEqual(['tone'])
    const bar = await $.ui.mount(band('desktop'))
    expect(await bar.find({ text: /diet: −1k\/request/ })).toBeDefined()
    await ui.press({ key: 'toggle-tone' })
    expect(ids(await $.prompt.compose(FACTS))).toEqual(['intro', 'tone', 'memory'])
  })

  test('a saved choice is loaded at session start and a pinned id in it is ignored', async ($, on) => {
    engine(on, { 'prompt.compose': () => ({ sections }), 'store.get': () => ({ value: ['memory', 'intro'] }) })
    await $.session.start(START)
    expect(ids(await $.prompt.compose(FACTS))).toEqual(['intro', 'tone'])
  })

  test('the diet off leaves the prompt whole', { options: { diet: false } }, async ($, on) => {
    engine(on, { 'prompt.compose': () => ({ sections }), 'store.get': () => ({ value: ['memory'] }) })
    await $.session.start(START)
    expect(ids(await $.prompt.compose(FACTS))).toEqual(['intro', 'tone', 'memory'])
  })
})
