// Pure text filter: no engine, so tests import it directly.

export type SlopResult = { text: string; edits: number }

type Rule = {
  re: RegExp
  /** Replace instead of delete; keeps the first letter's case. */
  sub?: (match: string) => string
  /** Only where a sentence starts (an opener, not a mid-sentence use). */
  startOnly?: boolean
}

const OPEN = ''
const CLOSE = ''
const SLOT = /(\d+)/g

// Where a sentence (or a list item, heading, quote line) begins.
const SENTENCE_START = /(?:(?:^|\n)[ \t]*(?:(?:[-*+>]|\d+[.)]|#{1,6})[ \t]+)*|[.!?]["'”’)\]\uE001]*[ \t]+)$/

// Not inside a path or file name (src/delve/a.ts, straightforward.ts): those are data, not prose.
const word = (core: string) => new RegExp(`(?<![\\w/\\\\-]|\\w\\.)(?:${core})(?![\\w-]|\\.\\w|/)`, 'gi')
const matchCase = (from: string, to: string) => (/^[A-Z]/.test(from) ? to.charAt(0).toUpperCase() + to.slice(1) : to)

const PRAISE =
  "(?:(?:great|good|excellent|fantastic|fair|interesting|awesome|wonderful|sharp|nice) (?:question|point|catch|idea|observation)" +
  "|you(?:'|’)re (?:absolutely|totally|completely|entirely|exactly|quite) (?:right|correct)" +
  "|you are (?:absolutely|totally|completely|entirely|exactly|quite) (?:right|correct)" +
  "|that(?:'|’)s (?:a|an) (?:really |very )?(?:great|good|excellent|fantastic|fair|interesting|sharp) (?:question|point|catch|idea|observation)" +
  "|what a (?:great|good|fantastic|excellent) (?:question|idea)" +
  "|sure thing" +
  "|(?:absolutely|certainly|of course)(?=!)" +
  "|(?:great|perfect|excellent|wonderful)(?=[!.,]))"

const DEFAULT_RULES: Rule[] = [
  { re: new RegExp(`(?<![\\w-])${PRAISE}[!.,;:]*(?:[ \\t]*[—–]+)?`, 'gi'), startOnly: true },
  { re: word('honestly|genuinely|truthfully'), },
  {
    re: word('straightforward(?:ly)?|delve[sd]?|delving'),
    sub: m => {
      const k = m.toLowerCase()
      const to = k === 'straightforward' ? 'simple' : k === 'straightforwardly' ? 'simply' : k === 'delve' ? 'dig' : k === 'delves' ? 'digs' : k === 'delved' ? 'dug' : 'digging'
      return matchCase(m, to)
    },
  },
  {
    re: word("it(?:'|’)s (?:worth|important) (?:noting|to note)(?: that)?|it is (?:worth|important) (?:noting|to note)(?: that)?|needless to say|it goes without saying(?: that)?"),
  },
]

const CLOSER =
  /^(?:and |also |so )?(?:i hope (?:this|that|it)(?: all)? helps|hope (?:this|that|it)(?: all)? helps|(?:please )?let me know (?:if|whether|how|what)|(?:please )?feel free to|don(?:'|’)t hesitate to|happy to (?:help|clarify|elaborate|explain|assist)|i(?:'|’)m happy to (?:help|clarify|elaborate|explain|assist)|is there anything else|i(?:'|’)d be (?:happy|glad) to)/i

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** "leverage, /\bseamless(ly)?\b/i" -> regexes. Bad or empty-matching entries are skipped. */
export function parseExtra(spec: string): RegExp[] {
  const out: RegExp[] = []
  for (const raw of spec.match(/\/(?:\\.|[^/\\])+\/[a-z]*|[^,]+/g) ?? []) {
    const entry = raw.trim()
    if (!entry) continue
    const literal = /^\/((?:\\.|[^/\\])+)\/([a-z]*)$/.exec(entry)
    try {
      const re = literal
        ? new RegExp(literal[1] as string, (literal[2] as string).includes('g') ? (literal[2] as string) : `${literal[2]}g`)
        : word(escape(entry).replace(/\s+/g, '\\s+'))
      if (!re.test('')) out.push(re)
    } catch {
      // an invalid pattern is ignored, not fatal
    }
  }
  return out
}

/** Hide code, URLs, quotes and blockquotes behind placeholders the rules cannot match inside. */
export function protect(text: string): { work: string; slots: string[] } {
  const slots: string[] = []
  const hold = (s: string) => `${OPEN}${slots.push(s) - 1}${CLOSE}`

  // Fenced blocks, line by line; an unclosed fence (a reply cut off) runs to the end.
  const lines = text.split('\n')
  const kept: string[] = []
  let open: { char: string; size: number; body: string[] } | undefined
  for (const line of lines) {
    const fence = /^[ \t]*(`{3,}|~{3,})/.exec(line)
    if (!open) {
      if (fence) open = { char: (fence[1] as string)[0] as string, size: (fence[1] as string).length, body: [line] }
      else kept.push(line)
      continue
    }
    open.body.push(line)
    const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line)
    if (close && (close[1] as string)[0] === open.char && (close[1] as string).length >= open.size) {
      kept.push(hold(open.body.join('\n')))
      open = undefined
    }
  }
  if (open) kept.push(hold(open.body.join('\n')))

  let work = kept.join('\n')
  work = work.replace(/(`+)(?:(?!\1)[^\n])+?\1/g, hold)
  work = work.replace(/(?:https?|ftp):\/\/[^\s<>"'`)\]]*[^\s<>"'`)\].,;:!?]|www\.[^\s<>"'`)\]]*[^\s<>"'`)\].,;:!?]/gi, hold)
  work = work.replace(/^[ \t]*>.*$/gm, hold)
  work = work.replace(/“[^”\n]*”|"[^"\n]*"/g, hold)
  return { work, slots }
}

export function restore(work: string, slots: string[]): string {
  let text = work
  for (let i = 0; i < 6 && SLOT.test(text); i += 1) {
    SLOT.lastIndex = 0
    text = text.replace(SLOT, (_, n: string) => slots[Number(n)] ?? '')
  }
  return text
}

function apply(input: string, rule: Rule): { text: string; edits: number } {
  let text = input
  let edits = 0
  let pos = 0
  const re = rule.re
  for (;;) {
    re.lastIndex = pos
    const m = re.exec(text)
    if (!m) break
    if (m[0] === '') {
      pos = m.index + 1
      if (pos > text.length) break
      continue
    }
    const end = m.index + m[0].length
    let before = text.slice(0, m.index)
    let after = text.slice(end)
    const isStart = SENTENCE_START.test(before)
    if (rule.startOnly && !isStart) {
      pos = end
      continue
    }
    let middle = ''
    if (rule.sub) {
      middle = rule.sub(m[0])
    } else if (isStart) {
      const isLineStart = before === '' || before.endsWith('\n')
      after = after.replace(/^[.!?]+[ \t]*/, '').replace(isLineStart ? /^[,;:]?\s*/ : /^[,;:]?[ \t]*/, '')
      if ((after === '' || after.startsWith('\n')) && /[ \t]$/.test(before)) before = before.replace(/[ \t]+$/, '')
      after = after.replace(/^[a-z]/, c => c.toUpperCase())
    } else if (/^[,;:.!?)]/.test(after)) {
      before = before.replace(/[ \t]+$/, '')
      if (before.endsWith(',') && /^[.!?;:]/.test(after)) before = before.slice(0, -1)
      else if (before.endsWith(',') && after.startsWith(',')) after = after.slice(1)
    } else if (/[ \t]$/.test(before)) {
      after = after.replace(/^[ \t]+/, '')
    }
    text = before + middle + after
    pos = before.length + middle.length
    edits += 1
  }
  return { text, edits }
}

// Drops trailing "hope this helps" / "let me know if" sentences from the last line of prose.
// A sentence that mentions code or a link is information, so it stays.
function dropClosers(work: string): { text: string; edits: number } {
  const body = work.replace(/\s+$/, '')
  const tail = work.slice(body.length)
  const lineStart = body.lastIndexOf('\n') + 1
  const line = body.slice(lineStart)
  if (/^\s*(?:[-*+>|#]|\d+[.)])/.test(line)) return { text: work, edits: 0 }
  const sentences = line.split(/(?<=[.!?])\s+/)
  let edits = 0
  while (sentences.length > 0) {
    const last = (sentences[sentences.length - 1] as string).trim()
    if (last.includes(OPEN) || !CLOSER.test(last)) break
    sentences.pop()
    edits += 1
  }
  if (edits === 0) return { text: work, edits: 0 }
  const head = body.slice(0, lineStart)
  const rest = sentences.join(' ')
  return { text: rest === '' ? head.replace(/\s+$/, '') : head + rest + tail, edits }
}

/** Removes filler and AI tells from prose; code, URLs and quotes are never touched. */
export function filterSlop(input: string, extra: readonly RegExp[] = []): SlopResult {
  if (input.includes(OPEN) || input.includes(CLOSE)) return { text: input, edits: 0 }
  const { work, slots } = protect(input)
  let text = work
  let edits = 0
  for (const rule of [...DEFAULT_RULES, ...extra.map((re): Rule => ({ re }))]) {
    const r = apply(text, rule)
    text = r.text
    edits += r.edits
  }
  const closed = dropClosers(text)
  text = closed.text
  edits += closed.edits
  const result = restore(text, slots)
  // Never turn an answer into nothing.
  if (edits === 0 || result.trim() === '') return { text: input, edits: 0 }
  return { text: result, edits }
}
