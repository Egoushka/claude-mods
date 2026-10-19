import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The game's generator, repeated here so a test knows where the nth thing falls.
function columns(n: number): number[] {
  let seed = 2463534242
  const xs: number[] = []
  for (let i = 0; i < n; i += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    xs.push((seed >>> 8) % 24)
  }
  return xs
}

const WORKING = { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 80 } as never
const FRAME = 120

function engine(on: On, toasts: string[] = [], isError = false) {
  on('session.start', ($, e) => e)
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }) as never)
  on('tool.call', () => ({ result: 'ok', ...(isError ? { isError: true } : {}) }) as never)
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['the rest'] }) as never)
  mock.store(on)
  mock.clock(on, { now: 0 })
}

const start = ($: Parameters<Parameters<typeof test>[1]>[0]) => $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })
const turn = ($: Parameters<Parameters<typeof test>[1]>[0], n: number) => $.turn.start({ text: `t${n}`, turnId: `t${n}` })
const complete = ($: Parameters<Parameters<typeof test>[1]>[0], n: number) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: `t${n}`, reason: 'answer' } as never)

describe('game', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`a tool call drops a coin you can catch (${surface})`, async ($, on) => {
      const toasts: string[] = []
      engine(on, toasts)
      await start($)
      await turn($, 1)
      const ui = await $.ui.mount({ plugin: 'arcade', surface, component: 'AbovePrompt', props: WORKING })
      await $.tool.call({ tool: 'Read', file_path: '/x' } as never)
      await ui.redraw()
      const [x] = columns(1)
      await ui.pointer({ type: 'move', x: x ?? 0, y: 4 })
      await ui.advance(FRAME * 12)
      expect((await ui.find({ type: 'Text', text: /^1$/, in: 'arcade' }))).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /the rest/ })).toBeDefined()
      await complete($, 1)
      expect(toasts).toContain('arcade: 1 pts, best 1')
    })
  }

  test('a missed coin scores nothing and the arrow keys move the ship', async ($, on) => {
    engine(on)
    await start($)
    await turn($, 1)
    const ui = await $.ui.mount({ plugin: 'arcade', surface: 'terminal', component: 'AbovePrompt', props: WORKING })
    await $.tool.call({ tool: 'Grep', pattern: 'x' } as never)
    await ui.redraw()
    const [x = 0] = columns(1)
    const far = x < 12 ? 21 : 2
    await ui.pointer({ type: 'move', x: far, y: 4 })
    await ui.key({ key: 'left' })
    await ui.key({ key: 'right' })
    await ui.advance(FRAME * 12)
    expect(await ui.find({ type: 'Text', text: /^0$/, in: 'arcade' })).toBeDefined()
  })

  test('hazards cost lives until the game is over, and a new turn starts a new round', async ($, on) => {
    engine(on)
    await start($)
    await turn($, 1)
    const ui = await $.ui.mount({ plugin: 'arcade', surface: 'terminal', component: 'AbovePrompt', props: WORKING })
    const xs = columns(3)
    for (const [i, x] of xs.entries()) {
      await $.tool.call({ tool: 'Bash', command: 'make' } as never)
      await ui.redraw()
      await ui.pointer({ type: 'move', x, y: 4 })
      await ui.advance(FRAME * 12)
      if (i < 2) expect(await ui.find({ type: 'Text', text: new RegExp(`^${'♥'.repeat(2 - i)}$`), in: 'arcade' })).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: /GAME OVER/, in: 'arcade' })).toBeDefined()
    await ui.key({ key: 'return' })
    expect(await ui.find({ type: 'Text', text: /GAME OVER/, in: 'arcade' })).toBeUndefined()
    await complete($, 1)
    await turn($, 2)
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: /^♥♥♥$/, in: 'arcade' })).toBeDefined()
  })

  test('a failed tool call drops two hazards', async ($, on) => {
    engine(on, [], true)
    await start($)
    await turn($, 1)
    const ui = await $.ui.mount({ plugin: 'arcade', surface: 'terminal', component: 'AbovePrompt', props: WORKING })
    await $.tool.call({ tool: 'Read', file_path: '/x' } as never)
    await ui.redraw()
    await ui.advance(FRAME)
    // The tool is a Read, so its own drop is a coin; the failure adds two hazards.
    const tree = await ui.drawn({ in: 'arcade' })
    const count = (node: unknown, ch: string): number =>
      typeof node === 'string' ? node.split(ch).length - 1 : Array.isArray(node) ? node.reduce((n: number, c) => n + count(c, ch), 0) : node && typeof node === 'object' ? count((node as { children?: unknown }).children, ch) : 0
    expect(count(tree, '#')).toBe(2)
    expect(count(tree, 'o')).toBe(1)
  })
})

describe('band', () => {
  test('it draws only while working, not under a survey, and yields to a short band', async ($, on) => {
    engine(on)
    await start($)
    await turn($, 1)
    const idle = await $.ui.mount({ plugin: 'arcade', surface: 'terminal', component: 'AbovePrompt', props: { ...(WORKING as object), isWorking: false } as never })
    expect(await idle.find({ type: 'Client' })).toBeUndefined()
    const survey = await $.ui.mount({ plugin: 'arcade', surface: 'terminal', component: 'AbovePrompt', props: { ...(WORKING as object), hasSurvey: true } as never })
    expect(await survey.find({ type: 'Client' })).toBeUndefined()
    const short = await $.ui.mount({ plugin: 'arcade', surface: 'terminal', component: 'AbovePrompt', props: { ...(WORKING as object), maxRows: 5 } as never })
    expect(await short.find({ type: 'Client' })).toBeUndefined()
    const shown = await $.ui.mount({ plugin: 'arcade', surface: 'terminal', component: 'AbovePrompt', props: WORKING })
    expect(await shown.find({ type: 'Client' })).toBeDefined()
  })

  test('the toggle folds the game into one line and back', async ($, on) => {
    engine(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'arcade', surface: 'terminal', component: 'AbovePrompt', props: WORKING })
    expect(await ui.find({ type: 'Client' })).toBeDefined()
    await ui.press({ key: 'toggle' })
    expect(await ui.find({ type: 'Client' })).toBeUndefined()
    await ui.press({ key: 'toggle' })
    expect(await ui.find({ type: 'Client' })).toBeDefined()
  })

  test('start collapsed', { options: { startCollapsed: true } }, async ($, on) => {
    engine(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'arcade', surface: 'terminal', component: 'AbovePrompt', props: WORKING })
    expect(await ui.find({ type: 'Client' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'toggle' })).toBeDefined()
  })

  test('off means off', { options: { enabled: false } }, async ($, on) => {
    engine(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'arcade', surface: 'terminal', component: 'AbovePrompt', props: WORKING })
    expect(await ui.find({ type: 'Client' })).toBeUndefined()
  })
})
