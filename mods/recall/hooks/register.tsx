import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Candidate, FrictionEntry, FrictionKind, Recalled } from '../types'
import {
  brief,
  describeCall,
  draftRulePrompt,
  extractMemories,
  fillTemplate,
  frictionLine,
  likelyTests,
  memoryContext,
  mentionContext,
  nextCandidate,
  similarity,
  stemOf,
  verbPrompt,
} from './recall'
import type { Group } from './recall'

const memories = atom({ plugin: 'recall', key: 'memories' } as const, null)
const candidate = atom({ plugin: 'recall', key: 'candidate' } as const, null)
const friction = atom({ plugin: 'recall', key: 'friction' } as const, [])

const MEMORY_PANE = 'recall-memories'
const FRICTION_PANE = 'recall-friction'
const RECALL_TIMEOUT_MS = 3000
const SAME_KIND_THRESHOLD = 0.6
const MAX_FRICTION = 200
const MAX_GROUPS = 50

const text = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)

type Settings = {
  memoryServer: string
  recallTool: string
  recallArgs: string
  maxChars: number
  smartMentions: boolean
  harvest: boolean
  instructionsFile: string
  frictionFile: string
  retainServer: string
  retainTool: string
  retainArgs: string
}

// Resolves to the promise's value, or undefined when it fails or `ms` pass first.
async function within<T>($: EngineInterface, work: Promise<T>, ms: number): Promise<T | undefined> {
  const stop = new AbortController()
  const timer = $.clock.sleep(ms, { signal: stop.signal }).then(
    () => undefined,
    () => undefined,
  )
  const done = work.then(
    value => value,
    () => undefined,
  )
  const winner = await Promise.race([done, timer])
  stop.abort()
  return winner
}

async function recallMemories($: EngineInterface, s: Settings, prompt: string): Promise<Recalled | null> {
  const args = fillTemplate(s.recallArgs, 'query', prompt.slice(0, 1000))
  if (!args) return null
  const result = await within($, $.mcp.call(s.memoryServer, s.recallTool, args), RECALL_TIMEOUT_MS)
  if (!result || result.isError) return null
  const items = extractMemories(result, s.maxChars)
  if (items.length === 0) return null
  return { query: brief(prompt, 80), items, at: await $.clock.now() }
}

async function recordFriction($: EngineInterface, s: Settings, project: string, kind: FrictionKind, evidence: string) {
  const entry: FrictionEntry = { at: await $.clock.now(), kind, evidence: brief(evidence, 200) }
  const list = await update($, friction, old => [...old, entry].slice(-MAX_FRICTION))
  await $.store.set(`friction:${project}`, list).catch(() => undefined)
  if (!s.frictionFile) return
  const line = `${frictionLine(entry.at, kind, entry.evidence)}\n`
  const old = await $.fs.read(s.frictionFile).catch(() => '')
  await $.fs.write(s.frictionFile, (typeof old === 'string' ? old : '') + line).catch(() => undefined)
}

const groupsKey = (project: string) => `corrections:${project}`

async function loadGroups($: EngineInterface, project: string): Promise<Group[]> {
  const v = await $.store.get(groupsKey(project))
  return Array.isArray(v) ? (v as Group[]) : []
}

async function saveGroups($: EngineInterface, project: string, groups: Group[]) {
  await $.store.set(groupsKey(project), groups.slice(-MAX_GROUPS))
  const next = nextCandidate(groups)
  await update($, candidate, () => (next ? { id: next.id, summary: next.summary } : null))
}

async function sameKind($: EngineInterface, groups: readonly Group[], summary: string): Promise<Group | undefined> {
  const open = groups.filter(g => g.status !== 'dismissed')
  const close = open.find(g => similarity(g.summary, summary) >= SAME_KIND_THRESHOLD)
  if (close || open.length === 0) return close
  const recent = open.slice(-15)
  const reply = await $.model.complete({
    model: 'haiku',
    prompt:
      `Known corrections:\n${recent.map((g, i) => `${i + 1}. ${g.summary}`).join('\n')}\n\nNew correction: ${summary}\n\n` +
      'If the new one asks for the same thing as a known one, reply with that number; otherwise reply 0. Reply with the number only.',
    timeoutMs: 8000,
  })
  if (!reply.isAnswered) return undefined
  const n = Number.parseInt(reply.text.trim(), 10)
  return Number.isInteger(n) && n >= 1 && n <= recent.length ? recent[n - 1] : undefined
}

// Runs in the background after a prompt: classify, summarize, group, maybe raise a rule candidate.
async function harvest($: EngineInterface, s: Settings, project: string, prompt: string, assistant: string) {
  const label = await $.model.classify(
    `What the assistant just did or said:\n${brief(assistant, 600)}\n\nThe person's reply:\n${brief(prompt, 600)}\n\n` +
      'Is the reply correcting something the assistant did (wrong approach, ignored instruction, repeated mistake)?',
    ['correcting', 'not-correcting'],
    { model: 'haiku' },
  )
  if (label !== 'correcting') return
  const sum = await $.model.complete({
    model: 'haiku',
    prompt:
      `The assistant did: ${brief(assistant, 600)}\nThe person corrected it: ${brief(prompt, 600)}\n\n` +
      'State the general rule the person wants followed, as one imperative sentence of at most 14 words. No quotes, no preamble.',
    timeoutMs: 8000,
  })
  if (!sum.isAnswered) return
  const summary = brief(sum.text, 140)
  if (!summary) return
  const groups = await loadGroups($, project)
  const hit = await sameKind($, groups, summary).catch(() => undefined)
  const now = await $.clock.now()
  if (hit) {
    hit.count += 1
    hit.at = now
  } else groups.push({ id: `c${now}`, summary, count: 1, at: now, status: 'open' })
  await saveGroups($, project, groups)
  await recordFriction($, s, project, 'correction', summary)
}

async function setStatus($: EngineInterface, project: string, id: string, status: Group['status']) {
  const groups = await loadGroups($, project)
  const g = groups.find(one => one.id === id)
  if (g) g.status = status
  await saveGroups($, project, groups)
}

async function draftRule($: EngineInterface, s: Settings, project: string, c: Candidate) {
  await setStatus($, project, c.id, 'drafted')
  void $.prompt.submit({ text: draftRulePrompt(c.summary, s.instructionsFile) })
}

async function git($: EngineInterface, cwd: string, args: string[]): Promise<string[]> {
  const r = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 4000 }).catch(() => undefined)
  if (!r || r.exitCode !== 0) return []
  return r.stdout.split('\n').filter(Boolean)
}

async function mentionLookup($: EngineInterface, path: string): Promise<string | undefined> {
  const dir = path.slice(0, path.lastIndexOf('/')) || '/'
  const [root] = await git($, dir, ['rev-parse', '--show-toplevel'])
  if (!root) return undefined
  const rel = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
  const stem = stemOf(rel)
  const [commits, files, refs] = await Promise.all([
    git($, root, ['log', '-n', '5', '--date=short', '--format=%h %ad %s', '--', rel]),
    git($, root, ['ls-files']),
    stem.length >= 3 ? git($, root, ['grep', '-l', '-w', '-F', '-e', stem, '--', '.', `:(exclude)${rel}`]) : Promise.resolve([] as string[]),
  ])
  const tests = likelyTests(files, rel)
  return mentionContext(rel, commits, tests, refs.filter(f => !tests.includes(f)).slice(0, 8), stem)
}

type Args = Record<string, unknown>

const failed = () => ({ text: 'recall: that command failed; try again.' })

async function retain($: EngineInterface, s: Settings, project: string, selected: string): Promise<string> {
  if (s.retainServer) {
    const args = fillTemplate(s.retainArgs, 'text', selected)
    if (!args) return 'recall: retainArgs is not a JSON object; nothing saved.'
    const r = await within($, $.mcp.call(s.retainServer, s.retainTool, args as Args), 10000)
    if (!r) return `recall: ${s.retainServer} did not answer in time; nothing saved.`
    if (r.isError) return `recall: ${s.retainServer} reported an error; nothing saved.`
    return `Saved to ${s.retainServer}.`
  }
  const key = `notes:${project}`
  const old = await $.store.get(key)
  const notes = Array.isArray(old) ? old : []
  await $.store.set(key, [...notes, { at: await $.clock.now(), text: selected }].slice(-100))
  return `Saved to the plugin store (${notes.length + 1} notes for this project). Set retainServer to save elsewhere.`
}

async function verb($: EngineInterface, s: Settings, project: string, kind: 'verify' | 'why' | 'remember', args: string) {
  const selected = (await $.ui.selection())?.text.trim() ?? ''
  if (!selected && !(kind === 'remember' && args.trim()))
    return { text: `Nothing is selected. Select text with the mouse (fullscreen mode), then run /${kind}.` }
  if (kind === 'remember') return { text: await retain($, s, project, selected || args.trim()) }
  const draft = await $.prompt.read()
  const body = verbPrompt(kind, selected, args)
  const filled = await $.prompt.fill(draft.text.trim() ? { text: `\n\n${body}`, mode: 'append' } : { text: body })
  return { text: filled.isFilled ? `Put a ${kind} request in the prompt box. Edit it, then press Enter.` : 'The prompt box could not take the text.' }
}

export const register: Register = (on, options) => {
  const s: Settings = {
    memoryServer: text(options.memoryServer).trim(),
    recallTool: text(options.recallTool, 'recall'),
    recallArgs: text(options.recallArgs, '{"query": "{{query}}"}'),
    maxChars: typeof options.maxChars === 'number' && options.maxChars > 0 ? options.maxChars : 2000,
    smartMentions: options.smartMentions !== false,
    harvest: options.harvestCorrections !== false,
    instructionsFile: text(options.instructionsFile, 'CLAUDE.md') || 'CLAUDE.md',
    frictionFile: text(options.frictionFile).trim(),
    retainServer: text(options.retainServer).trim(),
    retainTool: text(options.retainTool, 'retain'),
    retainArgs: text(options.retainArgs, '{"content": "{{text}}"}'),
  }

  // Per-session bookkeeping; a reload starts it over.
  let project = ''
  let lastPrompt = ''
  const failures = new Map<string, number>()

  on('session.start', async ($, e, next) => {
    project = e.cwd
    const saved = await $.store.get(`friction:${project}`)
    await update($, friction, () => (Array.isArray(saved) ? (saved as FrictionEntry[]) : []))
    await update($, memories, () => null)
    const c = nextCandidate(await loadGroups($, project))
    await update($, candidate, () => (c ? { id: c.id, summary: c.summary } : null))
    for (const [name, description] of [
      ['friction', 'Show the friction log: denied or failing tool calls, corrections, interrupted turns'],
      ['verify', 'Put a request to verify the selected text in the prompt box'],
      ['remember', 'Save the selected text to memory'],
      ['why', 'Put a request to explain the selected text in the prompt box'],
    ] as const)
      await $.command.register({ name, description })
    return next(e)
  })

  // Memory ghost and correction harvester both read the person's own prompts.
  on('prompt.submit', async ($, e, next) => {
    // The engine always stamps an origin; a bare one (an engine-less test) counts as typed.
    const origin = e.origin as typeof e.origin | undefined
    const typed = !origin || origin.kind === 'composer' || origin.kind === 'bridge' || (origin.kind === 'plugin' && origin.asUser === true)
    const isPerson = typed && !e.command && !e.isMeta
    if (!isPerson) return next(e)
    lastPrompt = e.text

    if (s.harvest && e.text.trim().length > 12) {
      const messages = await $.session.messages().catch(() => [])
      const assistant = [...messages].reverse().find(m => m.role === 'assistant')
      const said = assistant ? `${assistant.text}\n${assistant.toolUses.map(t => describeCall(t.tool, t.input)).join('\n')}`.trim() : ''
      if (said) void harvest($, s, project, e.text, said).catch(() => undefined)
    }

    if (!s.memoryServer || e.text.trim().length < 3) return next(e)
    const recalled = await recallMemories($, s, e.text).catch(() => null)
    await update($, memories, () => recalled)
    if (!recalled) return next(e)
    return next({ ...e, context: [...(e.context ?? []), memoryContext(recalled.items)] })
  }).catch(($, e, next) => next(e))

  on('prompt.mention', async ($, e, next) => {
    const result = await next(e)
    if (!s.smartMentions || result.deny !== undefined || result.type === null) return result
    const extra = await mentionLookup($, e.path).catch(() => undefined)
    return extra ? { ...result, context: [...(result.context ?? []), extra] } : result
  }).catch(($, e, next) => next(e))

  // Friction: denied calls and calls that keep failing.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const about = describeCall(String(e.tool), e as unknown as Record<string, unknown>)
    if (ran.deny !== undefined) {
      await recordFriction($, s, project, 'denied', `${about}: ${ran.deny}`)
    } else if (ran.isError) {
      const n = (failures.get(about) ?? 0) + 1
      failures.set(about, n)
      if (n === 2 || n === 5) await recordFriction($, s, project, 'errors', `${about} failed ${n} times: ${ran.text ?? ''}`)
    } else failures.delete(about)
    return ran
  }).catch(($, e, next) => next(e))

  on('classic.PermissionDenied', async ($, e, next) => {
    await recordFriction($, s, project, 'denied', `${describeCall(e.tool_name, (e.tool_input ?? {}) as Record<string, unknown>)}: ${e.reason}`)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.reason === 'aborted') await recordFriction($, s, project, 'interrupt', `turn interrupted after: ${lastPrompt}`)
    return next(e)
  })

  on('command.run', { command: 'friction' }, async $ => {
    await $.ui.open({ id: FRICTION_PANE, title: 'Friction log', focus: true })
    return { text: 'Friction log opened.' }
  }).catch(failed)
  on('command.run', { command: 'verify' }, ($, e) => verb($, s, project, 'verify', e.args)).catch(failed)
  on('command.run', { command: 'why' }, ($, e) => verb($, s, project, 'why', e.args)).catch(failed)
  on('command.run', { command: 'remember' }, ($, e) => verb($, s, project, 'remember', e.args)).catch(failed)

  // The band composes: other mods' rows stay below ours.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (e.props.hasSurvey) return rest
    const recalled = await read($, memories)
    const cand = await read($, candidate)
    if (!recalled && !cand) return rest

    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {recalled && (
          <Box>
            <Text dimColor>
              {recalled.items.length} {recalled.items.length === 1 ? 'memory' : 'memories'}{' '}
            </Text>
            <Button key="show-memories" label="Show" onPress={() => $.ui.open({ id: MEMORY_PANE, title: 'Memories', focus: true })} />
          </Box>
        )}
        {cand && (
          <Box>
            <Text dimColor>Rule candidate: {cand.summary} </Text>
            <Button key="draft-rule" label="Draft rule" variant="primary" onPress={() => draftRule($, s, project, cand)} />
            <Button key="dismiss-rule" label="Dismiss" onPress={() => setStatus($, project, cand.id, 'dismissed')} />
          </Box>
        )}
        {rest}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: MEMORY_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const recalled = await read($, memories)
    if (!recalled) return <Text dimColor>No memories for the last prompt.</Text>
    return (
      <Box flexDirection="column">
        <Text dimColor>Recalled for: {recalled.query}</Text>
        {recalled.items.map((item, i) => (
          <Text>
            {i + 1}. {brief(item, 400)}
          </Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: FRICTION_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, friction)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 4)
    if (list.length === 0) return <Text dimColor>No friction recorded in this project yet.</Text>
    return (
      <Box flexDirection="column">
        {[...list]
          .reverse()
          .slice(0, room)
          .map(entry => (
            <Text>
              <Text dimColor>{new Date(entry.at).toISOString().slice(0, 16).replace('T', ' ')} </Text>
              {entry.kind}: {entry.evidence}
            </Text>
          ))}
      </Box>
    )
  })
}
