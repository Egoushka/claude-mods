import { atom, read, update } from 'claude-code'
import type { EngineInterface, NextBudget, Register } from 'claude-code'

import type { ForgeProposal, ForgeSuggestion } from '../types'
import { checkProposal, clip, expandDir, loadHint } from './proposal'
import { HISTORY_CAP, describeSequence, findRepeat, normalizeCall, suggestionPrompt } from './repeats'

const PANE = 'forge'
const TOOL = 'forge'

const proposalAtom = atom({ plugin: 'forge', key: 'proposal' } as const, null)
const suggestionAtom = atom({ plugin: 'forge', key: 'suggestion' } as const, null)

// Per-session bookkeeping; a reload starts it over (a pending proposal then stays in state and /forge-approve still completes it).
type Waiting = { id: string; resolve: ((text: string) => void) | undefined; isDeciding: boolean }
type Ctx = {
  dirTemplate: string
  waitMs: number
  isSuggesting: boolean
  history: string[]
  suggested: string[][]
  waiting: Waiting | undefined
}

const TOOL_DESCRIPTION =
  'Propose a new Claude Code mod (a plugin whose hooks are one TypeScript module) for the person to review. ' +
  'Nothing is written until they approve it in a dialog, and you are told the outcome. ' +
  'Give `name` (a-z, 0-9, "-"), `purpose` (what it does and why, a few sentences) and `files`: an object of relative path to full content, ' +
  'only .ts, .tsx, .json and .md files. Required: ".claude-plugin/plugin.json" (its "name" equal to `name`), "hooks/hooks.json" ' +
  '({"modules":["./register.tsx"]}) and "hooks/register.tsx" exporting `register`. Keep the mod small and say in `purpose` what it can touch. ' +
  'If the result says PENDING, stop and tell the person to answer the dialog; do not call forge again for it.'

async function openPane($: EngineInterface): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: 'forge', focus: true, closeOnEscape: true })
  return opened.isPlaced
}

// Writes the approved files, then asks `claude plugin validate` about them. Never installs or enables anything.
async function writeMod($: EngineInterface, p: ForgeProposal): Promise<{ isOk: boolean; text: string }> {
  if (await $.fs.exists(p.dir)) return { isOk: false, text: `${p.dir} already exists, so nothing was written. Propose again under another name.` }
  try {
    for (const f of p.files) await $.fs.write(`${p.dir}/${f.path}`, f.content)
  } catch (err) {
    return { isOk: false, text: `Writing to ${p.dir} failed (${String(err)}). The folder may hold some of the files; the person should remove it.` }
  }
  const v = await $.process.run(['claude', 'plugin', 'validate', p.dir], { timeoutMs: 60_000 }).catch(() => undefined)
  const verdict = !v
    ? '`claude plugin validate` could not be run.'
    : `\`claude plugin validate\` ${v.exitCode === 0 ? 'passed' : `failed (exit ${v.exitCode})`}:\n${clip((v.stdout + v.stderr).trim(), 2500)}`
  return {
    isOk: true,
    text:
      `Approved. ${p.files.length} files written to ${p.dir}. The mod is not installed or enabled.\n${verdict}\n` +
      `The person loads it with: ${loadHint(p.dir)}` +
      (v && v.exitCode !== 0 ? '\nValidation failed: propose a fixed version under a new name (the folder is never overwritten).' : ''),
  }
}

// One decision per proposal: the dialog's buttons and the two commands all end here.
async function decide($: EngineInterface, ctx: Ctx, isApproved: boolean): Promise<string> {
  const p = await read($, proposalAtom)
  const w = ctx.waiting
  if (!p || p.status !== 'pending') return 'Nothing is waiting for approval.'
  if (w?.isDeciding) return 'A decision is already being carried out.'
  if (w) w.isDeciding = true

  let text: string
  let status: ForgeProposal['status']
  if (isApproved) {
    const done = await writeMod($, p)
    text = done.text
    status = done.isOk ? 'approved' : 'failed'
  } else {
    text = `The person rejected the proposal "${p.name}". Nothing was written. Do not propose it again unless they ask.`
    status = 'rejected'
  }
  await update($, proposalAtom, cur => (cur && cur.id === p.id ? { ...cur, status, result: text } : cur))
  ctx.waiting = undefined

  if (w?.resolve) w.resolve(text)
  else {
    // The tool call returned "pending" long ago: tell the person now, and the model on its next turn.
    $.ui.toast(`forge: ${status === 'approved' ? `${p.name} written to ${p.dir}` : `${p.name} ${status}`}`, { timeoutMs: 8000 })
    await $.session
      .append({ message: { type: 'user', content: [{ type: 'text', text: `forge: ${text}` }] } })
      .catch(() => undefined)
  }
  return text
}

async function propose($: EngineInterface, ctx: Ctx, input: Record<string, unknown>, budget: NextBudget, signal: AbortSignal): Promise<{ result: string } | { deny: string }> {
  if (ctx.waiting) return { deny: 'forge: another proposal is still waiting for the person. Wait for its outcome.' }
  const checked = checkProposal(input)
  if (!checked.ok) return { deny: `forge: the proposal was refused before anyone saw it: ${checked.error}.` }
  const { name, purpose, files } = checked.proposal

  const home = await $.env.get('HOME')
  const dir = expandDir(ctx.dirTemplate, name, home)
  if (dir === undefined) return { deny: 'forge: the forgeDir setting does not resolve to an absolute folder.' }
  if (await $.fs.exists(dir)) return { deny: `forge: ${dir} already exists and is never overwritten. Use another name.` }

  const id = `${name}-${await $.clock.now()}`
  const waiting: Waiting = { id, resolve: undefined, isDeciding: false }
  const answer = new Promise<string>(resolve => (waiting.resolve = resolve))
  // An interrupted call no longer listens: the outcome then goes out as a message.
  signal.addEventListener('abort', () => (waiting.resolve = undefined))
  ctx.waiting = waiting
  await update($, proposalAtom, () => ({ id, name, purpose, dir, files, status: 'pending', result: '' }))
  const isShown = await openPane($)

  // A hook holds about ten seconds of its own time; wait inside that, then hand the answer to a message.
  const room = budget.ms === 0 ? ctx.waitMs : Math.min(ctx.waitMs, budget.remainingMs - 2500)
  if (room > 0) {
    const text = await Promise.race([answer, $.clock.sleep(room).then(() => undefined)])
    if (text !== undefined) return { result: text }
  }
  waiting.resolve = undefined
  return {
    result:
      `PENDING: the person has not answered yet and nothing has been written. The proposal "${name}" is open in the forge dialog` +
      `${isShown ? '' : ' (run /forge-show to open it)'}; they approve with the Approve button or /forge-approve. ` +
      'Do not call forge again for it. Tell the person to answer the dialog, then stop; the outcome reaches you as a message.',
  }
}

async function scanRepeats($: EngineInterface, ctx: Ctx): Promise<void> {
  const found = findRepeat(ctx.history, ctx.suggested)
  if (!found || ctx.waiting) return
  if (await read($, suggestionAtom)) return
  ctx.suggested.push(found)
  await update($, suggestionAtom, () => ({ sequence: found, count: 3 }) satisfies ForgeSuggestion)
}

async function askForTool($: EngineInterface, sequence: string[]) {
  await update($, suggestionAtom, () => null)
  await $.prompt.submit({ text: suggestionPrompt(sequence) })
}

const isPerson = (kind: string) => kind === 'composer' || kind === 'bridge'

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    dirTemplate: typeof options.forgeDir === 'string' ? options.forgeDir : '',
    waitMs: typeof options.approvalWaitSeconds === 'number' ? Math.max(0, options.approvalWaitSeconds) * 1000 : 7000,
    isSuggesting: options.suggestRepeats !== false,
    history: [],
    suggested: [],
    waiting: undefined,
  }

  on('session.start', async ($, e, next) => {
    ctx.history = []
    ctx.suggested = []
    ctx.waiting = undefined
    await update($, proposalAtom, () => null)
    await update($, suggestionAtom, () => null)
    await $.tool.register({
      name: TOOL,
      description: TOOL_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Mod name: a-z, 0-9 and "-".' },
          purpose: { type: 'string', description: 'What the mod does, why, and what it can touch.' },
          files: { type: 'object', additionalProperties: { type: 'string' }, description: 'Relative path to full file content.' },
        },
        required: ['name', 'purpose', 'files'],
      },
    })
    await $.command.register({ name: 'forge-approve', description: 'Approve the mod Claude proposed with forge' })
    await $.command.register({ name: 'forge-reject', description: 'Reject the mod Claude proposed with forge' })
    await $.command.register({ name: 'forge-show', description: 'Open the forge dialog for the pending proposal' })
    return next(e)
  })

  // The only path that can write a file: the person's answer comes first.
  on('tool.call', { tool: 'mcp__forge__forge' }, ($, e, next) => propose($, ctx, e as unknown as Record<string, unknown>, next.budget, next.signal)).catch(
    ($, e, next) => (next.called ? next(e) : { deny: 'forge: its handler failed; nothing was written.' }),
  )

  // Every other shell or MCP call joins the history the repetition scan reads.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!ctx.isSuggesting || ran.deny !== undefined || e.agentId !== undefined) return ran
    const key = normalizeCall(String(e.tool), e as unknown as { command?: unknown })
    if (key) ctx.history = [...ctx.history, key].slice(-HISTORY_CAP)
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (ctx.isSuggesting && e.agentId === undefined && e.reason === 'answer') await scanRepeats($, ctx).catch(() => undefined)
    return next(e)
  })

  // Only the person approves: a command the model, a peer or a schedule raised is refused.
  on('command.run', { command: 'forge-approve' }, async ($, e) =>
    isPerson(e.origin.kind) ? { text: await decide($, ctx, true) } : { text: 'forge: only the person can approve, from the prompt or the dialog.' },
  )
  on('command.run', { command: 'forge-reject' }, async $ => ({ text: await decide($, ctx, false) }))
  on('command.run', { command: 'forge-show' }, async $ => {
    const p = await read($, proposalAtom)
    if (!p) return { text: 'No proposal to show.' }
    await openPane($)
    return { text: `Opened the forge dialog for "${p.name}".` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const p = await read($, proposalAtom)
    const suggestion = await read($, suggestionAtom)
    const isPending = p?.status === 'pending'
    if (e.props.hasSurvey || (!isPending && !suggestion)) return rest
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {isPending && (
          <Box>
            <Text>forge: "{p.name}" awaits your approval </Text>
            <Button key="review" label="Review" variant="primary" onPress={() => openPane($)} />
          </Box>
        )}
        {!isPending && suggestion && (
          <Box>
            <Text>
              Repeated {suggestion.count}×: {describeSequence(suggestion.sequence)} — Forge a tool?{' '}
            </Text>
            <Button key="forge-it" label="Forge a tool" variant="primary" onPress={() => askForTool($, suggestion.sequence)} />
            <Button key="dismiss" label="Dismiss" onPress={() => update($, suggestionAtom, () => null)} />
          </Box>
        )}
        {rest}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const p = await read($, proposalAtom)
    if (!p) return <Text dimColor>No proposal.</Text>
    const isPending = p.status === 'pending'
    return (
      <Box flexDirection="column">
        <Text bold>Forge: {p.name}</Text>
        <Text>{p.purpose}</Text>
        <Text dimColor>
          Writes {p.files.length} files to {p.dir}. A mod runs inside Claude Code with no sandbox: read every file before you approve.
        </Text>
        {isPending ? (
          <Box>
            <Button key="approve" label="Approve" hotkey="a" variant="primary" onPress={() => void decide($, ctx, true)} />
            <Button key="reject" label="Reject" hotkey="r" onPress={() => void decide($, ctx, false)} />
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text bold>{p.status}</Text>
            <Text>{p.result}</Text>
            <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
          </Box>
        )}
        {p.files.map(f => (
          <Box key={f.path} flexDirection="column" marginTop={1}>
            <Text bold>{f.path}</Text>
            <Code source={f.content} path={f.path} startLine={1} />
          </Box>
        ))}
      </Box>
    )
  })
}
