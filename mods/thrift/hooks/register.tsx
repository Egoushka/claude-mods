import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Coach, Diet, Route, Tier, Weather } from '../types'
import {
  applyDiet,
  fmtTokens,
  isPinnedSection,
  isReset,
  isSameModel,
  measureSections,
  modelForTier,
  parseTier,
  savedTokens,
  sparkRaster,
  sparkText,
  weatherLine,
} from './logic'

const PANE = 'thrift-diet'
const MAX_POINTS = 30

const route = atom({ plugin: 'thrift', key: 'route' } as const, { tier: null, model: null, isApplied: false } as Route)
const coach = atom({ plugin: 'thrift', key: 'coach' } as const, { tokens: null, crossing: 0, dismissedCrossing: 0 } as Coach)
const weather = atom({ plugin: 'thrift', key: 'weather' } as const, { points: [], limit: null, isCompaction: false } as Weather)
const diet = atom({ plugin: 'thrift', key: 'diet' } as const, { cwd: '', dropped: [], sections: [] } as Diet)

const RUBRIC =
  'You route a coding assistant\'s prompts to a model. Classify the person\'s message by the difficulty of the work it asks for.\n' +
  'trivial: a lookup, a one-line edit, a rename, a yes/no, a short factual or formatting question.\n' +
  'normal: ordinary coding work: a bug fix or feature in a few files, explaining code, writing tests.\n' +
  'hard: design across many files, subtle debugging, security or concurrency, large refactors, open-ended research.\n' +
  'Reply with exactly one word: trivial, normal or hard.'

async function classify($: EngineInterface, text: string): Promise<Tier | null> {
  const r = await $.model.complete({ model: 'haiku', system: RUBRIC, prompt: text.slice(0, 1500), maxTokens: 8 }).catch(() => undefined)
  return r && r.isAnswered ? parseTier(r.text) : null
}

async function setRoute($: EngineInterface, next: Route) {
  await update($, route, () => next)
}

async function noteContext($: EngineInterface, tokens: number, threshold: number) {
  const prev = await read($, coach)
  const was = threshold > 0 && (prev.tokens ?? 0) >= threshold
  const isOver = threshold > 0 && tokens >= threshold
  const isNewCrossing = isOver && !was
  await update($, coach, c => ({ ...c, tokens, crossing: isNewCrossing ? c.crossing + 1 : c.crossing }))
  if (isNewCrossing) $.ui.toast(`thrift: context passed ${fmtTokens(threshold)} tokens. The band offers a handoff or a compaction.`)
}

// The engine compacts at autoCompactThreshold when it is on; otherwise the window is the limit.
async function readLimit($: EngineInterface): Promise<{ limit: number | null; isCompaction: boolean }> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const b = context.breakdown
    if (b?.isAutoCompactEnabled && b.autoCompactThreshold) return { limit: b.autoCompactThreshold, isCompaction: true }
    return { limit: b?.rawMaxTokens ?? context.window, isCompaction: false }
  } catch {
    return { limit: null, isCompaction: false }
  }
}

async function recordTurn($: EngineInterface) {
  const { context } = await $.session.usage()
  if (context.tokens === undefined) return
  const tokens = context.tokens
  const prev = await read($, weather)
  const reset = isReset(prev.points[prev.points.length - 1], tokens)
  const limit = reset || prev.limit === null ? await readLimit($) : { limit: prev.limit, isCompaction: prev.isCompaction }
  await update($, weather, w => ({
    points: (reset ? [tokens] : [...w.points, tokens]).slice(-MAX_POINTS),
    limit: limit.limit,
    isCompaction: limit.isCompaction,
  }))
}

async function dismiss($: EngineInterface) {
  await update($, coach, c => ({ ...c, dismissedCrossing: c.crossing }))
}

async function handOff($: EngineInterface, text: string) {
  await dismiss($)
  await $.prompt.submit({ text })
}

async function compactNow($: EngineInterface) {
  try {
    const r = await $.session.compact()
    if (r.skip !== undefined) return $.ui.toast(`thrift: compaction skipped: ${r.skip}`)
    await update($, coach, c => ({ ...c, tokens: null, dismissedCrossing: c.crossing }))
  } catch {
    $.ui.toast('thrift: wait for the turn to end, then press Compact again.')
  }
}

async function refreshSections($: EngineInterface) {
  const composed = await $.prompt.compose()
  const sections = measureSections(composed.sections)
  await update($, diet, d => ({ ...d, sections }))
}

async function toggleSection($: EngineInterface, id: string) {
  if (isPinnedSection(id)) return
  const d = await update($, diet, cur => ({ ...cur, dropped: cur.dropped.includes(id) ? cur.dropped.filter(x => x !== id) : [...cur.dropped, id] }))
  await $.store.set(`diet:${d.cwd}`, d.dropped)
  $.ui.toast('thrift: takes effect on the next request (one prompt-cache miss).')
}

async function resetAll($: EngineInterface) {
  await update($, coach, () => ({ tokens: null, crossing: 0, dismissedCrossing: 0 }))
  await update($, weather, () => ({ points: [], limit: null, isCompaction: false }))
  await update($, route, () => ({ tier: null, model: null, isApplied: false }))
}

export const register: Register = (on, options) => {
  const mode = options.routerMode === 'off' || options.routerMode === 'auto' ? options.routerMode : 'suggest'
  const threshold = typeof options.coachThreshold === 'number' ? options.coachThreshold : 150000
  const handoffText = typeof options.handoffPrompt === 'string' && options.handoffPrompt.trim() ? options.handoffPrompt : 'Write a handoff note for the next session.'
  const isWeatherOn = options.weather !== false
  const isDietOn = options.diet !== false

  // The model the running turn is routed to; set at prompt.submit, cleared when the turn completes.
  let target: string | null = null

  on('session.start', async ($, e, next) => {
    const dropped = isDietOn ? await $.store.get(`diet:${e.cwd}`) : []
    await update($, diet, d => ({ ...d, cwd: e.cwd, dropped: Array.isArray(dropped) ? dropped.map(String) : [] }))
    if (isDietOn) await $.command.register({ name: 'diet', description: 'Choose system prompt sections to drop for this project' })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      target = null
      await resetAll($)
    }
    return next(e)
  })

  // Router: a Haiku call sizes the prompt before the turn starts.
  on('prompt.submit', async ($, e, next) => {
    if (mode === 'off' || e.command || e.isMeta || e.turnId !== undefined || e.text.trim().length < 4) return next(e)
    const tier = await classify($, e.text)
    if (!tier) return next(e)
    const wanted = modelForTier(options, tier)
    const current = await $.session.model()
    const isDifferent = !isSameModel(current, wanted)
    target = mode === 'auto' && isDifferent ? wanted : null
    await setRoute($, { tier, model: wanted, isApplied: target !== null })
    if (mode === 'suggest' && isDifferent) $.ui.toast(`thrift: this looks ${tier}. ${wanted} would do; /model ${wanted} to switch.`)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (target !== null && e.agentId === undefined && !isSameModel(e.model, target)) return yield* next({ ...e, model: target })
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      target = null
      if (isWeatherOn) await recordTurn($).catch(() => undefined)
    }
    return next(e)
  })

  // Coach: the context size, as the engine measures it after each response.
  on('session.measure', async ($, e, next) => {
    if (e.context.tokens !== undefined && threshold > 0) await noteContext($, e.context.tokens, threshold)
    return next(e)
  })

  // Diet: dropped sections leave the system prompt; pinned ones never do.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const { dropped } = await read($, diet)
    if (!isDietOn || dropped.length === 0) return composed
    const kept = applyDiet(composed.sections, dropped)
    return kept.sections.length === composed.sections.length ? composed : { sections: kept.sections }
  })

  on('command.run', { command: 'diet' }, async $ => {
    await refreshSections($)
    await $.ui.open({ id: PANE, title: 'Instruction diet', focus: true, closeOnEscape: true })
    return { text: 'Instruction diet opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (e.props.hasSurvey) return rest

    const r = await read($, route)
    const c = await read($, coach)
    const w = await read($, weather)
    const d = await read($, diet)
    const { Box, Text, Button } = $.ui.resolve(e)
    const Raster = e.surface === 'terminal' ? $.ui.resolve(e).Raster : undefined

    const head: string[] = []
    if (mode !== 'off' && r.tier && r.model) head.push(`route: ${r.tier} → ${r.model} (${r.isApplied ? 'auto' : mode === 'auto' ? 'already on it' : 'suggested'})`)
    const saved = savedTokens(d.sections, d.dropped)
    if (isDietOn && saved > 0) head.push(`diet: −${fmtTokens(saved)}/request`)

    const line = isWeatherOn ? weatherLine(w.points, w.limit, w.isCompaction) : undefined
    const isCoaching = threshold > 0 && c.tokens !== null && c.tokens >= threshold && c.crossing !== c.dismissedCrossing

    if (head.length === 0 && !line && !isCoaching) return rest

    return (
      <Box flexDirection="column">
        {head.length > 0 && <Text dimColor>thrift · {head.join(' · ')}</Text>}
        {line && (
          <Box>
            <Text dimColor>{line} </Text>
            {Raster ? <Raster key="spark" {...sparkRaster(w.points, w.limit)} /> : <Text dimColor>{sparkText(w.points, w.limit)}</Text>}
          </Box>
        )}
        {isCoaching && (
          <Box>
            <Text color="yellow">context {fmtTokens(c.tokens ?? 0)} is past {fmtTokens(threshold)}: </Text>
            <Button key="handoff" label="Hand off" variant="primary" onPress={() => handOff($, handoffText)} />
            <Text> </Text>
            <Button key="compact" label="Compact" onPress={() => compactNow($)} />
            <Text> </Text>
            <Button key="dismiss" label="Dismiss" dimColor onPress={() => dismiss($)} />
          </Box>
        )}
        {rest}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const d = await read($, diet)
    const total = d.sections.reduce((sum, s) => sum + s.tokens, 0)
    const saved = savedTokens(d.sections, d.dropped)
    return (
      <Box flexDirection="column">
        <Text bold>
          System prompt: ~{fmtTokens(total)} tokens in {d.sections.length} sections; dropped here: ~{fmtTokens(saved)}
        </Text>
        <Text dimColor>Sizes are estimates (4 characters a token). Choices are kept per folder: {d.cwd || 'this project'}</Text>
        {d.sections.map(s => {
          const isDropped = d.dropped.includes(s.id)
          return (
            <Box key={s.id}>
              <Text dimColor={isDropped}>{s.id.padEnd(24)}</Text>
              <Text dimColor>{`~${fmtTokens(s.tokens)}`.padStart(7)} </Text>
              {s.isPinned ? <Text dimColor>pinned</Text> : <Button key={`toggle-${s.id}`} label={isDropped ? 'Restore' : 'Drop'} onPress={() => toggleSection($, s.id)} />}
            </Box>
          )
        })}
      </Box>
    )
  })
}
