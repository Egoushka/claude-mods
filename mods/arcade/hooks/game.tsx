import type { ClientModule } from 'claude-code'

// The surface module: it runs in the drawing thread with no `$`, so it only reads its props and posts its score.
// Everything the game needs is in this file; the hooks module hands it spawns through props.

type Kind = 'c' | 'g' | 'h'
type Props = { spawns: { id: number; k: Kind }[]; round: number; best: number }
type Item = { x: number; y: number; k: Kind }
type State = {
  px: number
  items: Item[]
  score: number
  lives: number
  isOver: boolean
  seen: number
  round: number
  tick: number
  seed: number
}

const W = 24
const H = 5
const LIVES = 3
const FALL_EVERY = 3
const AMBIENT_EVERY = 26
const POINTS: Record<Kind, number> = { c: 1, g: 3, h: 0 }

const fresh = (round: number, seen: number, seed: number): State => ({
  px: Math.floor(W / 2),
  items: [],
  score: 0,
  lives: LIVES,
  isOver: false,
  seen,
  round,
  tick: 0,
  seed,
})

// A small linear congruential generator, so a round is reproducible and the module needs no Math.random.
function roll(s: State, n: number): [number, State] {
  const seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0
  return [(seed >>> 8) % n, { ...s, seed }]
}

function drop(s: State, k: Kind): State {
  const [x, next] = roll(s, W)
  return { ...next, items: [...next.items, { x, y: 0, k }] }
}

// New spawns from the hooks module, or a new round, folded into the state; the same object back when nothing is new.
function absorb(s: State, props: Props): State {
  if (props.round !== s.round) return props.spawns.reduce((acc, sp) => drop({ ...acc, seen: sp.id }, sp.k), fresh(props.round, s.seen, s.seed))
  const news = props.spawns.filter(sp => sp.id > s.seen)
  if (news.length === 0) return s
  if (s.isOver) return { ...s, seen: Math.max(...news.map(sp => sp.id)) }
  return news.reduce((acc, sp) => drop({ ...acc, seen: sp.id }, sp.k), s)
}

// One frame: items fall on every third tick, a coin in reach scores, a hazard in reach costs a life.
function step(s: State): State {
  if (s.isOver) return s
  let next: State = { ...s, tick: s.tick + 1 }
  if (next.tick % AMBIENT_EVERY === 0) next = drop(next, 'c')
  if (next.tick % FALL_EVERY !== 0) return next
  let { score, lives } = next
  const items: Item[] = []
  for (const it of next.items) {
    const y = it.y + 1
    if (y < H - 1) items.push({ ...it, y })
    else if (Math.abs(it.x - next.px) <= 1) {
      if (it.k === 'h') lives -= 1
      else score += POINTS[it.k]
    }
  }
  return { ...next, items, score, lives, isOver: lives <= 0 }
}

type Cell = { ch: string; color?: string; bold?: boolean }

function rows(s: State): Cell[][] {
  const grid: Cell[][] = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ ch: ' ' })))
  for (const it of s.items) {
    const row = grid[it.y]
    if (row) row[it.x] = it.k === 'h' ? { ch: '#', color: 'error', bold: true } : it.k === 'g' ? { ch: '$', color: 'warning', bold: true } : { ch: 'o', color: 'warning' }
  }
  const floor = grid[H - 1]
  if (floor)
    ['/', 'A', '\\'].forEach((ch, i) => {
      const x = s.px - 1 + i
      if (x >= 0 && x < W) floor[x] = { ch, color: 'suggestion', bold: true }
    })
  return grid
}

const clamp = (x: number) => Math.max(1, Math.min(W - 2, x))

const Game: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  let s = surface.state

  if (s === undefined) {
    s = absorb(fresh(props.round, 0, 2463534242), props)
    surface.setState(s)
    // Started once, while the state is still undefined; each timer reads the live state.
    surface.every(120, () => {
      const cur = surface.state
      if (!cur) return
      const next = step(cur)
      if (next === cur) return
      if (next.isOver && !cur.isOver) surface.post({ score: next.score, isOver: true })
      else if (next.score !== cur.score) surface.post({ score: next.score, isOver: false })
      surface.setState(next)
    })
    surface.onKey(e => {
      const cur = surface.state
      if (!cur) return
      if (cur.isOver) {
        if (e.key === 'return' || e.key === ' ') surface.setState(fresh(cur.round, cur.seen, cur.seed))
        return
      }
      if (e.key === 'left' || e.key === 'a' || e.key === 'h') surface.setState({ ...cur, px: clamp(cur.px - 1) })
      if (e.key === 'right' || e.key === 'd' || e.key === 'l') surface.setState({ ...cur, px: clamp(cur.px + 1) })
    })
    surface.onPointer(e => {
      const cur = surface.state
      if (!cur) return
      if (cur.isOver) {
        if (e.type === 'down') surface.setState(fresh(cur.round, cur.seen, cur.seed))
        return
      }
      if (e.type === 'move' || e.type === 'down') surface.setState({ ...cur, px: clamp(e.x) })
    })
  } else {
    const next = absorb(s, props)
    if (next !== s) {
      surface.setState(next)
      s = next
    }
  }

  const grid = rows(s)
  const message = s.isOver ? ' GAME OVER · enter or click to retry ' : ''
  const lives = '♥'.repeat(Math.max(0, s.lives))
  const lost = '♡'.repeat(Math.max(0, LIVES - s.lives))

  return (
    <Box flexDirection="column" width={W}>
      <Text>
        <Text bold>{s.score}</Text> pts <Text color="error">{lives}</Text>
        <Text dimColor>
          {lost} best {Math.max(props.best, s.score)}
        </Text>
      </Text>
      {grid.map((row, y) => {
        if (s.isOver && y === 2) return <Text key={String(y)} inverse>{message.padEnd(W).slice(0, W)}</Text>
        const runs: { text: string; cell: Cell }[] = []
        for (const cell of row) {
          const last = runs[runs.length - 1]
          if (last && last.cell.color === cell.color && last.cell.bold === cell.bold) last.text += cell.ch
          else runs.push({ text: cell.ch, cell })
        }
        return (
          <Text key={String(y)}>
            {runs.map((r, i) => (
              <Text key={String(i)} color={r.cell.color} bold={r.cell.bold}>
                {r.text}
              </Text>
            ))}
          </Text>
        )
      })}
    </Box>
  )
}

export default Game
