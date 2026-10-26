import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RivalFinding, RivalReview } from '../types'
import {
  REVIEWER_PROMPT,
  REVIEWER_TOOLS,
  REVIEWER_TYPE,
  buildTask,
  changedLines,
  fixPrompt,
  hashText,
  isReviewerBash,
  isReviewerTool,
  parseFindings,
  where,
} from './review'

const PANE = 'rival'
const STALE_MS = 15 * 60_000

const initial: RivalReview = { status: 'idle', findings: [], lines: 0, message: '', isDismissed: false }
const review = atom({ plugin: 'rival', key: 'review' } as const, initial)

// Per-session bookkeeping; a reload starts it over.
type Ctx = {
  isOn: boolean
  model: string
  minLines: number
  minConfidence: number
  cwd: string
  lastStat: string
  runningId: string | undefined
  isSpawning: boolean
  startedAt: number
  cooldownMs: number
  lastReviewAt: number
}

const set = ($: EngineInterface, patch: Partial<RivalReview>) => update($, review, s => ({ ...s, ...patch }))

async function git($: EngineInterface, cwd: string, args: string[]): Promise<string | undefined> {
  const r = await $.process.run(['git', '-C', cwd, ...args]).catch(() => undefined)
  return r && r.exitCode === 0 ? r.stdout : undefined
}

// Runs at the end of a main-loop turn; a reviewer already running, an unchanged diff or a small one end it quietly.
async function maybeReview($: EngineInterface, ctx: Ctx): Promise<void> {
  const now = await $.clock.now()
  if (ctx.runningId !== undefined || ctx.isSpawning) {
    if (now - ctx.startedAt < STALE_MS) return
    ctx.runningId = undefined
    ctx.isSpawning = false
  }
  // The diff hash is left alone during the cooldown, so the next turn after it still reviews.
  if (ctx.lastReviewAt && now - ctx.lastReviewAt < ctx.cooldownMs) return
  const stat = await git($, ctx.cwd, ['diff', 'HEAD', '--stat'])
  if (stat === undefined) return
  const hash = hashText(stat)
  if (hash === ctx.lastStat) return
  ctx.lastStat = hash
  if (stat.trim() === '') return

  const diff = await git($, ctx.cwd, ['diff', 'HEAD'])
  if (diff === undefined) return
  const lines = changedLines(diff)
  if (lines < ctx.minLines) return

  ctx.isSpawning = true
  ctx.startedAt = now
  ctx.lastReviewAt = now
  await set($, { status: 'running', findings: [], lines, message: '', isDismissed: false })
  const spawned = await $.agent
    .spawn({ subagentType: REVIEWER_TYPE, prompt: buildTask(diff), description: 'rival: review the diff', model: ctx.model })
    .catch((err: unknown) => ({ deny: String(err) }))
  // The id is the engine's to set; a run that did not state it is found in the agent list.
  const id = spawned.deny === undefined ? (spawned.agentId ?? (await newestReviewer($))) : undefined
  ctx.isSpawning = false
  if (id === undefined) {
    await set($, { status: 'error', message: spawned.deny ?? 'the reviewer did not start' })
    return
  }
  ctx.runningId = id
}

async function newestReviewer($: EngineInterface): Promise<string | undefined> {
  const agents = await $.agent.list().catch(() => [])
  return agents.filter(a => a.type === REVIEWER_TYPE && !['completed', 'failed', 'killed'].includes(a.status)).at(-1)?.id
}

async function finish($: EngineInterface, ctx: Ctx, answer: string, reason: string): Promise<void> {
  ctx.runningId = undefined
  if (reason !== 'answer') return void (await set($, { status: 'error', message: `the reviewer ended early (${reason})` }))
  const findings = parseFindings(answer, ctx.minConfidence)
  if (findings === undefined) return void (await set($, { status: 'error', message: 'the reviewer did not answer in JSON' }))
  await set($, { status: 'done', findings, message: '' })
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'rival', focus: true, closeOnEscape: true })
}

async function fixThese($: EngineInterface, findings: readonly RivalFinding[]) {
  await set($, { isDismissed: true })
  await $.ui.close({ id: PANE }).catch(() => undefined)
  await $.prompt.submit({ text: fixPrompt(findings) })
}

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    isOn: options.enabled !== false,
    model: typeof options.model === 'string' && options.model.trim() ? options.model.trim() : 'sonnet',
    minLines: typeof options.minLines === 'number' ? options.minLines : 20,
    minConfidence: typeof options.minConfidence === 'number' ? options.minConfidence : 50,
    cwd: '',
    lastStat: '',
    runningId: undefined,
    isSpawning: false,
    startedAt: 0,
    cooldownMs: (typeof options.cooldownMinutes === 'number' ? options.cooldownMinutes : 10) * 60_000,
    lastReviewAt: 0,
  }

  on('session.start', async ($, e, next) => {
    ctx.cwd = e.cwd
    await update($, review, () => initial)
    if (ctx.isOn) {
      // Read-only by tool list; the tool.call hook below narrows Bash to git diff, log, show, grep and blame.
      await $.agent
        .register({
          name: 'reviewer',
          description: 'Internal second reviewer for the rival plugin. Not for delegation.',
          prompt: REVIEWER_PROMPT,
          tools: REVIEWER_TOOLS,
          disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent'],
          model: ctx.model,
          maxTurns: 14,
          omitClaudeMd: true,
          background: true,
        })
        .catch(err => $.ui.log(`rival: could not register the reviewer (${String(err)})`))
    }
    return next(e)
  })

  // The reviewer is rival's own: the model never sees it listed or can dispatch it.
  on('agent.offer', { agent: 'rival:reviewer' }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))

  on('tool.call', async ($, e, next) => {
    // A subagent that is rival's reviewer; before spawn() returns its id, any subagent during the spawn counts.
    const isReviewer = e.agentId !== undefined && (e.agentId === ctx.runningId || (ctx.isSpawning && ctx.runningId === undefined))
    if (!isReviewer) return next(e)
    const tool = String(e.tool)
    if (!isReviewerTool(tool)) return { deny: 'rival: the reviewer is read-only.' }
    if (e.tool === 'Bash' && !isReviewerBash(e.command)) return { deny: 'rival: Bash runs one plain git diff, log, show, grep or blame (git -C <dir> for another folder; no cd, && or pipes). Read files with Read, Grep and Glob.' }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'rival: its guard failed; retry once.' }))

  on('turn.complete', async ($, e, next) => {
    if (!ctx.isOn) return next(e)
    if (e.agentId !== undefined) {
      if (e.agentId === ctx.runningId) await finish($, ctx, e.answer, e.reason)
    } else if (e.reason === 'answer') {
      await maybeReview($, ctx).catch(err => set($, { status: 'error', message: String(err).slice(0, 200) }))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const s = await read($, review)
    if (!ctx.isOn || e.props.hasSurvey || s.status === 'idle' || s.isDismissed) return rest
    const { Box, Text, Button } = $.ui.resolve(e)
    const n = s.findings.length
    const mine =
      s.status === 'running' ? (
        <Text dimColor>rival: reviewing {s.lines} changed lines…</Text>
      ) : s.status === 'error' ? (
        <Box>
          <Text dimColor>rival: {s.message} </Text>
          <Button key="dismiss" label="Dismiss" onPress={() => set($, { isDismissed: true })} />
        </Box>
      ) : (
        <Box>
          <Text>
            rival: {n === 0 ? 'no findings' : `${n} finding${n === 1 ? '' : 's'}`}{' '}
          </Text>
          {n > 0 && <Button key="show" label="Show" onPress={() => openPane($)} />}
          {n > 0 && <Button key="fix" label="Fix these" variant="primary" onPress={() => fixThese($, s.findings)} />}
          <Button key="dismiss" label="Dismiss" onPress={() => set($, { isDismissed: true })} />
        </Box>
      )
    return (
      <Box flexDirection="column">
        {mine}
        {rest}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, review)
    return (
      <Box flexDirection="column">
        {s.findings.length === 0 && <Text dimColor>No findings.</Text>}
        {s.findings.map((f, i) => (
          <Box key={`f${i}`} flexDirection="column" marginBottom={1}>
            <Text bold>
              {where(f)} <Text dimColor>({f.confidence}% sure)</Text>
            </Text>
            <Text>{f.title}</Text>
            <Text dimColor>{f.scenario}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
