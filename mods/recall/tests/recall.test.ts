import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { brief, describeCall, extractMemories, fillTemplate, likelyTests, mentionContext, nextCandidate, normalize, similarity, verbPrompt } from '../hooks/recall'

const block = (t: string) => ({ content: [{ type: 'text', text: t }], isError: false })

describe('helpers', () => {
  test('templates fill every string and reject non-objects', () => {
    expect(fillTemplate('{"q": "{{query}}", "n": {"deep": ["a {{query}}"]}, "k": 5}', 'query', 'x "y"')).toEqual({
      q: 'x "y"',
      n: { deep: ['a x "y"'] },
      k: 5,
    })
    expect(fillTemplate('not json', 'query', 'x')).toBeUndefined()
    expect(fillTemplate('[1]', 'query', 'x')).toBeUndefined()
  })

  test('memories from a JSON list, a wrapped list and plain bullets, capped', () => {
    expect(extractMemories(block('["one", {"text": "two"}]'), 100)).toEqual(['one', 'two'])
    expect(extractMemories(block('{"results": [{"memory": "m1"}, {"memory": "m2"}]}'), 100)).toEqual(['m1', 'm2'])
    expect(extractMemories(block('- first fact\n- second fact\n\nthird fact'), 100)).toEqual(['first fact', 'second fact', 'third fact'])
    const capped = extractMemories(block('- aaaaaaaaaa\n- bbbbbbbbbb\n- cccccccccc'), 15)
    expect(capped.length).toBe(2)
    expect(capped[1]?.endsWith('…')).toBe(true)
    expect(extractMemories({ content: [] }, 100)).toEqual([])
  })

  test('same-kind corrections are matched by word overlap', () => {
    expect(similarity('Always run the tests before committing', 'run tests before committing, always')).toBeGreaterThan(0.6)
    expect(similarity('Use tabs for indentation', 'Never push to main directly')).toBeLessThan(0.2)
    expect(normalize('Use  the TABS!')).toBe('use the tabs')
  })

  test('a rule candidate needs a second, open correction', () => {
    const g = (count: number, status: 'open' | 'dismissed') => ({ id: 'a', summary: 's', count, at: 0, status })
    expect(nextCandidate([g(1, 'open')])).toBeUndefined()
    expect(nextCandidate([g(2, 'dismissed')])).toBeUndefined()
    expect(nextCandidate([g(2, 'open')])?.id).toBe('a')
  })

  test('test files are found by name', () => {
    const files = ['src/foo.ts', 'src/foo.test.ts', 'tests/test_foo.py', 'src/FooTests.cs', 'src/foobar.ts', 'docs/foo.md', 'spec/foo_spec.rb']
    expect(likelyTests(files, 'src/foo.ts')).toEqual(['src/foo.test.ts', 'tests/test_foo.py', 'src/FooTests.cs', 'spec/foo_spec.rb'])
  })

  test('mention context lists only what was found', () => {
    expect(mentionContext('a.ts', [], [], [], 'a')).toBeUndefined()
    const c = mentionContext('a.ts', ['abc1 2026-01-01 fix'], ['a.test.ts'], [], 'a')
    expect(c).toContain('- abc1 2026-01-01 fix')
    expect(c).toContain('- a.test.ts')
    expect(c).not.toContain('git grep')
  })

  test('verb prompts quote the selection', () => {
    const p = verbPrompt('verify', 'line one\nline two', 'be strict')
    expect(p).toContain('> line one\n> line two')
    expect(p).toContain('be strict')
    expect(brief('a\n  b', 10)).toBe('a b')
  })
})

let lastSubmitted = ''

// What the engine answers beneath the plugin in a session.
function engine(on: On, classify = 'not-correcting') {
  mock.store(on)
  const clock = mock.clock(on)
  on('session.start', ($, e) => e)
  on('command.register', () => ({ value: { command: 'x' } }) as never)
  on('prompt.submit', (_$, e) => ((lastSubmitted = e.text), { text: e.text, context: e.context }) as never)
  on('session.messages', () => ({ value: [{ role: 'assistant', text: 'I edited the file', toolUses: [] }] }) as never)
  on('model.classify', () => ({ value: classify }) as never)
  return clock
}

const TYPED = { text: 'how does the cache work in this repo?', asUser: true } as const
const start = ($: Parameters<Parameters<typeof test>[1]>[0]) => $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })

describe('memory ghost', () => {
  test('is off with no memory server', async ($, on) => {
    engine(on)
    let calls = 0
    on('mcp.call', () => {
      calls += 1
      return { value: block('- a') } as never
    })
    await start($)
    const r = await $.prompt.submit(TYPED)
    expect(calls).toBe(0)
    expect(r.context).toBeUndefined()
  })

  test('adds recalled memories as context and fills the template', { options: { memoryServer: 'mem', recallTool: 'search', recallArgs: '{"q": "{{query}}", "limit": 3}' } }, async ($, on) => {
    engine(on)
    let seen: unknown
    on('mcp.call', (_$, e) => {
      seen = e
      return { value: block('- cache lives in Redis\n- TTL is 5 minutes') } as never
    })
    await start($)
    const r = await $.prompt.submit(TYPED)
    expect(seen).toEqual({ server: 'mem', tool: 'search', args: { q: TYPED.text, limit: 3 } })
    expect(r.context?.[0]).toContain('- cache lives in Redis')
    expect(r.context?.[0]).toContain('- TTL is 5 minutes')
  })

  test('a failing memory server does not block the prompt', { options: { memoryServer: 'mem' } }, async ($, on) => {
    engine(on)
    on('mcp.call', () => {
      throw new Error('down')
    })
    await start($)
    const r = await $.prompt.submit(TYPED)
    expect(r.text).toBe(TYPED.text)
    expect(r.context).toBeUndefined()
  })

  test('an error result adds nothing', { options: { memoryServer: 'mem' } }, async ($, on) => {
    engine(on)
    on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'boom' }], isError: true } }) as never)
    await start($)
    expect((await $.prompt.submit(TYPED)).context).toBeUndefined()
  })
  test('a prompt under minWords never calls the memory server', { options: { memoryServer: 'mem' } }, async ($, on) => {
    engine(on)
    let calls = 0
    on('mcp.call', () => {
      calls += 1
      return { value: block('- unrelated') } as never
    })
    await start($)
    const r = await $.prompt.submit({ ...TYPED, text: 'merge #877' })
    expect(calls).toBe(0)
    expect(r.context).toBeUndefined()
  })
})

describe('commands', () => {
  test('/verify with nothing selected says so and fills nothing', async ($, on) => {
    engine(on)
    on('ui.selection', () => ({ value: undefined }) as never)
    let filled = 0
    on('prompt.fill', () => {
      filled += 1
      return { isFilled: true, text: '' } as never
    })
    await start($)
    const r = await $.command.run({ command: 'verify', args: '' })
    expect(r.text).toContain('Nothing is selected')
    expect(filled).toBe(0)
  })

  test('/why quotes the selection into the prompt box', async ($, on) => {
    engine(on)
    on('ui.selection', () => ({ value: ({ text: 'use a mutex here' }) }) as never)
    on('prompt.read', () => ({ value: { text: '', cursor: 0 } }) as never)
    let fill: { text?: string } = {}
    on('prompt.fill', (_$, e) => {
      fill = e
      return { isFilled: true, text: e.text } as never
    })
    await start($)
    await $.command.run({ command: 'why', args: '' })
    expect(fill.text).toContain('> use a mutex here')
  })

  test('/remember without a retain server stores the text', async ($, on) => {
    engine(on)
    on('ui.selection', () => ({ value: ({ text: 'deploys go through the staging branch' }) }) as never)
    await start($)
    const r = await $.command.run({ command: 'remember', args: '' })
    expect(r.text).toContain('plugin store')
  })

  test('/remember calls the retain tool with the text', { options: { retainServer: 'mem', retainTool: 'save', retainArgs: '{"content": "{{text}}", "tag": "note"}' } }, async ($, on) => {
    engine(on)
    on('ui.selection', () => ({ value: ({ text: 'prefer small PRs' }) }) as never)
    let seen: unknown
    on('mcp.call', (_$, e) => {
      seen = e
      return { value: block('ok') } as never
    })
    await start($)
    const r = await $.command.run({ command: 'remember', args: '' })
    expect(seen).toEqual({ server: 'mem', tool: 'save', args: { content: 'prefer small PRs', tag: 'note' } })
    expect(r.text).toContain('Saved to mem')
  })
})

describe('friction', () => {
  test('a denied tool call is logged and /friction opens the pane', async ($, on) => {
    engine(on)
    on('tool.call', () => ({ deny: 'nope' }) as never)
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as never)
    const ui = await $.ui.mount({ plugin: 'recall', surface: 'terminal', component: 'Pane', requestId: 'recall-friction', props: {} } as never)
    expect((await ui.find({ type: 'Text', text: /denied: Bash rm -rf build: nope/ }))).toBeDefined()
    const r = await $.command.run({ command: 'friction', args: '' })
    expect(r.text).toContain('opened')
  })

  test('the second identical failure is logged', async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: 'boom', isError: true, text: 'boom' }) as never)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'make' } as never)
    await $.tool.call({ tool: 'Bash', command: 'make' } as never)
    const ui = await $.ui.mount({ plugin: 'recall', surface: 'terminal', component: 'Pane', requestId: 'recall-friction', props: {} } as never)
    expect(await ui.find({ type: 'Text', text: /errors: Bash make failed 2 times/ })).toBeDefined()
  })
})

describe('corrections', () => {
  test('the second matching correction raises a rule candidate', async ($, on) => {
    const clock = engine(on, 'correcting')
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['other plugin row'] }) as never)
    on('model.complete', () => ({ value: { isAnswered: true, text: 'Run the tests before committing', usage: {} } }) as never)
    await start($)
    const ask = (text: string) => $.prompt.submit({ text, asUser: true })
    await ask('no, you forgot to run the tests before committing')
    await clock.settle()
    await ask('again you committed without running the tests first')
    await clock.settle()
    const band = await $.ui.mount({ plugin: 'recall', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as never)
    expect(await band.find({ type: 'Text', text: /Rule candidate: Run the tests before committing/ })).toBeDefined()
    expect(await band.find({ text: /other plugin row/ })).toBeDefined()
    await band.press({ key: 'draft-rule' })
    await clock.settle()
    expect(lastSubmitted).toContain('Run the tests before committing')
    expect(lastSubmitted).toContain('CLAUDE.md')
    await band.unmount()
  })
})

describe('smart mentions', () => {
  const git: Record<string, string> = {
    'rev-parse': '/repo\n',
    log: 'abc1234 2026-10-01 fix cache ttl\ndef5678 2026-09-20 add cache\n',
    'ls-files': 'src/cache.ts\nsrc/cache.test.ts\nsrc/app.ts\n',
    grep: 'src/app.ts\n',
  }
  const stubGit = (on: On, ran: string[][]) =>
    on('process.run', (_$, e) => {
      const args = (e as unknown as { argv: string[] }).argv.slice(3)
      ran.push(args)
      return { value: { exitCode: 0, stdout: git[args[0] ?? ''] ?? '', stderr: '' } } as never
    })

  test('adds commits, tests and referencing files to the file the model reads', async ($, on) => {
    engine(on)
    const ran: string[][] = []
    stubGit(on, ran)
    on('prompt.mention', () => ({ type: 'file', context: ['existing'] }) as never)
    await start($)
    const r = await $.prompt.mention({ mention: 'src/cache.ts', path: '/repo/src/cache.ts' })
    const joined = (r.context ?? []).join('\n')
    expect(r.context?.[0]).toBe('existing')
    expect(joined).toContain('abc1234 2026-10-01 fix cache ttl')
    expect(joined).toContain('src/cache.test.ts')
    expect(joined).toContain('src/app.ts')
    expect(ran.find(a => a[0] === 'grep')).toContain('cache')
  })

  test('is off when switched off', { options: { smartMentions: false } }, async ($, on) => {
    engine(on)
    const ran: string[][] = []
    stubGit(on, ran)
    on('prompt.mention', () => ({ type: 'file' }) as never)
    await start($)
    const r = await $.prompt.mention({ mention: 'a.ts', path: '/repo/a.ts' })
    expect(r.context).toBeUndefined()
    expect(ran.length).toBe(0)
  })
})

describe('friction privacy', () => {
  test('secret-shaped values in a command are masked before they are logged', () => {
    const line = describeCall('Bash', { command: 'API_TOKEN=abc123456789 curl -H "Authorization: Bearer xyz987654321" x' })
    expect(line).not.toContain('abc123456789')
    expect(line).not.toContain('xyz987654321')
  })
})

describe('memory results that hold no memories', () => {
  test('an error wrapped in a gateway envelope yields nothing', () => {
    const wrapped = JSON.stringify({ result: JSON.stringify({ error: 'Failed to search memories: budget exceeded', results: [] }) })
    expect(extractMemories({ content: [{ type: 'text', text: wrapped }] }, 2000)).toEqual([])
  })

  test('JSON with an empty list yields nothing, a wrapped list is unwrapped', () => {
    expect(extractMemories({ content: [{ type: 'text', text: '{"results": []}' }] }, 2000)).toEqual([])
    const wrapped = JSON.stringify({ result: JSON.stringify({ results: [{ text: 'D-48: work memory is separate' }] }) })
    expect(extractMemories({ content: [{ type: 'text', text: wrapped }] }, 2000)).toEqual(['D-48: work memory is separate'])
  })
})
