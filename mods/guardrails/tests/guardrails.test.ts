import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { boundaryDenial, compile, irreversibleKind, maskSecrets, repoFromRemote, shellCorrection } from '../hooks/rules'

describe('rules', () => {
  test('masks known secret shapes and keeps placeholders', () => {
    const fake = 'ghp_' + 'a'.repeat(36)
    const m = maskSecrets(`token ${fake}\nAPI_KEY=supersecretvalue1\nPASSWORD=\${PASSWORD}`)
    expect(m.count).toBe(2)
    expect(m.text).toContain('[masked:github]')
    expect(m.text).toContain('API_KEY=[masked:assignment]')
    expect(m.text).toContain('PASSWORD=${PASSWORD}')
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

  test('the loop breaker stops the fourth identical failure', async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: 'boom', isError: true }) as never)
    await $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })
    for (let i = 0; i < 3; i += 1) await $.tool.call({ tool: 'Bash', command: 'make test' } as never)
    const r = await $.tool.call({ tool: 'Bash', command: 'make test' } as never)
    expect(JSON.stringify(r)).toContain('failed 3 times')
  })
})
