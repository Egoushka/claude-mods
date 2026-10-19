import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { accrue, dayKey, fmtDuration, goalLine, mergeTarget, repoFromRemote, slugify, summarize, toCsv, weekStartKey } from '../hooks/time'

// 2026-10-21 is a Wednesday; local-time constructors keep the test independent of the time zone.
const WED = new Date(2026, 9, 21, 12, 0, 0).getTime()
const H = 3600000

describe('time helpers', () => {
  test('keys days and weeks in local time', () => {
    expect(dayKey(WED)).toBe('2026-10-21')
    expect(weekStartKey(WED)).toBe('2026-10-19')
    expect(weekStartKey(new Date(2026, 9, 25, 9).getTime())).toBe('2026-10-19')
  })

  test('sums today, week and month per repo', () => {
    let hours = accrue({}, '/r/app', '2026-10-21', 2 * H)
    hours = accrue(hours, '/r/app', '2026-10-19', H)
    hours = accrue(hours, '/r/app', '2026-10-02', 3 * H)
    hours = accrue(hours, '/r/app', '2026-09-30', 9 * H)
    hours = accrue(hours, '/r/lib', '2026-10-21', H / 2)
    const { rows, total } = summarize(hours, WED)
    expect(rows[0]).toEqual({ repo: '/r/app', today: 2 * H, week: 3 * H, month: 6 * H })
    expect(total.month).toBe(6.5 * H)
  })

  test('drops days older than a year', () => {
    const hours = accrue({ '/r/app': { '2025-01-01': H } }, '/r/app', '2026-10-21', H)
    expect(Object.keys(hours['/r/app'] ?? {})).toEqual(['2026-10-21'])
  })

  test('goal line and durations', () => {
    expect(goalLine(42 * H, WED, 750, 60000, 'UAH')).toBe('Oct: 42h ≈ 31.5k UAH of 60k')
    expect(goalLine(42 * H, WED, 0, 60000, 'UAH')).toBeUndefined()
    expect(goalLine(42 * H, WED, 750, 0, 'UAH')).toBeUndefined()
    expect(fmtDuration(5 * 60000)).toBe('5m')
    expect(fmtDuration(65 * 60000)).toBe('1h 05m')
  })

  test('csv', () => {
    expect(toCsv({ '/r/a,b': { '2026-10-21': 1.5 * H } })).toBe('repo,day,hours\n"/r/a,b",2026-10-21,1.50\n')
  })

  test('reads the pull request out of a gh pr merge command', () => {
    expect(mergeTarget('gh pr merge 12 --squash --delete-branch')).toEqual({ selector: '12', isAuto: false })
    expect(mergeTarget('git push && gh pr merge --auto -R a/b feature')).toEqual({ selector: 'feature', repo: 'a/b', isAuto: true })
    expect(mergeTarget('gh pr view 12')).toBeUndefined()
    expect(repoFromRemote('git@github.com:acme/app.git\n')).toBe('acme/app')
    expect(slugify('Add: the /hours pane!')).toBe('add-the-hours-pane')
  })
})

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never

type Calls = { writes: Map<string, string>; toasts: string[]; copies: string[]; prompts: string[] }

// What the engine answers beneath the plugin in a session.
function engine(on: On, pr: { state: string } = { state: 'MERGED' }): Calls {
  const calls: Calls = { writes: new Map(), toasts: [], copies: [], prompts: [] }
  on('session.start', ($, e) => e)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', ($, e) => (calls.toasts.push(e.text), { value: undefined }) as never)
  on('ui.copy', ($, e) => (calls.copies.push(e.text), { value: { isCopied: true } }) as never)
  on('fs.write', ($, e) => (calls.writes.set(e.path, e.text), { value: undefined }) as never)
  on('model.complete', ($, e) => (calls.prompts.push(e.prompt), { value: { isAnswered: true, text: 'Shipped the hours pane.', usage: {} } }) as never)
  on('process.run', ($, e) => {
    const cmd = e.argv.join(' ')
    if (cmd.includes('rev-parse')) return ok('/home/me/app\n')
    if (cmd.includes('remote get-url')) return ok('git@github.com:me/app.git\n')
    if (cmd.includes('pr view')) return ok(JSON.stringify({ title: 'Add hours pane', body: 'Tracks time.', url: 'https://github.com/me/app/pull/7', state: pr.state }))
    return ok('')
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('prompt.submit', ($, e) => e as never)
  return calls
}

const start = ($: Parameters<Parameters<typeof test>[1]>[0]) => $.session.start({ cwd: '/home/me/app/src', surface: null, isInteractive: true })

describe('hooks', () => {
  test('counts turns and short gaps, not long idle', async ($, on) => {
    engine(on)
    const clock = mock.clock(on, { now: WED })
    mock.store(on)
    await start($)
    const turn = async (ms: number) => {
      await $.turn.start({ text: 'x', turnId: 't' })
      await clock.advance(ms)
      await $.turn.complete({ answer: '', durationMs: ms, isAborted: false, turnId: 't', reason: 'answer' } as never)
    }
    await $.prompt.submit({ text: 'first' })
    await turn(10 * 60000)
    await clock.advance(4 * 60000)
    await $.prompt.submit({ text: 'second' })
    await turn(5 * 60000)
    await clock.advance(30 * 60000)
    await $.prompt.submit({ text: 'third, after a long break' })
    // 10m turn + 4m gap + 5m turn; the 30m break is idle.
    const ui = await $.ui.mount({ plugin: 'ledger', surface: 'terminal', component: 'Pane', requestId: 'hours', props: { title: 'Hours', isFocused: false, bodyColumns: 70, placement: 'inline' } as never })
    expect(await ui.find({ type: 'Text', text: /^app\s+19m\s+19m\s+19m/ })).toBeDefined()
  })

  test('the pane shows the table and the goal line', { options: { hourlyRate: 750, monthlyGoal: 60000, currency: 'UAH' } }, async ($, on) => {
    engine(on)
    mock.clock(on, { now: WED })
    mock.store(on, { hours: { '/home/me/app': { [dayKey(WED)]: 2 * H } } })
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'ledger', surface, component: 'Pane', requestId: 'hours', props: { title: 'Hours', isFocused: false, bodyColumns: 70, placement: 'inline' } as never })
      expect((await ui.find({ type: 'Text', text: /Oct: 2h/ }))?.text).toBe('Oct: 2h ≈ 1.5k UAH of 60k')
      expect(await ui.find({ type: 'Text', text: /^app\s+2h 00m/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('export copies the CSV when no path is set, writes it when one is', async ($, on) => {
    const calls = engine(on)
    mock.clock(on, { now: WED })
    mock.store(on, { hours: { '/home/me/app': { '2026-10-21': H } } })
    await start($)
    const ui = await $.ui.mount({ plugin: 'ledger', surface: 'terminal', component: 'Pane', requestId: 'hours', props: { title: 'Hours', isFocused: false, bodyColumns: 70, placement: 'inline' } as never })
    await ui.press({ key: 'export' })
    expect(calls.copies[0]).toContain('/home/me/app,2026-10-21,1.00')
  })

  test('export writes to the configured path', { options: { csvPath: '/tmp/ledger/hours.csv' } }, async ($, on) => {
    const calls = engine(on)
    mock.clock(on, { now: WED })
    mock.store(on, { hours: { '/home/me/app': { '2026-10-21': H } } })
    await start($)
    const ui = await $.ui.mount({ plugin: 'ledger', surface: 'terminal', component: 'Pane', requestId: 'hours', props: { title: 'Hours', isFocused: false, bodyColumns: 70, placement: 'inline' } as never })
    await ui.press({ key: 'export' })
    expect(calls.writes.get('/tmp/ledger/hours.csv')).toContain('2026-10-21,1.00')
  })

  const drafting = { options: { publicRepos: '^me/app$', draftsDir: '/home/me/drafts' } }

  test('a merged pull request in a public repo becomes a draft on disk', drafting, async ($, on) => {
    const calls = engine(on)
    const clock = mock.clock(on, { now: WED })
    mock.store(on)
    on('tool.call', () => ({ result: 'merged' }) as never)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'gh pr merge 7 --squash' } as never)
    await clock.advance(10)
    const [path, text] = [...calls.writes.entries()][0] ?? []
    expect(path).toMatch(/^\/home\/me\/drafts\/2026-10-21T.*-add-hours-pane\.md$/)
    expect(text).toContain('Shipped the hours pane.')
    expect(calls.prompts[0]).toContain('Add hours pane')
    expect(calls.toasts.some(t => t.includes('post drafted at'))).toBe(true)
  })

  test('nothing is drafted for a repo that does not match, a failed merge or a pull request still open', drafting, async ($, on) => {
    const calls = engine(on, { state: 'OPEN' })
    const clock = mock.clock(on, { now: WED })
    mock.store(on)
    on('tool.call', ($, e) => ({ result: 'x', isError: (e as { command: string }).command.includes('fail') || undefined }) as never)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'gh pr merge 7' } as never)
    await $.tool.call({ tool: 'Bash', command: 'gh pr merge 8 --fail' } as never)
    await clock.advance(10)
    expect(calls.writes.size).toBe(0)
  })

  test('drafting is off by default', async ($, on) => {
    const calls = engine(on)
    const clock = mock.clock(on, { now: WED })
    mock.store(on)
    on('tool.call', () => ({ result: 'merged' }) as never)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'gh pr merge 7' } as never)
    await clock.advance(10)
    expect(calls.prompts.length).toBe(0)
  })
})
