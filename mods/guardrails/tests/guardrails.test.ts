import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { boundaryDenial, compile, touchesBoundary, irreversibleKind, maskSecrets, repoFromRemote, shellCorrection } from '../hooks/rules'

describe('rules', () => {
  test('masks known secret shapes and keeps placeholders', () => {
    const fake = 'ghp_' + 'a'.repeat(36)
    const m = maskSecrets(`token ${fake}\nAPI_KEY=supersecretvalue1\nPASSWORD=\${PASSWORD}`)
    expect(m.count).toBe(2)
    expect(m.text).toContain('[masked:github]')
    expect(m.text).toContain('API_KEY=[masked:assignment]')
    expect(m.text).toContain('PASSWORD=${PASSWORD}')
  })

  test('code that reads a secret is not masked; env-style assignments are', () => {
    expect(maskSecrets('const tokens = context.tokens').count).toBe(0)
    expect(maskSecrets('export const savedTokens = (sections) => x').count).toBe(0)
    expect(maskSecrets('const TOKEN = process.env.GH_TOKEN').count).toBe(0)
    expect(maskSecrets('GH_TOKEN=abcd1234efgh5678').text).toBe('GH_TOKEN=[masked:assignment]')
  })

  test('flags irreversible commands and leaves safe ones', () => {
    expect(irreversibleKind('git push --force origin main')).toBe('force push')
    expect(irreversibleKind('git push origin main')).toBeUndefined()
    expect(irreversibleKind('rm -rf src')).toBe('recursive delete')
    expect(irreversibleKind('rm -rf node_modules')).toBeUndefined()
    expect(irreversibleKind('psql -c "DROP TABLE users"')).toBe('sql drop')
  })

  test('shell corrections', () => {
    expect(shellCorrection('cd repo && gh pr view 3').cdGh).toEqual({ dir: 'repo', gh: 'gh pr view 3' })
    expect(shellCorrection('gh pr list | jq .').deny).toContain('--jq')
    expect(shellCorrection('timeout 30 npm test').fix?.command).toBe('npm test')
    expect(shellCorrection("echo === done").fix?.command).toBe("echo '===' done")
    expect(shellCorrection('ls -la')).toEqual({})
  })

  test('boundary', () => {
    const b = { fencedTools: compile('^mcp__personal__'), fencedHosts: compile('example\\.home'), insideOnlyTools: compile('^mcp__work__write') }
    expect(boundaryDenial(b, true, 'mcp__personal__notes', {})).toBeDefined()
    expect(boundaryDenial(b, true, 'WebFetch', { url: 'https://example.home/x' })).toBeDefined()
    expect(boundaryDenial(b, true, 'Read', {})).toBeUndefined()
    expect(boundaryDenial(b, false, 'mcp__work__write', {})).toBeDefined()
    expect(boundaryDenial(b, false, 'mcp__personal__notes', {})).toBeUndefined()
  })

  test('a built-in tool naming a path under the boundary marks the session', () => {
    const paths = compile('/Projects/work(/|$)')
    expect(touchesBoundary(paths, 'Read', { file_path: '/Users/me/Projects/work/app/a.cs' })).toBe(true)
    expect(touchesBoundary(paths, 'Bash', { command: 'ls "/Users/me/Projects/work" && git status' })).toBe(true)
    expect(touchesBoundary(paths, 'Glob', { path: '/Users/me/Projects/personal', pattern: '*.md' })).toBe(false)
    expect(touchesBoundary(paths, 'mcp__personal__notes', { query: '/Users/me/Projects/work/app' })).toBe(false)
    expect(touchesBoundary(paths, 'Read', { file_path: '/Users/me/My Projects/work/a.cs' })).toBe(false)
    expect(touchesBoundary(compile('/work/'), 'Read', { file_path: '/Users/me/My Files/work/a.cs' })).toBe(true)
    expect(touchesBoundary(paths, 'Edit', { edits: [{ file_path: '/Users/me/Projects/work/a.cs' }] })).toBe(true)
    expect(touchesBoundary(undefined, 'Read', { file_path: '/Users/me/Projects/work/a' })).toBe(false)
  })

  test('repo from remote', () => {
    expect(repoFromRemote('git@github.com:acme/app.git\n')).toBe('acme/app')
    expect(repoFromRemote('https://github.com/acme/app')).toBe('acme/app')
  })
})

// What the engine answers beneath the plugin in a session.
function engine(on: On) {
  on('session.start', ($, e) => e)
  on('ui.status', ($, e) => ({ value: e }) as never)
}

describe('hooks', () => {
  test('a fenced session cannot call a fenced tool', { options: { boundaryPaths: '/work/', fencedTools: '^mcp__personal__' } }, async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: 'ran' }) as never)
    await $.session.start({ cwd: '/home/me/work/app', surface: null, isInteractive: true })
    const r = await $.tool.call({ tool: 'mcp__personal__notes' } as never)
    expect(JSON.stringify(r)).toContain('outside this session')
  })

  const fence = { boundaryPaths: '/Projects/work(/|$)', fencedTools: '^mcp__personal__' }

  test('a session that started outside is fenced once it touches a path inside', { options: fence }, async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: 'ran' }) as never)
    await $.session.start({ cwd: '/Users/me/Projects', surface: null, isInteractive: true })
    expect(JSON.stringify(await $.tool.call({ tool: 'mcp__personal__notes' } as never))).toContain('ran')
    await $.tool.call({ tool: 'Read', file_path: '/Users/me/Projects/work/app/a.cs' } as never)
    expect(JSON.stringify(await $.tool.call({ tool: 'mcp__personal__notes' } as never))).toContain('outside this session')
  })

  test('a new session start forgets that mark', { options: fence }, async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: 'ran' }) as never)
    await $.session.start({ cwd: '/Users/me/Projects', surface: null, isInteractive: true })
    await $.tool.call({ tool: 'Read', file_path: '/Users/me/Projects/work/app/a.cs' } as never)
    await $.session.start({ cwd: '/Users/me/Projects/personal', surface: null, isInteractive: true })
    expect(JSON.stringify(await $.tool.call({ tool: 'mcp__personal__notes' } as never))).toContain('ran')
  })

  test('a fenced tool is stopped when the session folder is unknown', { options: fence }, async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: 'ran' }) as never)
    expect(JSON.stringify(await $.tool.call({ tool: 'mcp__personal__notes' } as never))).toContain('outside this session')
  })

  test('an inside-only tool is also stopped when the folder is unknown', { options: { ...fence, insideOnlyTools: '^mcp__work__write' } }, async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: 'ran' }) as never)
    expect(JSON.stringify(await $.tool.call({ tool: 'mcp__work__write' } as never))).toContain('folder is unknown')
  })

  test('an inside-only tool works once a session has entered the boundary', { options: { ...fence, insideOnlyTools: '^mcp__work__write' } }, async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: 'ran' }) as never)
    await $.session.start({ cwd: '/Users/me/Projects', surface: null, isInteractive: true })
    expect(JSON.stringify(await $.tool.call({ tool: 'mcp__work__write' } as never))).toContain('may be called only from inside')
    await $.tool.call({ tool: 'Read', file_path: '/Users/me/Projects/work/a.cs' } as never)
    expect(JSON.stringify(await $.tool.call({ tool: 'mcp__work__write' } as never))).toContain('ran')
  })

  test('without a boundary nothing is fenced', async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: 'ran' }) as never)
    expect(JSON.stringify(await $.tool.call({ tool: 'mcp__personal__notes' } as never))).toContain('ran')
  })

  test('the loop breaker stops the fourth identical failure', async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: 'boom', isError: true }) as never)
    await $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })
    for (let i = 0; i < 3; i += 1) await $.tool.call({ tool: 'Bash', command: 'make test' } as never)
    const r = await $.tool.call({ tool: 'Bash', command: 'make test' } as never)
    expect(JSON.stringify(r)).toContain('failed 3 times')
  })
})
