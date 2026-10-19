import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { apply, classify, hungerNow, levelFor, moodOf, newPet, sprite } from '../hooks/pet'

const T0 = 1_800_000_000_000
const MIN = 60000

describe('classify', () => {
  test('test runners that exit 0 feed, failures sicken', () => {
    for (const cmd of ['npm test', 'pnpm run test -- --watch=false', 'pytest -q', 'go test ./...', 'dotnet test src/App.sln', 'cargo nextest run'.replace('nextest run', 'test'), 'claude plugin test mods/pet', 'cd app && yarn test'])
      expect(classify(cmd, false, '')).toBe('test-pass')
    expect(classify('npm test', true, 'FAIL')).toBe('test-fail')
    expect(classify('git commit -m "fix jest"', false, '')).toBe('commit')
    expect(classify('ls tests', false, '')).toBeUndefined()
    expect(classify('echo "run npm test"', false, '')).toBeUndefined()
  })

  test('commits, merges, force pushes, CI', () => {
    expect(classify('git commit -m x', false, '')).toBe('commit')
    expect(classify('git commit --dry-run', false, '')).toBeUndefined()
    expect(classify('git commit -m x', true, '')).toBeUndefined()
    expect(classify('gh pr merge 4 --squash', false, '')).toBe('merge')
    expect(classify('git push --force origin main', false, '')).toBe('force-push')
    expect(classify('git push -f', false, '')).toBe('force-push')
    expect(classify('git push --force-with-lease', false, '')).toBe('force-push')
    expect(classify('git push origin main', false, '')).toBeUndefined()
    expect(classify('gh pr checks 4', true, 'build\tfail\t1m\nlint\tpass\t10s')).toBe('ci-red')
    expect(classify('gh pr checks 4', false, 'build\tpass\t1m\nlint\tpass\t10s')).toBe('ci-green')
    expect(classify('gh run watch 9 --exit-status', true, 'Run CI completed with failure')).toBe('ci-red')
  })
})

describe('pet', () => {
  test('levels grow with xp', () => {
    expect([0, 9, 10, 39, 40, 90].map(levelFor)).toEqual([1, 1, 2, 2, 3, 4])
  })

  test('feeding, sickness and healing', () => {
    let p = newPet('/r/app', T0)
    expect(moodOf(p, T0)).toBe('content')
    p = apply(p, 'test-pass', T0)
    expect(p.hunger).toBe(15)
    expect(moodOf(p, T0)).toBe('happy')
    p = apply(p, 'force-push', T0 + MIN)
    expect(moodOf(p, T0 + MIN)).toBe('sick')
    expect(moodOf(p, T0 + 61 * MIN)).not.toBe('sick')
    p = apply(p, 'ci-red', T0 + 2 * MIN)
    p = apply(p, 'test-pass', T0 + 3 * MIN)
    expect(moodOf(p, T0 + 3 * MIN)).toBe('happy')
  })

  test('hunger rises with time and a stroke has a cooldown', () => {
    const p = newPet('/r/app', T0)
    expect(hungerNow(p, T0 + 6 * 60 * MIN)).toBe(100)
    expect(moodOf(p, T0 + 6 * 60 * MIN)).toBe('hungry')
    const once = apply(p, 'stroke', T0)
    const twice = apply(once, 'stroke', T0 + 10000)
    expect(once.xp).toBe(1)
    expect(twice.xp).toBe(1)
    expect(apply(twice, 'stroke', T0 + 2 * MIN).xp).toBe(2)
  })

  test('sprites differ by mood', () => {
    expect(new Set((['happy', 'content', 'hungry', 'sick'] as const).map(m => sprite(m, 1).join('|'))).size).toBe(4)
  })
})

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never

function engine(on: On, toasts: string[] = []) {
  on('session.start', ($, e) => e)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('process.run', () => ok('/home/me/app\n'))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }) as never)
  mock.store(on)
  return mock.clock(on, { now: T0 })
}

const start = ($: Parameters<Parameters<typeof test>[1]>[0]) => $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })
const BAND = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 80 } as never

describe('hooks', () => {
  test('a passing test run feeds the pet and a failing one makes it sick', async ($, on) => {
    engine(on)
    let isFailing = false
    on('tool.call', () => (isFailing ? ({ result: 'FAIL', isError: true, text: 'FAIL' }) : ({ result: 'ok', text: 'ok' })) as never)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['rest of the band'] }) as never)
    await start($)
    const ui = await $.ui.mount({ plugin: 'pet', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ type: 'Text', text: /content/ })).toBeDefined()
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: /happy/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /green tests/ })).toBeDefined()
    isFailing = true
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: /sick/ })).toBeDefined()
    // The band composes: whatever else draws there stays.
    expect(await ui.find({ type: 'Text', text: /rest of the band/ })).toBeDefined()
  })

  test('the pet button earns xp and level-ups toast', async ($, on) => {
    const toasts: string[] = []
    engine(on, toasts)
    on('tool.call', () => ({ result: 'ok', text: 'ok' }) as never)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['rest'] }) as never)
    await start($)
    const ui = await $.ui.mount({ plugin: 'pet', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    await ui.press({ key: 'pet' })
    expect(await ui.find({ type: 'Text', text: /purr/ })).toBeDefined()
    // A stroke (1 xp) and three commits (3 each) reach 10 xp, level 2.
    for (const m of ['a', 'b', 'c']) await $.tool.call({ tool: 'Bash', command: `git commit -m ${m}` } as never)
    expect(toasts.some(t => /reached level 2/.test(t))).toBe(true)
  })

  test('it hides under a survey and honours compact mode', { options: { compact: true } }, async ($, on) => {
    engine(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['survey'] }) as never)
    await start($)
    const hidden = await $.ui.mount({ plugin: 'pet', surface: 'terminal', component: 'AbovePrompt', props: { ...(BAND as object), hasSurvey: true } as never })
    expect(await hidden.find({ type: 'Button', key: 'pet' })).toBeUndefined()
    const shown = await $.ui.mount({ plugin: 'pet', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    expect(await shown.find({ type: 'Text', text: /\(=o\.o=\)/ })).toBeDefined()
    expect(await shown.find({ type: 'Button', key: 'pet' })).toBeDefined()
  })

  test('off means off', { options: { enabled: false } }, async ($, on) => {
    engine(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['only the rest'] }) as never)
    await start($)
    const ui = await $.ui.mount({ plugin: 'pet', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ type: 'Button', key: 'pet' })).toBeUndefined()
  })

  test('/pet name renames it', async ($, on) => {
    engine(on)
    await start($)
    const r = await $.command.run({ command: 'pet', args: 'name Biscuit' } as never)
    expect(r.text).toContain('Biscuit')
    expect((await $.command.run({ command: 'pet', args: '' } as never)).text).toContain('Biscuit: level 1')
  })
})
