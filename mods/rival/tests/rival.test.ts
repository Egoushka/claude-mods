import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { RivalFinding } from '../types'
import { buildTask, changedLines, fixPrompt, hashText, isReviewerBash, parseFindings } from '../hooks/review'

const DIFF = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,3 @@', ' keep', '-old', '+new', '+added'].join('\n')

describe('review helpers', () => {
  test('counts changed lines and skips file headers', () => {
    expect(changedLines(DIFF)).toBe(3)
    expect(changedLines('')).toBe(0)
  })

  test('hash differs when the stat differs', () => {
    expect(hashText('a | 2 +-')).toBe(hashText('a | 2 +-'))
    expect(hashText('a | 2 +-')).not.toBe(hashText('a | 3 +--'))
  })

  test('the reviewer may run git diff, log, show, grep and blame and nothing else', () => {
    expect(isReviewerBash('git diff HEAD -- src/a.ts')).toBe(true)
    expect(isReviewerBash('git -C /repo log -n 5 --oneline')).toBe(true)
    expect(isReviewerBash('git show HEAD~1')).toBe(true)
    expect(isReviewerBash('git push origin main')).toBe(false)
    expect(isReviewerBash('git diff HEAD; rm -rf .')).toBe(false)
    expect(isReviewerBash('git diff HEAD | sh')).toBe(false)
    expect(isReviewerBash('git diff --output=x.patch')).toBe(false)
    expect(isReviewerBash('git log -c core.pager=sh')).toBe(false)
    expect(isReviewerBash('cat /etc/passwd')).toBe(false)
    expect(isReviewerBash('git -C /repo grep -n parseFindings')).toBe(true)
    expect(isReviewerBash('git blame -L 10,20 src/a.ts')).toBe(true)
    expect(isReviewerBash('cd /repo && git grep x')).toBe(false)
    expect(isReviewerBash('git grep -Ovim x')).toBe(false)
    expect(isReviewerBash('git grep --open-files-in-pager=sh x')).toBe(false)
  })

  test('parses findings from fenced or bare JSON, drops low confidence, sorts', () => {
    const answer = [
      'Looked at it.',
      '```json',
      JSON.stringify({
        findings: [
          { file: 'a.ts', line: 3, title: 'low', scenario: 's', confidence: 30 },
          { file: 'b.ts', line: 9, title: 'null deref', scenario: 'x is undefined when y', confidence: 70 },
          { file: 'c.ts', line: 1, title: 'fraction', scenario: 's', confidence: 0.9 },
          { title: 'no file' },
        ],
      }),
      '```',
    ].join('\n')
    const found = parseFindings(answer, 50)
    expect(found?.map(f => f.file)).toEqual(['c.ts', 'b.ts'])
    expect(found?.[0]?.confidence).toBe(90)
    expect(parseFindings('{"findings":[]}', 50)).toEqual([])
    expect(parseFindings('no json here', 50)).toBeUndefined()
  })

  test('the task carries the diff and the fix prompt quotes each finding', () => {
    expect(buildTask(DIFF)).toContain('+added')
    const prompt = fixPrompt([{ file: 'b.ts', line: 9, title: 'null deref', scenario: 'x is undefined', confidence: 70 }])
    expect(prompt).toContain('b.ts:9')
    expect(prompt).toContain('Verify each one')
  })
})

const GIT_STAT = ' a.ts | 3 ++-\n 1 file changed\n'
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0 }, view: {} } as never
const PANE = { title: 'rival', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0 }, view: {} } as never
const DONE = {
  findings: [{ file: 'a.ts', line: 2, title: 'off by one', scenario: 'n=0 reads index -1', confidence: 80 }] satisfies RivalFinding[],
}

// What the engine answers beneath the plugin. `gate` holds spawn() open so a second turn can race it.
function engine(on: On, spawned: string[], gate?: Promise<void>, now = () => 1000, stat = () => GIT_STAT) {
  on('session.start', ($, e) => e)
  on('clock.now', () => ({ value: now() }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('agent.list', () => ({ value: [{ id: 'agent-1', type: 'rival:reviewer', status: 'running', description: '' }] }) as never)
  on('agent.register', () => ({ value: { agent: 'rival:reviewer' } }) as never)
  on('ui.render', ($, e) => ($.ui.resolve(e).Box as (p: object) => never)({}))
  on('process.run', (_$, e) => {
    const isStat = (e as unknown as { argv: string[] }).argv.includes('--stat')
    const value = { exitCode: 0, stdout: isStat ? stat() : DIFF, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    return { value } as never
  })
  on('agent.spawn', async (_$, e) => {
    spawned.push(e.prompt)
    await gate
    return { model: 'sonnet', agentId: 'agent-1' } as never
  })
}

const turn = (id: string) => ({ answer: 'done', durationMs: 1, isAborted: false, turnId: id, reason: 'answer' }) as never
const start = ($: { session: { start: (a: never) => Promise<unknown> } }) =>
  $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true } as never)

describe('hooks', () => {
  test('a turn that changed the diff spawns a review on that diff', { options: { minLines: 2 } }, async ($, on) => {
    const spawned: string[] = []
    engine(on, spawned)
    await start($)
    await $.turn.complete(turn('t1'))
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toContain('+added')
  })

  test('at most one review is started at a time', { options: { minLines: 2 } }, async ($, on) => {
    const spawned: string[] = []
    let open = () => {}
    engine(on, spawned, new Promise<void>(resolve => (open = resolve)))
    await start($)
    const first = $.turn.complete(turn('t1'))
    const second = $.turn.complete(turn('t2'))
    open()
    await Promise.all([first, second])
    expect(spawned).toHaveLength(1)
  })

  test('a changed diff inside the cooldown waits for the next turn after it', { options: { minLines: 2, cooldownMinutes: 10 } }, async ($, on) => {
    const spawned: string[] = []
    let time = 1000
    let stat = GIT_STAT
    engine(on, spawned, undefined, () => time, () => stat)
    await start($)
    await $.turn.complete(turn('t1'))
    await $.turn.complete({ ...(turn('r1') as object), answer: '{"findings":[]}', agentId: 'agent-1' } as never)
    stat = ' a.ts | 5 ++++-\n 1 file changed\n'
    time += 60_000
    await $.turn.complete(turn('t2'))
    expect(spawned).toHaveLength(1)
    time += 10 * 60_000
    await $.turn.complete(turn('t3'))
    expect(spawned).toHaveLength(2)
  })

  test('the same diff is not reviewed twice, and a small one is skipped', { options: { minLines: 50 } }, async ($, on) => {
    const spawned: string[] = []
    engine(on, spawned)
    await start($)
    await $.turn.complete(turn('t1'))
    await $.turn.complete(turn('t2'))
    expect(spawned).toHaveLength(0)
  })

  test('the reviewer is read-only and may run git diff only', { options: { minLines: 2 } }, async ($, on) => {
    const spawned: string[] = []
    let open = () => {}
    engine(on, spawned, new Promise<void>(resolve => (open = resolve)))
    on('tool.call', () => ({ result: 'ran' }) as never)
    await start($)
    const turnDone = $.turn.complete(turn('t1'))
    while (spawned.length === 0) await Promise.resolve()
    const asReviewer = (call: object) => $.tool.call({ ...call, agentId: 'agent-1' } as never)
    expect(JSON.stringify(await asReviewer({ tool: 'Bash', command: 'rm -rf /' }))).toContain('git diff')
    expect(JSON.stringify(await asReviewer({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' }))).toContain('read-only')
    expect(JSON.stringify(await asReviewer({ tool: 'Bash', command: 'git diff HEAD' }))).toContain('ran')
    open()
    await turnDone
    // Once the id is known the guard follows it, and the main thread stays free.
    expect(JSON.stringify(await asReviewer({ tool: 'Bash', command: 'git push' }))).toContain('git diff')
    expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'rm -rf /tmp/x' } as never))).toContain('ran')
  })

  test('a finished review reaches the band', { options: { minLines: 2 } }, async ($, on) => {
    engine(on, [])
    await start($)
    await $.turn.complete(turn('t1'))
    const reply = '{"findings":[{"file":"a.ts","line":2,"title":"off by one","scenario":"n=0","confidence":80}]}'
    await $.turn.complete({ ...(turn('t2') as object), answer: reply, agentId: 'agent-1' } as never)
    const band = await $.ui.mount({ plugin: 'rival', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(JSON.stringify(await band.findAll({ type: 'Text' }))).toContain('1 finding')
  })

  test('the reviewer is not offered to the model', async ($, on) => {
    engine(on, [])
    await start($)
    const offer = await $.agent.offer({ agent: 'rival:reviewer', description: 'x', source: 'plugin', provider: { plugin: 'rival', tier: 'user' } } as never)
    expect(JSON.stringify(offer)).toContain('false')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`findings show in the band, a pane and a fix prompt (${surface})`, { options: { minLines: 2 } }, async ($, on) => {
      const submitted: string[] = []
      engine(on, [])
      on('prompt.submit', (_$, e) => (submitted.push(e.text), { text: e.text }) as never)
      on('ui.open', () => ({ value: { isPlaced: true } }) as never)
      on('ui.close', () => ({ value: undefined }) as never)
      await start($)
      await $.turn.complete(turn('t1'))
      await $.turn.complete({ ...(turn('t2') as object), answer: JSON.stringify({ findings: DONE.findings }), agentId: 'agent-1' } as never)

      const band = await $.ui.mount({ plugin: 'rival', surface, component: 'AbovePrompt', props: BAND })
      expect(JSON.stringify(await band.findAll({ type: 'Text' }))).toContain('1 finding')

      const pane = await $.ui.mount({ plugin: 'rival', surface, component: 'Pane', props: PANE, requestId: 'rival' })
      expect(JSON.stringify(await pane.findAll({ type: 'Text' }))).toContain('a.ts:2')

      await band.press({ key: 'fix' })
      expect(submitted).toHaveLength(1)
      expect(submitted[0]).toContain('a.ts:2')
      expect(submitted[0]).toContain('Verify each one')
    })
  }
})
