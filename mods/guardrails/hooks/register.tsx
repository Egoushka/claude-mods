import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GuardStats } from '../types'
import {
  boundaryDenial,
  budgetFor,
  compile,
  irreversibleKind,
  maskSecrets,
  repoFromRemote,
  shellCorrection,
} from './rules'
import type { Boundary } from './rules'

const initial: GuardStats = { isInside: false, masked: 0, corrected: 0, denied: 0, added: 0, removed: 0, budget: null }
const stats = atom({ plugin: 'guardrails', key: 'stats' } as const, initial)

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const normalize = (command: string) => command.trim().replace(/\s+/g, ' ')

function bump($: EngineInterface, patch: (s: GuardStats) => Partial<GuardStats>) {
  return update($, stats, s => ({ ...s, ...patch(s) }))
}

async function refreshStatus($: EngineInterface) {
  const s = await read($, stats)
  const parts: string[] = []
  if (s.isInside) parts.push('inside boundary')
  if (s.masked) parts.push(`${s.masked} masked`)
  if (s.corrected) parts.push(`${s.corrected} corrected`)
  if (s.denied) parts.push(`${s.denied} stopped`)
  if (s.added || s.removed) parts.push(`diff +${s.added} −${s.removed}${s.budget ? ` of ${s.budget}` : ''}`)
  $.ui.status(parts.length ? `guard: ${parts.join(' · ')}` : undefined)
}

async function deny($: EngineInterface, reason: string) {
  await bump($, s => ({ denied: s.denied + 1 }))
  await refreshStatus($)
  return { deny: `guardrails: ${reason}` }
}

// Lines changed against HEAD; the toast fires once per budget.
async function measureDiff($: EngineInterface, cwd: string, isToastShown: boolean): Promise<boolean> {
  const r = await $.process.run(['git', '-C', cwd, 'diff', 'HEAD', '--numstat']).catch(() => undefined)
  if (!r || r.exitCode !== 0) return isToastShown
  let added = 0
  let removed = 0
  for (const line of r.stdout.split('\n')) {
    const [a, d] = line.split('\t')
    added += Number(a) || 0
    removed += Number(d) || 0
  }
  const s = await bump($, () => ({ added, removed }))
  await refreshStatus($)
  if (!s.budget || added + removed <= s.budget || isToastShown) return isToastShown
  $.ui.toast(`guardrails: the diff is ${added + removed} lines, past this task's budget of ${s.budget}. Smallest change?`)
  return true
}

export const register: Register = (on, options) => {
  const boundary: Boundary = {
    paths: compile(options.boundaryPaths),
    fencedTools: compile(options.fencedTools),
    fencedHosts: compile(options.fencedHosts),
    insideOnlyTools: compile(options.insideOnlyTools),
  }
  const isMasking = options.maskSecrets !== false
  const isSecondOpinionOn = options.secondOpinion !== false
  const isFixingShell = options.shellFixes !== false
  const isBreakingLoops = options.loopBreaker !== false
  const budgetOption = typeof options.diffBudget === 'number' ? options.diffBudget : 0
  const fixedBudget = budgetOption > 0 ? budgetOption : null

  // Per-session bookkeeping; a reload starts it over, which is fine for counters this short-lived.
  let cwd = ''
  let isInside = false
  let isOverBudgetToastShown = false
  const failures = new Map<string, number>()
  const edits = new Map<string, { old: string; new: string; flips: number }>()
  const approved = new Set<string>()

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    isInside = boundary.paths?.test(cwd) ?? false
    await update($, stats, () => ({ ...initial, isInside, budget: fixedBudget }))
    await refreshStatus($)
    return next(e)
  })

  // Secrets in tool output are masked before the model reads them.
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    if (!isMasking) return next(e)
    let count = 0
    const mask = (text: string) => {
      const m = maskSecrets(text)
      count += m.count
      return m.text
    }
    const content = e.message.content.map(block => {
      if (block.type !== 'tool_result') return block
      if (typeof block.content === 'string') return { ...block, content: mask(block.content) }
      if (!Array.isArray(block.content)) return block
      return {
        ...block,
        content: block.content.map((inner: { type?: unknown; text?: unknown }) =>
          inner?.type === 'text' && typeof inner.text === 'string' ? { ...inner, text: mask(inner.text) } : inner,
        ),
      }
    })
    if (count === 0) return next(e)
    await bump($, s => ({ masked: s.masked + count }))
    await refreshStatus($)
    return next({ ...e, message: { ...e.message, content } })
  })

  // The diff budget is sized per task by a quick classification unless one is fixed.
  on('prompt.submit', async ($, e, next) => {
    if (budgetOption === 0 && !e.command && !e.isMeta && e.text.trim().length > 15) {
      void $.model
        .classify(e.text.slice(0, 2000), ['tiny', 'small', 'medium', 'large'], { model: 'haiku' })
        .then(async size => {
          isOverBudgetToastShown = false
          await bump($, () => ({ budget: budgetFor(size) }))
          await refreshStatus($)
        })
        .catch(() => undefined)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)

    const crossing = boundaryDenial(boundary, isInside, tool, e as unknown as Record<string, unknown>)
    if (crossing) return deny($, crossing)

    let rewritten: string | undefined
    const notes: string[] = []

    if (e.tool === 'Bash') {
      const key = normalize(e.command)

      if (isBreakingLoops && (failures.get(key) ?? 0) >= 3)
        return deny($, 'this exact command failed 3 times in a row. Stop retrying it: read the error, change the approach, or ask the person.')

      if (isFixingShell) {
        const c = shellCorrection(e.command)
        if (c.deny) return deny($, c.deny)
        if (c.cdGh) {
          const remote = await $.process.run(['git', '-C', c.cdGh.dir, 'remote', 'get-url', 'origin']).catch(() => undefined)
          const repo = remote?.exitCode === 0 ? repoFromRemote(remote.stdout) : undefined
          if (!repo) return deny($, 'gh works here only as a standalone call: drop the `cd … &&` and pass `-R owner/repo`.')
          rewritten = `${c.cdGh.gh} -R ${repo}`
          notes.push(`guardrails rewrote \`cd … && gh\` to \`${rewritten}\` (gh works only as a standalone call here).`)
        } else if (c.fix) {
          rewritten = c.fix.command
          notes.push(`guardrails rewrote the command to \`${rewritten}\`: ${c.fix.why}`)
        }
        if (rewritten) await bump($, s => ({ corrected: s.corrected + 1 }))
      }

      const command = rewritten ?? e.command
      const kind = irreversibleKind(command)
      if (kind && isSecondOpinionOn && !approved.has(normalize(command))) {
        $.ui.status(`guard: second opinion on ${kind}…`)
        const reply = await $.model.fork({
          prompt:
            `A guard paused this shell command (${kind}) before it runs:\n\n${command}\n\n` +
            'Judge only from this conversation, counting standing instructions (CLAUDE.md, project rules) and tool output already in it as evidence. ' +
            'ALLOW when the person asked for it, a standing rule calls for it, or the output shows it is the expected next step ' +
            '(say, deleting a branch whose merge the output shows). DENY when it could destroy work not shown to be saved elsewhere, ' +
            'or when it aims at the wrong target. Reply with exactly one line: "ALLOW: <reason>" or "DENY: <reason>".',
        })
        await refreshStatus($)
        if (reply.isAnswered) {
          const line = reply.text.trim().split('\n')[0] ?? ''
          if (/^\W*DENY/i.test(line))
            return deny(
              $,
              `second opinion on ${kind}: ${line.replace(/^\W*DENY:?\s*/i, '')} Ask the person to confirm this exact command, then retry.`,
            )
          approved.add(normalize(command))
        } else {
          $.ui.toast(`guardrails: no second opinion (${reply.reason}); the ${kind} went ahead`)
        }
      }
    }

    if (isBreakingLoops && e.tool === 'Edit') {
      const prev = edits.get(e.file_path)
      const flips = prev && prev.old === e.new_string && prev.new === e.old_string ? prev.flips + 1 : 0
      if (flips >= 2)
        return deny($, `this Edit flips ${e.file_path} back again (${flips + 1} times). Decide which version is right before editing.`)
      edits.set(e.file_path, { old: e.old_string, new: e.new_string, flips })
    }

    const ran = await next(e.tool === 'Bash' && rewritten ? { ...e, command: rewritten } : e)
    if (ran.deny !== undefined) return ran

    if (e.tool === 'Bash') {
      const key = normalize(e.command)
      if (ran.isError) failures.set(key, (failures.get(key) ?? 0) + 1)
      else failures.delete(key)
    }

    if (budgetOption >= 0 && EDIT_TOOLS.has(tool) && !ran.isError)
      void measureDiff($, cwd, isOverBudgetToastShown).then(shown => (isOverBudgetToastShown = shown))

    if (notes.length === 0) return ran
    await refreshStatus($)
    return { ...ran, context: [...(ran.context ?? []), ...notes] }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'guardrails: its guard failed; retry once.' }))
}
