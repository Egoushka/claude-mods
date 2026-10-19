import { describe, expect, test } from 'claude-code/testing'

import { bandLabel, buildAuditPrompt, buildBackupPrompt, keepEvidence, parseClaims, shouldAudit } from '../hooks/audit'

describe('parseClaims', () => {
  test('plain JSON, fenced JSON and prose around it', () => {
    expect(parseClaims('{"claims": ["a is b", "c calls d"]}')).toEqual(['a is b', 'c calls d'])
    expect(parseClaims('```json\n{"claims": ["a is b"]}\n```')).toEqual(['a is b'])
    expect(parseClaims('Here you go: {"claims": ["x"]} done.')).toEqual(['x'])
    expect(parseClaims('["bare list"]')).toEqual(['bare list'])
  })

  test('objects as items, dedupe, trimming and the cap', () => {
    expect(parseClaims('{"claims": [{"claim": " one "}, {"text": "two"}, "ONE", 3, null, ""]}')).toEqual(['one', 'two'])
    const many = JSON.stringify({ claims: Array.from({ length: 20 }, (_, i) => `claim ${i}`) })
    expect(parseClaims(many)).toHaveLength(8)
  })

  test('garbage gives nothing, never throws', () => {
    expect(parseClaims('')).toEqual([])
    expect(parseClaims('no json here')).toEqual([])
    expect(parseClaims('{"claims": "not a list"}')).toEqual([])
    expect(parseClaims('{broken')).toEqual([])
  })
})

describe('shouldAudit', () => {
  const technical = 'The `handler` in src/app.ts calls `parse()` and the config file sets the version. '.repeat(10)
  test('skips short and conversational replies', () => {
    expect(shouldAudit('Done.', 600)).toBe(false)
    expect(shouldAudit('Thanks for the update, that sounds good to me and I agree with the plan overall. '.repeat(20), 600)).toBe(false)
  })
  test('audits long answers about code', () => {
    expect(shouldAudit(technical, 600)).toBe(true)
    expect(shouldAudit(technical, 100000)).toBe(false)
  })
})

describe('prompts', () => {
  test('backup prompt lists the claims and offers UNKNOWN', () => {
    const p = buildBackupPrompt(['a is b', 'c calls d'])
    expect(p).toContain('1. a is b')
    expect(p).toContain('2. c calls d')
    expect(p).toContain('UNKNOWN')
    expect(p).toContain('file:line')
  })
  test('band label', () => {
    expect(bandLabel(1)).toBe('voice: 1 claim in the last reply cites no source')
    expect(bandLabel(3)).toBe('voice: 3 claims in the last reply cite no source')
  })
})

describe('evidence from the turn', () => {
  test('tool output goes into the audit prompt, newest results kept, each cut short', () => {
    let list: string[] = []
    for (let i = 0; i < 25; i += 1) list = keepEvidence(list, 'Bash', `out ${i} ` + 'x'.repeat(2000))
    expect(list).toHaveLength(20)
    expect(list[0]).toContain('out 5')
    expect(list[19]!.length).toBeLessThan(1300)
    const prompt = buildAuditPrompt('PR 2 is merged.', ['Bash: MERGED 9dbc304'])
    expect(prompt).toContain('<tool_output>')
    expect(prompt).toContain('MERGED 9dbc304')
    expect(buildAuditPrompt('x')).not.toContain('<tool_output>')
  })
})
