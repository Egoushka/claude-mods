import { atom, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CliTool } from '../types'
import { buildArgv, checkArgs, formatResult, inputSchema, parseTools } from './lib'

const registered = atom({ plugin: 'cli-tools', key: 'tools' } as const, [] as string[])
// Fields of a tool.call event that are the engine's, not the model's arguments.
const ENGINE_FIELDS = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta'])

async function registerAll($: EngineInterface, tools: readonly CliTool[]) {
  const names: string[] = []
  for (const t of tools) {
    await $.tool.register({ name: t.name, description: t.description, inputSchema: inputSchema(t), isDeferred: false })
    names.push(t.name)
  }
  await update($, registered, () => names)
}

async function runTool($: EngineInterface, tool: CliTool, e: Record<string, unknown>, maxChars: number) {
  const input: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e)) if (!ENGINE_FIELDS.has(k)) input[k] = v
  const checked = checkArgs(tool, input)
  if ('error' in checked) return { result: `${tool.name}: ${checked.error}`, isError: true as const }
  const built = buildArgv(tool, checked.values)
  if ('error' in built) return { result: `${tool.name}: ${built.error}`, isError: true as const }
  try {
    const r = await $.process.run(built.argv, { timeoutMs: tool.timeoutMs })
    return { result: formatResult(r, maxChars), ...(r.exitCode === 0 ? {} : { isError: true as const }) }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return { result: `${tool.name}: could not run ${built.argv[0]}: ${why} (timeout ${tool.timeoutMs} ms)`, isError: true as const }
  }
}

export const register: Register = (on, options) => {
  const parsed = parseTools(typeof options.tools === 'string' ? options.tools : '')
  const byName = new Map(parsed.tools.map(t => [t.name, t]))
  const maxChars = typeof options.maxOutputChars === 'number' && options.maxOutputChars > 0 ? options.maxOutputChars : 20000

  on('session.start', async ($, e, next) => {
    await registerAll($, parsed.tools)
    await $.command.register({ name: 'cli-tools', description: 'List the shell commands exposed as tools' })
    if (parsed.errors.length) $.ui.toast(`cli-tools: ${parsed.errors.length} problem(s) in the tools setting; run /cli-tools`)
    return next(e)
  })

  on('command.run', { command: 'cli-tools' }, () => {
    const lines = parsed.tools.map(t => `${t.name}: ${t.argv.join(' ')}`)
    const problems = parsed.errors.map(m => `problem: ${m}`)
    const all = [...lines, ...problems]
    return { text: all.length ? all.join('\n') : 'No tools configured. Set "tools" in the plugin settings.' }
  })

  on('tool.call', async ($, e, next) => {
    const prefix = `mcp__${$.plugin.name}__`
    const name = String(e.tool)
    const tool = name.startsWith(prefix) ? byName.get(name.slice(prefix.length)) : undefined
    if (!tool) return next(e)
    return runTool($, tool, e as unknown as Record<string, unknown>, maxChars) as never
  }).catch(($, e, next) =>
    String(e.tool).startsWith(`mcp__${$.plugin.name}__`) ? { deny: 'cli-tools: the tool failed unexpectedly; retry once.' } : next(e),
  )
}
