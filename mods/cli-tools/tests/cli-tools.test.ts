import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { buildArgv, checkArgs, formatResult, inputSchema, parseTools } from '../hooks/lib'

const config = JSON.stringify([
  {
    name: 'logs',
    description: 'Tail the logs of a service',
    argv: ['svc', 'logs', '{{service}}', '--lines={{lines}}', '{{since}}'],
    params: {
      service: { type: 'string', description: 'Service name' },
      lines: { type: 'integer', description: 'How many lines', required: false },
      since: { type: 'string', description: 'Since', required: false },
    },
    timeoutMs: 5000,
  },
])

const tool = () => {
  const parsed = parseTools(config)
  if (!parsed.tools[0]) throw new Error('config did not parse')
  return parsed.tools[0]
}

describe('config', () => {
  test('parses a tool and builds its schema', () => {
    const t = tool()
    expect(t.timeoutMs).toBe(5000)
    expect(inputSchema(t)).toEqual({
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Service name' },
        lines: { type: 'integer', description: 'How many lines' },
        since: { type: 'string', description: 'Since' },
      },
      required: ['service'],
      additionalProperties: false,
    })
  })

  test('reports bad entries and keeps good ones', () => {
    const bad = parseTools(
      JSON.stringify([
        { name: 'bad name', description: 'x', argv: ['a'] },
        { name: 'ghost', description: 'x', argv: ['a', '{{nope}}'] },
        { name: 'ok', description: 'x', argv: ['a'] },
        { name: 'ok', description: 'again', argv: ['a'] },
      ]),
    )
    expect(bad.tools.map(t => t.name)).toEqual(['ok'])
    expect(bad.errors.length).toBe(3)
    expect(parseTools('not json').errors).toEqual(['tools: not valid JSON'])
    expect(parseTools('').tools).toEqual([])
  })
})

describe('arguments', () => {
  test('validates required, types, unknown and enum', () => {
    const t = tool()
    expect(checkArgs(t, {})).toEqual({ error: 'missing required parameter "service"' })
    expect(checkArgs(t, { service: 3 })).toEqual({ error: 'parameter "service" must be a string' })
    expect(checkArgs(t, { service: 'a', lines: 1.5 })).toEqual({ error: 'parameter "lines" must be an integer' })
    expect('error' in checkArgs(t, { service: 'a', extra: 1 })).toBe(true)
    expect(checkArgs(t, { service: 'a', lines: 20 })).toEqual({ values: { service: 'a', lines: '20' } })
  })

  test('fills placeholders, drops absent optionals and refuses option-looking values', () => {
    const t = tool()
    expect(buildArgv(t, { service: 'api', lines: '20' })).toEqual({ argv: ['svc', 'logs', 'api', '--lines=20'] })
    expect(buildArgv(t, { service: 'api' })).toEqual({ argv: ['svc', 'logs', 'api'] })
    expect('error' in buildArgv(t, { service: '--follow' })).toBe(true)
    const open = { ...t, params: { ...t.params, service: { ...t.params.service!, allowDash: true } } }
    expect(buildArgv(open, { service: '--follow' })).toEqual({ argv: ['svc', 'logs', '--follow'] })
  })

  test('refuses a value that starts an argument built from several placeholders', () => {
    const t = { ...tool(), argv: ['svc', '{{service}}={{lines}}'] }
    expect('error' in buildArgv(t, { service: '--exec', lines: '1' })).toBe(true)
    expect(buildArgv(t, { service: 'api', lines: '1' })).toEqual({ argv: ['svc', 'api=1'] })
  })

  test('shapes output with exit code and a cap', () => {
    expect(formatResult({ exitCode: 0, stdout: 'hi\n', stderr: '' }, 100)).toBe('exit code: 0\nstdout:\nhi')
    expect(formatResult({ exitCode: 1, stdout: '', stderr: '' }, 100)).toContain('(no output)')
    expect(formatResult({ exitCode: 0, stdout: 'x'.repeat(50), stderr: '' }, 10)).toContain('[cut: 40 more characters]')
  })
})

function engine(on: On) {
  on('session.start', ($, e) => e)
  on('tool.register', (_$, e) => ({ value: { tool: e.tool } }) as never)
  on('command.register', (_$, e) => ({ value: { command: 'cli-tools' } }) as never)
}

describe('hooks', () => {
  test('a call runs the argv and returns stdout and the exit code', { options: { tools: config } }, async ($, on) => {
    engine(on)
    const seen: string[][] = []
    on('process.run', (_$, e) => {
      seen.push([...e.argv])
      return { value: { exitCode: 0, stdout: 'line one\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
    })
    await $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })
    const r = await $.tool.call({ tool: 'mcp__cli-tools__logs', service: 'api', lines: 5 } as never)
    expect(JSON.stringify(r)).toContain('line one')
    expect(JSON.stringify(r)).toContain('exit code: 0')
    expect(seen[0]).toEqual(['svc', 'logs', 'api', '--lines=5'])
  })

  test('bad input never reaches the shell', { options: { tools: config } }, async ($, on) => {
    engine(on)
    let ran = 0
    on('process.run', () => ((ran += 1), { value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
    await $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })
    const r = await $.tool.call({ tool: 'mcp__cli-tools__logs' } as never)
    expect(JSON.stringify(r)).toContain('missing required parameter')
    expect(ran).toBe(0)
  })
})
