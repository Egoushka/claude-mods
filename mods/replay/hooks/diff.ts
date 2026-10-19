export type Op = { t: ' ' | '-' | '+'; s: string }

export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

// Line diff: common head and tail are trimmed, the middle is an LCS table; a middle too big for one is a plain replacement.
export function diffOps(a: string[], b: string[]): Op[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  const ops: Op[] = a.slice(0, head).map(s => ({ t: ' ', s }))

  if (x.length * y.length > 2_000_000) {
    for (const s of x) ops.push({ t: '-', s })
    for (const s of y) ops.push({ t: '+', s })
  } else {
    const w = y.length + 1
    const lcs = new Uint32Array((x.length + 1) * w)
    for (let i = x.length - 1; i >= 0; i -= 1)
      for (let j = y.length - 1; j >= 0; j -= 1)
        lcs[i * w + j] = x[i] === y[j] ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0)
    let i = 0
    let j = 0
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        ops.push({ t: ' ', s: x[i] ?? '' })
        i += 1
        j += 1
      } else if (i < x.length && (j === y.length || (lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0))) {
        ops.push({ t: '-', s: x[i] ?? '' })
        i += 1
      } else {
        ops.push({ t: '+', s: y[j] ?? '' })
        j += 1
      }
    }
  }
  for (const s of a.slice(a.length - tail)) ops.push({ t: ' ', s })
  return ops
}

export type Hunk = { text: string; added: number; removed: number }

// Groups changes that lie within 2 * context lines of each other, as `diff -u` does.
export function toHunks(ops: Op[], context = 3): Hunk[] {
  const changed: number[] = []
  ops.forEach((op, i) => op.t !== ' ' && changed.push(i))
  const groups: [number, number][] = []
  for (const i of changed) {
    const last = groups[groups.length - 1]
    if (last && i - last[1] <= 2 * context) last[1] = i
    else groups.push([i, i])
  }
  // Line numbers of every op's first old and new line.
  const oldAt: number[] = []
  const newAt: number[] = []
  let o = 1
  let n = 1
  for (const op of ops) {
    oldAt.push(o)
    newAt.push(n)
    if (op.t !== '+') o += 1
    if (op.t !== '-') n += 1
  }
  return groups.map(([first, last]) => {
    const from = Math.max(0, first - context)
    const to = Math.min(ops.length - 1, last + context)
    const slice = ops.slice(from, to + 1)
    const oldCount = slice.filter(op => op.t !== '+').length
    const newCount = slice.filter(op => op.t !== '-').length
    const oldStart = oldCount === 0 ? (oldAt[from] ?? 1) - 1 : (oldAt[from] ?? 1)
    const newStart = newCount === 0 ? (newAt[from] ?? 1) - 1 : (newAt[from] ?? 1)
    return {
      text: [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...slice.map(op => op.t + op.s)].join('\n'),
      added: slice.filter(op => op.t === '+').length,
      removed: slice.filter(op => op.t === '-').length,
    }
  })
}

// One hunk cut to its first lines, its header counts redone so the Code element still parses it.
export function clipHunk(text: string, maxChars: number): string {
  const [header = '', ...lines] = text.split('\n')
  const m = /^@@ -(\d+),\d+ \+(\d+),\d+ @@$/.exec(header)
  if (!m) return text
  const kept: string[] = []
  let size = 0
  for (const line of lines) {
    if (size + line.length > maxChars && kept.length > 0) break
    kept.push(line)
    size += line.length + 1
  }
  const oldCount = kept.filter(l => l[0] !== '+').length
  const newCount = kept.filter(l => l[0] !== '-').length
  return [`@@ -${Number(m[1])},${oldCount} +${Number(m[2])},${newCount} @@`, ...kept].join('\n')
}

export type Diffed = { diff: string; added: number; removed: number; omitted: number }

// The whole change as hunks, cut at a hunk boundary once `maxChars` is passed (the first hunk always stays).
export function unifiedDiff(before: string, after: string, maxChars: number): Diffed {
  const hunks = toHunks(diffOps(splitLines(before), splitLines(after)))
  const kept: string[] = []
  let size = 0
  for (const h of hunks) {
    if (kept.length > 0 && size + h.text.length > maxChars) break
    kept.push(h.text)
    size += h.text.length + 1
  }
  const first = kept[0]
  const isClipped = first !== undefined && first.length > maxChars
  if (isClipped) kept[0] = clipHunk(first, maxChars)
  return {
    diff: kept.join('\n'),
    added: hunks.reduce((sum, h) => sum + h.added, 0),
    removed: hunks.reduce((sum, h) => sum + h.removed, 0),
    omitted: hunks.length - kept.length + (isClipped ? 1 : 0),
  }
}
