import { describe, expect, test } from 'claude-code/testing'

import { filterSlop, parseExtra } from '../hooks/slop'

const clean = (s: string, extra: RegExp[] = []) => filterSlop(s, extra).text

describe('praise openers', () => {
  test('drops the opener and capitalises what is left', () => {
    expect(clean("Great question! The cache is keyed by path.")).toBe('The cache is keyed by path.')
    expect(clean("You're absolutely right, the bug is in the parser.")).toBe('The bug is in the parser.')
    expect(clean('You’re absolutely right — the test was wrong.')).toBe('The test was wrong.')
    expect(clean("That's a great point. I will change it.")).toBe('I will change it.')
    expect(clean('Absolutely! Here is the fix.')).toBe('Here is the fix.')
  })

  test('only at the start of a sentence, line or list item', () => {
    expect(clean('Done. Great question, by the way.')).toBe('Done. By the way.')
    expect(clean('The answer is absolutely right here.')).toBe('The answer is absolutely right here.')
    expect(clean('Of course, the config also matters.')).toBe('Of course, the config also matters.')
    expect(clean('- Good point, noted\n- Next')).toBe('- Noted\n- Next')
  })

  test('a paragraph that was only praise disappears with its blank line', () => {
    expect(clean('Great question!\n\nThe fix is in `a.ts`.')).toBe('The fix is in `a.ts`.')
  })
})

describe('closers', () => {
  test('removes trailing offers from the last line', () => {
    expect(clean('The port is 8080. I hope this helps!')).toBe('The port is 8080.')
    expect(clean('Set the flag.\n\nLet me know if you have any questions.')).toBe('Set the flag.')
    expect(clean('Set the flag. Hope this helps! Feel free to ask more.')).toBe('Set the flag.')
  })

  test('keeps a "let me know" that carries information or is not last', () => {
    expect(clean('Run it. Let me know if `make test` fails.')).toBe('Run it. Let me know if `make test` fails.')
    expect(clean('Let me know if it breaks.\n\nThen we revert.')).toBe('Let me know if it breaks.\n\nThen we revert.')
  })

  test('never empties an answer', () => {
    expect(clean('I hope this helps!')).toBe('I hope this helps!')
    expect(clean('Great question!')).toBe('Great question!')
  })
})

describe('banned words', () => {
  test('deletes adverbs and tidies commas and spaces', () => {
    expect(clean('Honestly, it works.')).toBe('It works.')
    expect(clean('I honestly think it works.')).toBe('I think it works.')
    expect(clean('It works, honestly.')).toBe('It works.')
    expect(clean('It works, honestly, in most cases.')).toBe('It works, in most cases.')
    expect(clean('It is genuinely hard.')).toBe('It is hard.')
  })

  test('swaps words that cannot simply be deleted', () => {
    expect(clean('The fix is straightforward.')).toBe('The fix is simple.')
    expect(clean('Straightforward changes only.')).toBe('Simple changes only.')
    expect(clean("Let's delve into the logs.")).toBe("Let's dig into the logs.")
    expect(clean('She delved, then delves again, delving.')).toBe('She dug, then digs again, digging.')
  })

  test('drops throat-clearing phrases', () => {
    expect(clean("It's worth noting that the cache expires.")).toBe('The cache expires.')
    expect(clean('The cache expires, and it is important to note that retries reset it.')).toBe('The cache expires, and retries reset it.')
    expect(clean('Needless to say, tests pass.')).toBe('Tests pass.')
  })

  test('leaves phrases that are inside longer words', () => {
    const s = 'Dishonestly named; honestlyish; straightforwardness; undelved; genuinely-looking.'
    expect(clean(s)).toBe(s)
  })

  test('counts every edit', () => {
    expect(filterSlop('Honestly, it is genuinely straightforward. I hope this helps!').edits).toBe(4)
  })
})

describe('protected spans', () => {
  test('fenced code is untouched, also when unclosed', () => {
    const fenced = 'Honestly, see:\n```ts\nconst honestly = "straightforward"\n```\nIt is genuinely fine.'
    expect(clean(fenced)).toBe('See:\n```ts\nconst honestly = "straightforward"\n```\nIt is fine.')
    const open = 'Fine.\n```\nhonestly()\nstill honestly'
    expect(filterSlop(open).edits).toBe(0)
    const tilde = 'Fine.\n~~~\nGreat question!\n~~~\nGenuinely good.'
    expect(clean(tilde)).toBe('Fine.\n~~~\nGreat question!\n~~~\nGood.')
  })

  test('inline code, URLs, quotes and blockquotes are untouched', () => {
    expect(clean('Call `honestly()` genuinely.')).toBe('Call `honestly()`.')
    expect(clean('See https://example.com/honestly/straightforward for details, honestly.')).toBe(
      'See https://example.com/honestly/straightforward for details.',
    )
    expect(clean('The error says "honestly, it failed" and that is genuinely odd.')).toBe('The error says "honestly, it failed" and that is odd.')
    expect(clean('He wrote “straightforward” twice.')).toBe('He wrote “straightforward” twice.')
    expect(clean('> Honestly, quoted\n\nHonestly, mine.')).toBe('> Honestly, quoted\n\nMine.')
  })

  test('a protected span at a sentence start blocks the opener rule', () => {
    expect(clean('`Great question!` is a string. Honestly.')).toBe('`Great question!` is a string.')
  })

  test('text that already uses the placeholder characters is returned as is', () => {
    expect(filterSlop('honestly 0').edits).toBe(0)
  })
})

describe('extra phrases', () => {
  test('parses plain phrases and /regex/ entries', () => {
    const extra = parseExtra('leverage, /\\bseamless(ly)?\\b/i, [broken')
    expect(extra.length).toBe(3)
    expect(clean('We leverage tools. It works seamlessly, really.', extra)).toBe('We tools. It works, really.')
  })

  test('skips patterns that match nothing useful', () => {
    expect(parseExtra('/(/, /x*/, ,')).toEqual([])
  })

  test('plain phrases match whole words, any spacing', () => {
    const extra = parseExtra('dive   deep')
    expect(clean('Let us dive deep now. Dive deeper.', extra)).toBe('Let us now. Dive deeper.')
  })
})

describe('paths and file names', () => {
  test('a filtered word inside a path or file name is left alone', () => {
    expect(clean('See src/delve/index.ts and straightforward.md.')).toBe('See src/delve/index.ts and straightforward.md.')
    expect(clean('Edit docs/honestly.md, then it is straightforward.')).toBe('Edit docs/honestly.md, then it is simple.')
  })
})
