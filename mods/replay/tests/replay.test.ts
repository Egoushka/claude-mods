import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { clipHunk, diffOps, splitLines, toHunks, unifiedDiff } from '../hooks/diff'

const lines = (n: number, f = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n'

describe('diff', () => {
  test('a changed line in the middle becomes one hunk with three lines of context', () => {
    const before = lines(20)
    const after = lines(20, i => (i === 10 ? 'changed' : `line ${i}`))
    const d = unifiedDiff(before, after, 10000)
    expect(d.diff.split('\n')).toEqual(['@@ -7,7 +7,7 @@', ' line 7', ' line 8', ' line 9', '-line 10', '+changed', ' line 11', ' line 12', ' line 13'])
    expect([d.added, d.removed, d.omitted]).toEqual([1, 1, 0])
  })

  test('distant changes make separate hunks, near ones merge', () => {
    const a = lines(40)
    const far = lines(40, i => (i === 3 || i === 35 ? 'x' : `line ${i}`))
    expect(toHunks(diffOps(splitLines(a), splitLines(far))).length).toBe(2)
    const near = lines(40, i => (i === 10 || i === 15 ? 'x' : `line ${i}`))
    expect(toHunks(diffOps(splitLines(a), splitLines(near))).length).toBe(1)
  })

  test('new and emptied files', () => {
    expect(unifiedDiff('', 'a\nb\n', 1000).diff).toBe('@@ -0,0 +1,2 @@\n+a\n+b')
    expect(unifiedDiff('a\nb\n', '', 1000).diff).toBe('@@ -1,2 +0,0 @@\n-a\n-b')
    expect(unifiedDiff('same\n', 'same\n', 1000).diff).toBe('')
  })

  test('insertions keep their line numbers', () => {
    expect(unifiedDiff('a\nb\nc\n', 'a\nb\nnew\nc\n', 1000).diff).toBe('@@ -1,3 +1,4 @@\n a\n b\n+new\n c')
  })

  test('a big diff keeps whole hunks and counts the rest; a huge hunk is clipped but still parses', () => {
    const a = lines(400)
    const b = lines(400, i => (i % 40 === 0 ? 'x' : `line ${i}`))
    const d = unifiedDiff(a, b, 600)
    expect(d.omitted).toBeGreaterThan(0)
    expect(d.diff.startsWith('@@')).toBe(true)
    const big = unifiedDiff('', lines(5000), 400)
    expect(big.omitted).toBe(1)
    expect(big.diff.length).toBeLessThan(600)
    expect(big.diff.split('\n')[0]).toMatch(/^@@ -0,0 \+1,\d+ @@$/)
    expect(clipHunk('not a hunk', 5)).toBe('not a hunk')
  })
})

// A tiny file system the test's tools write to; what the plugin reads through $.fs comes from here.
function engine(on: On, files: Map<string, string>) {
  on('session.start', ($, e) => e)
  on('session.end', ($, e) => e)
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('fs.stat', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) return { deny: 'ENOENT' } as never
    return { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } } as never
  })
  on('fs.read', ($, e) => ({ value: files.get(e.path) ?? '' }) as never)
  on('tool.call', ($, e) => {
    const input = e as unknown as { tool: string; file_path: string; old_string?: string; new_string?: string; content?: string }
    if (input.file_path.includes('boom')) return { result: 'failed', isError: true } as never
    if (input.tool === 'Write') files.set(input.file_path, input.content ?? '')
    else files.set(input.file_path, (files.get(input.file_path) ?? '').replace(input.old_string ?? '', input.new_string ?? ''))
    return { result: 'ok' } as never
  })
}

const START = { cwd: '/home/me/app', surface: null, isInteractive: true } as const
const PANE = { title: 'Replay', isFocused: true, bodyColumns: 80, placement: 'dock' } as never
const turn = ($: { turn: { start: (e: { text: string; turnId: string }) => Promise<unknown> } }, n: number) => $.turn.start({ text: `t${n}`, turnId: `t${n}` })

describe('hooks', () => {
  test('records edits and writes per turn and scrubs between them', async ($, on) => {
    const files = new Map<string, string>([['/home/me/app/a.ts', lines(10)]])
    engine(on, files)
    await $.session.start(START)
    await turn($, 1)
    await $.tool.call({ tool: 'Edit', file_path: '/home/me/app/a.ts', old_string: 'line 5', new_string: 'five' } as never)
    await $.tool.call({ tool: 'Write', file_path: '/home/me/app/new.ts', content: 'export {}\n' } as never)
    await turn($, 2)
    await $.tool.call({ tool: 'Edit', file_path: '/home/me/app/a.ts', old_string: 'line 9', new_string: 'nine' } as never)
    await $.tool.call({ tool: 'Edit', file_path: '/home/me/app/boom.ts', old_string: 'x', new_string: 'y' } as never)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'replay', surface, component: 'Pane', requestId: 'replay', props: PANE })
      // It opens on the latest turn.
      expect(await ui.find({ type: 'Text', text: /turn 2 \(2 of 2\)/ })).toBeDefined()
      const latest = await ui.findAll({ type: 'Code' })
      expect(latest.length).toBe(1)
      expect(latest[0]?.props.format).toBe('diff')
      expect(String(latest[0]?.props.source)).toContain('+nine')
      // Back one turn: the edit and the new file of turn 1.
      await ui.press({ key: 'prev' })
      const first = await ui.findAll({ type: 'Code' })
      expect(first.map(c => c.props.path)).toEqual(['a.ts', 'new.ts'])
      expect(String(first[0]?.props.source)).toContain('+five')
      expect(String(first[1]?.props.source)).toBe('@@ -0,0 +1,1 @@\n+export {}')
      // The edge holds; forward returns.
      await ui.press({ key: 'prev' })
      expect(await ui.find({ type: 'Text', text: /turn 1 \(1 of 2\)/ })).toBeDefined()
      await ui.press({ key: 'next' })
      expect(await ui.find({ type: 'Text', text: /turn 2 \(2 of 2\)/ })).toBeDefined()
      // The turn strip jumps; the view is shared state, so leave it on the latest turn for the next surface.
      await ui.press({ key: 'turn:1' })
      expect(await ui.find({ type: 'Text', text: /turn 1/ })).toBeDefined()
      await ui.press({ key: 'turn:2' })
      await ui.unmount()
    }
  })

  test('keeps only the last N changes', { options: { maxChanges: 2 } }, async ($, on) => {
    const files = new Map<string, string>([['/home/me/app/a.ts', 'a\n']])
    engine(on, files)
    await $.session.start(START)
    for (const n of [1, 2, 3]) {
      await turn($, n)
      await $.tool.call({ tool: 'Write', file_path: '/home/me/app/a.ts', content: `v${n}\n` } as never)
    }
    const ui = await $.ui.mount({ plugin: 'replay', surface: 'terminal', component: 'Pane', requestId: 'replay', props: PANE })
    expect(await ui.find({ type: 'Text', text: /turn 3 \(2 of 2\)/ })).toBeDefined()
    await ui.press({ key: 'prev' })
    expect(await ui.find({ type: 'Text', text: /turn 2 \(1 of 2\)/ })).toBeDefined()
  })

  test('says so when nothing changed yet', async ($, on) => {
    engine(on, new Map())
    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: 'replay', surface: 'terminal', component: 'Pane', requestId: 'replay', props: PANE })
    expect(await ui.find({ type: 'Text', text: /No file changes yet/ })).toBeDefined()
  })
})
