import { describe, expect, test, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

const MODEL = { kind: 'model', model: 'm' } as const
const row = (text: string) =>
  ({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }, { type: 'tool_use', id: 't', name: 'Read', input: {} }] },
    door: 'response',
    origin: MODEL,
    uuid: 'u1',
  }) as never

const BAND = { plugin: 'voice', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80 } } as never

function engine(on: On) {
  on('session.start', ($, e) => e)
  on('ui.status', ($, e) => ({ value: e }) as never)
  on('turn.start', ($, e) => e as never)
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, { key: 'engine' })
  })
}

const LONG =
  'The `handler` in src/app.ts calls `parse()` and the config file sets the version, so the build uses it. '.repeat(8)

describe('slop filter', () => {
  test('rewrites the stored text block and leaves other blocks alone', async ($, on) => {
    engine(on)
    const session = mock.session(on)
    await $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })
    await $.session.append(row('Great question! It is genuinely `honestly` fine. I hope this helps!'))
    const stored = session.appended().at(-1)?.message.content ?? []
    expect((stored[0] as { text: string }).text).toBe('It is `honestly` fine.')
    expect(stored[1]?.type).toBe('tool_use')
  })

  test('flag mode counts but stores the original', { options: { mode: 'flag' } }, async ($, on) => {
    engine(on)
    const session = mock.session(on)
    await $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })
    await $.session.append(row('Honestly, it works.'))
    expect((session.appended().at(-1)?.message.content[0] as { text: string }).text).toBe('Honestly, it works.')
  })

  test('off switch', { options: { slopFilter: false } }, async ($, on) => {
    engine(on)
    const session = mock.session(on)
    await $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })
    await $.session.append(row('Honestly, it works.'))
    expect((session.appended().at(-1)?.message.content[0] as { text: string }).text).toBe('Honestly, it works.')
  })

  test('extra phrases from settings', { options: { extraPhrases: 'leverage' } }, async ($, on) => {
    engine(on)
    const session = mock.session(on)
    await $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })
    await $.session.append(row('We leverage caching.'))
    expect((session.appended().at(-1)?.message.content[0] as { text: string }).text).toBe('We caching.')
  })
})

describe('evidence auditor', () => {
  const complete = (text: string) => ({ isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) as never

  test('shows the band, and Ask for sources submits a prompt listing the claims', async ($, on) => {
    engine(on)
    const clock = mock.clock(on)
    let asked = ''
    let submitted = ''
    on('model.complete', (_$, e) => {
      asked = e.prompt
      return { value: complete('{"claims": ["the handler calls parse()", "the build uses the version"]}') } as never
    })
    on('prompt.submit', (_$, e) => {
      submitted = e.text
      return { text: e.text } as never
    })
    await $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })
    await $.turn.complete({ answer: LONG, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await clock.settle()
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /2 claims in the last reply cite no source/ })).toBeDefined()
    expect(asked).toContain('file:line')
    await ui.press({ key: 'back' })
    expect(submitted).toContain('1. the handler calls parse()')
    expect(submitted).toContain('UNKNOWN')
    await ui.unmount()
  })

  test('Dismiss hides the band', async ($, on) => {
    engine(on)
    const clock = mock.clock(on)
    on('model.complete', () => ({ value: complete('{"claims": ["x is y"]}') }) as never)
    await $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })
    await $.turn.complete({ answer: LONG, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await clock.settle()
    const ui = await $.ui.mount(BAND)
    await ui.press({ key: 'dismiss' })
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: /unbacked/ })).toBeUndefined()
    await ui.unmount()
  })

  test('short replies and a disabled auditor never call the model', async ($, on) => {
    engine(on)
    let calls = 0
    on('model.complete', () => {
      calls += 1
      return { value: complete('{"claims": ["x"]}') } as never
    })
    await $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })
    await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    expect(calls).toBe(0)
  })

  test('a model that fails or rambles leaves no band', async ($, on) => {
    engine(on)
    const clock = mock.clock(on)
    on('model.complete', () => ({ value: complete('I could not find any problems, sorry.') }) as never)
    await $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })
    await $.turn.complete({ answer: LONG, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await clock.settle()
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /unbacked/ })).toBeUndefined()
    await ui.unmount()
  })
})
