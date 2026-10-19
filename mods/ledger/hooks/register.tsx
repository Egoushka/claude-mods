import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Hours } from '../types'
import {
  accrue,
  baseName,
  dayKey,
  fmtDuration,
  goalLine,
  mergeTarget,
  postPrompt,
  repoFromRemote,
  slugify,
  stamp,
  summarize,
  toCsv,
} from './time'

const PANE = 'hours'
const hours = atom({ plugin: 'ledger', key: 'hours' } as const, {} as Hours)

function compile(source: unknown): RegExp | undefined {
  if (typeof source !== 'string' || source.trim() === '') return undefined
  try {
    return new RegExp(source, 'i')
  } catch {
    return undefined
  }
}

// Read-modify-write against the store so two sessions in different repos do not overwrite each other.
async function addActive($: EngineInterface, repo: string, ms: number, now: number) {
  if (ms <= 0) return
  const stored = ((await $.store.get('hours')) ?? {}) as Hours
  const next = accrue(stored, repo, dayKey(now), ms)
  await $.store.set('hours', next)
  await update($, hours, () => next)
}

async function repoRoot($: EngineInterface, cwd: string): Promise<string> {
  const r = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel']).catch(() => undefined)
  const top = r?.exitCode === 0 ? r.stdout.trim() : ''
  return top || cwd
}

async function exportCsv($: EngineInterface, path: string, surface: RenderSurface) {
  const csv = toCsv(await read($, hours))
  if (path) {
    await $.fs.write(path, csv)
    $.ui.toast(`ledger: wrote ${path}`)
    return
  }
  const copied = await $.ui.copy({ text: csv, surface })
  $.ui.toast(copied.isCopied ? 'ledger: CSV copied to the clipboard' : 'ledger: no clipboard here; set a CSV export path')
}

type PullRequest = { title: string; body: string; url: string; state: string }

async function viewPr($: EngineInterface, root: string, selector: string | undefined, repo?: string): Promise<PullRequest | undefined> {
  const argv = ['gh', 'pr', 'view', ...(selector ? [selector] : []), ...(repo ? ['-R', repo] : []), '--json', 'title,body,url,state']
  const r = await $.process.run(argv, { cwd: root }).catch(() => undefined)
  if (!r || r.exitCode !== 0) return undefined
  try {
    const pr = JSON.parse(r.stdout) as Partial<PullRequest>
    return { title: pr.title ?? '', body: pr.body ?? '', url: pr.url ?? '', state: pr.state ?? '' }
  } catch {
    return undefined
  }
}

// A merged pull request in a public repo becomes a markdown draft on disk. Nothing is posted anywhere.
async function draftPost(
  $: EngineInterface,
  root: string,
  pr: PullRequest,
  publicRepos: RegExp,
  dir: string,
  model: string,
): Promise<boolean> {
  const remote = await $.process.run(['git', '-C', root, 'remote', 'get-url', 'origin']).catch(() => undefined)
  const slug = (remote?.exitCode === 0 ? repoFromRemote(remote.stdout) : undefined) ?? baseName(root)
  if (!publicRepos.test(slug) && !publicRepos.test(root)) return false

  const done = (((await $.store.get('drafted')) as string[] | undefined) ?? []).slice(-200)
  if (pr.url && done.includes(pr.url)) return false

  const reply = await $.model.complete({ model, prompt: postPrompt(pr, slug), maxTokens: 400, timeoutMs: 60000 })
  if (!reply.isAnswered) {
    $.ui.toast(`ledger: no draft for ${pr.title} (${reply.reason})`)
    return false
  }
  const now = await $.clock.now()
  const path = `${dir.replace(/\/+$/, '')}/${stamp(now)}-${slugify(pr.title)}.md`
  await $.fs.write(path, `# ${pr.title}\n\n${pr.url}\n\n---\n\n${reply.text.trim()}\n`)
  await $.store.set('drafted', [...done, pr.url])
  $.ui.toast(`ledger: post drafted at ${path}`)
  return true
}

// gh pr merge --auto merges later; look again when a turn ends.
async function checkPending(
  $: EngineInterface,
  root: string,
  pending: { selector?: string; repo?: string }[],
  publicRepos: RegExp,
  dir: string,
  model: string,
) {
  for (const item of pending.splice(0)) {
    const pr = await viewPr($, root, item.selector, item.repo)
    if (pr?.state === 'MERGED') await draftPost($, root, pr, publicRepos, dir, model).catch(() => false)
    else if (pr?.state === 'OPEN') pending.push(item)
  }
}

export const register: Register = (on, options) => {
  const idleMs = Math.max(1, typeof options.idleMinutes === 'number' ? options.idleMinutes : 10) * 60000
  const csvPath = typeof options.csvPath === 'string' ? options.csvPath.trim() : ''
  const rate = typeof options.hourlyRate === 'number' ? options.hourlyRate : 0
  const goal = typeof options.monthlyGoal === 'number' ? options.monthlyGoal : 0
  const currency = typeof options.currency === 'string' && options.currency ? options.currency : 'USD'
  const publicRepos = compile(options.publicRepos)
  const draftsDir = typeof options.draftsDir === 'string' ? options.draftsDir.trim() : ''
  const draftModel = typeof options.draftModel === 'string' && options.draftModel ? options.draftModel : 'haiku'
  const isDrafting = publicRepos !== undefined && draftsDir !== ''

  // Per-session bookkeeping; a reload starts it over, losing at most the open gap.
  let repo = ''
  let lastActivity = 0
  let isRunning = false
  const pending: { selector?: string; repo?: string }[] = []

  on('session.start', async ($, e, next) => {
    repo = await repoRoot($, e.cwd)
    const stored = (await $.store.get('hours')) as Hours | undefined
    await update($, hours, () => stored ?? {})
    await $.command.register({ name: 'hours', description: 'Active hours per repo: today, this week, this month' })
    return next(e)
  })

  // The gap since the last activity counts as work when it is shorter than the idle limit.
  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    if (!e.isMeta && !isRunning) {
      const gap = now - lastActivity
      if (lastActivity > 0 && gap < idleMs && repo) await addActive($, repo, gap, now)
      lastActivity = now
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) isRunning = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      isRunning = false
      const now = await $.clock.now()
      if (repo) await addActive($, repo, e.durationMs, now)
      lastActivity = now
      if (isDrafting && publicRepos) await checkPending($, repo, pending, publicRepos, draftsDir, draftModel)
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const target = isDrafting ? mergeTarget(e.command) : undefined
    const ran = await next(e)
    if (!target || ran.deny !== undefined || ran.isError) return ran
    const root = repo
    $.clock.after(0, () => {
      void (async () => {
        const pr = await viewPr($, root, target.selector, target.repo)
        if (!pr || !publicRepos) return
        if (pr.state === 'MERGED') await draftPost($, root, pr, publicRepos, draftsDir, draftModel)
        else if (target.isAuto && pr.state === 'OPEN') pending.push({ selector: target.selector, repo: target.repo })
      })().catch(() => undefined)
    })
    return ran
  })

  on('command.run', { command: 'hours' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Hours', focus: true, closeOnEscape: true })
    return { text: 'Hours pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const data = await read($, hours)
    const now = await $.clock.now()
    const { rows, total } = summarize(data, now)
    const goalText = goalLine(total.month, now, rate, goal, currency)
    const name = Math.max(8, Math.min(28, e.props.bodyColumns - 30))
    const cell = (text: string) => text.padStart(9)
    const line = (label: string, a: string, b: string, c: string) =>
      `${label.length > name ? `${label.slice(0, name - 1)}…` : label.padEnd(name)}${cell(a)}${cell(b)}${cell(c)}`

    return (
      <Box flexDirection="column">
        {goalText && <Text bold>{goalText}</Text>}
        <Text dimColor>{line('repo', 'today', 'week', 'month')}</Text>
        {rows.length === 0 && <Text dimColor>No active time recorded yet.</Text>}
        {rows.map(r => (
          <Text key={r.repo}>{line(baseName(r.repo), fmtDuration(r.today), fmtDuration(r.week), fmtDuration(r.month))}</Text>
        ))}
        {rows.length > 1 && <Text bold>{line('all', fmtDuration(total.today), fmtDuration(total.week), fmtDuration(total.month))}</Text>}
        <Box marginTop={1}>
          <Button key="export" label={csvPath ? 'Export CSV' : 'Copy CSV'} hotkey="e" onPress={press => exportCsv($, csvPath, press.surface)} />
        </Box>
      </Box>
    )
  })
}
