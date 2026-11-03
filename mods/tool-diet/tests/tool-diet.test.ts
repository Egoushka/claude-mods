import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { matches, parseList } from '../hooks/diet'

describe('list', () => {
  test('splits and trims', () => {
    expect(parseList(' Workflow, Artifact ,,mcp__x__*')).toEqual(['Workflow', 'Artifact', 'mcp__x__*'])
  })
  test('empty stays empty', () => {
    expect(parseList('')).toEqual([])
  })
})

describe('matching', () => {
  const list = ['Workflow', 'mcp__homelab__umami_*']
  test('exact name', () => {
    expect(matches('Workflow', list)).toBe(true)
    expect(matches('WorkflowX', list)).toBe(false)
  })
  test('prefix with a star', () => {
    expect(matches('mcp__homelab__umami_get_events', list)).toBe(true)
    expect(matches('mcp__homelab__github_get_me', list)).toBe(false)
  })
  test('ToolSearch is never moved', () => {
    expect(matches('ToolSearch', ['*'])).toBe(false)
  })
})

const engine = (on: On) => on('tool.describe', (_$, e) => ({ description: e.description, ...(e.isDeferred ? { isDeferred: true as const } : {}) }))
const ask = ($: Parameters<Parameters<typeof test>[1]>[0], tool: string) =>
  $.tool.describe({ tool, description: 'text', provider: { plugin: 'engine', tier: 'core' } } as never)

describe('the hook', () => {
  test('a listed tool moves behind ToolSearch, the text stays', { options: { tools: 'Workflow, mcp__x__*' } }, async ($, on) => {
    engine(on)
    expect(await ask($, 'Workflow')).toEqual({ description: 'text', isDeferred: true })
    expect(await ask($, 'mcp__x__a')).toEqual({ description: 'text', isDeferred: true })
  })

  test('a tool not listed is left as the engine placed it', { options: { tools: 'Workflow' } }, async ($, on) => {
    engine(on)
    expect(await ask($, 'Bash')).toEqual({ description: 'text' })
  })

  test('an empty list does nothing', async ($, on) => {
    engine(on)
    expect(await ask($, 'Workflow')).toEqual({ description: 'text' })
  })
})
