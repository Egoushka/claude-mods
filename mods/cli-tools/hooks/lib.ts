// Pure helpers of the cli-tools mod: config parsing, argument checks, argv building, output shaping.
import type { CliTool, ToolParam } from '../types'

const NAME = /^[A-Za-z0-9_-]{1,64}$/
const PARAM = /^[A-Za-z_][A-Za-z0-9_]*$/
const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g
const TYPES = ['string', 'number', 'integer', 'boolean']
export const DEFAULT_TIMEOUT_MS = 30000
export const MAX_TIMEOUT_MS = 600000

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseTools(raw: string): { tools: CliTool[]; errors: string[] } {
  const text = raw.trim()
  if (!text) return { tools: [], errors: [] }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { tools: [], errors: ['tools: not valid JSON'] }
  }
  if (!Array.isArray(json)) return { tools: [], errors: ['tools: expected a JSON array'] }
  const tools: CliTool[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  json.forEach((item: unknown, i) => {
    const at = `tools[${i}]`
    if (!isRecord(item)) return void errors.push(`${at}: not an object`)
    const name = typeof item.name === 'string' ? item.name : ''
    if (!NAME.test(name)) return void errors.push(`${at}: name must be 1-64 letters, digits, _ or -`)
    if (seen.has(name)) return void errors.push(`${at} (${name}): duplicate name`)
    const description = typeof item.description === 'string' ? item.description.trim() : ''
    if (!description) return void errors.push(`${at} (${name}): description is required`)
    const argv = item.argv
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every(a => typeof a === 'string') || argv[0] === '')
      return void errors.push(`${at} (${name}): argv must be a non-empty array of strings`)
    if ((argv[0] as string).includes('{{')) return void errors.push(`${at} (${name}): the command itself cannot be a parameter`)

    const params: Record<string, ToolParam> = {}
    let isBad = false
    for (const [key, def] of Object.entries(isRecord(item.params) ? item.params : {})) {
      if (!PARAM.test(key) || !isRecord(def) || !TYPES.includes(String(def.type))) {
        errors.push(`${at} (${name}): param "${key}" needs a type of string, number, integer or boolean`)
        isBad = true
        continue
      }
      params[key] = {
        type: def.type as ToolParam['type'],
        description: typeof def.description === 'string' ? def.description : '',
        required: def.required !== false,
        enum: Array.isArray(def.enum) && def.enum.every(v => typeof v === 'string') ? (def.enum as string[]) : undefined,
        allowDash: def.allowDash === true,
      }
    }
    if (isBad) return
    for (const a of argv as string[])
      for (const m of a.matchAll(PLACEHOLDER)) {
        if (params[m[1] ?? ''] === undefined) {
          errors.push(`${at} (${name}): argv uses {{${m[1]}}}, which params does not declare`)
          isBad = true
        }
      }
    if (isBad) return
    const timeout = typeof item.timeoutMs === 'number' && item.timeoutMs > 0 ? Math.min(item.timeoutMs, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS
    seen.add(name)
    tools.push({ name, description, argv: argv as string[], params, timeoutMs: timeout })
  })
  return { tools, errors }
}

export function inputSchema(tool: CliTool): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, p] of Object.entries(tool.params)) {
    properties[key] = { type: p.type, ...(p.description ? { description: p.description } : {}), ...(p.enum ? { enum: p.enum } : {}) }
    if (p.required) required.push(key)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }
}

// Returns the error the model should read, or the cleaned values.
export function checkArgs(tool: CliTool, input: Record<string, unknown>): { error: string } | { values: Record<string, string> } {
  const values: Record<string, string> = {}
  for (const key of Object.keys(input)) if (!(key in tool.params)) return { error: `unknown parameter "${key}"; expected ${Object.keys(tool.params).join(', ') || 'none'}` }
  for (const [key, p] of Object.entries(tool.params)) {
    const v = input[key]
    if (v === undefined || v === null) {
      if (p.required) return { error: `missing required parameter "${key}"` }
      continue
    }
    if (p.type === 'string' && typeof v !== 'string') return { error: `parameter "${key}" must be a string` }
    if (p.type === 'boolean' && typeof v !== 'boolean') return { error: `parameter "${key}" must be a boolean` }
    if ((p.type === 'number' || p.type === 'integer') && (typeof v !== 'number' || !Number.isFinite(v))) return { error: `parameter "${key}" must be a number` }
    if (p.type === 'integer' && !Number.isInteger(v)) return { error: `parameter "${key}" must be an integer` }
    const s = String(v)
    if (s.includes('\0')) return { error: `parameter "${key}" contains a NUL character` }
    if (p.enum && !p.enum.includes(s)) return { error: `parameter "${key}" must be one of: ${p.enum.join(', ')}` }
    values[key] = s
  }
  return { values }
}

// An argument that uses an optional parameter the call left out is dropped, whole.
// A string value that would become an option (leading "-" as a whole argument or at the start of one) is refused unless the param allows it.
export function buildArgv(tool: CliTool, values: Record<string, string>): { error: string } | { argv: string[] } {
  const argv: string[] = []
  for (const part of tool.argv) {
    const whole = /^\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}$/.exec(part)
    if (whole) {
      const key = whole[1] ?? ''
      const v = values[key]
      if (v === undefined) continue
      if (v.startsWith('-') && tool.params[key]?.type === 'string' && !tool.params[key]?.allowDash)
        return { error: `parameter "${key}" cannot start with "-" (it would be read as an option)` }
      argv.push(v)
    } else {
      const keys = [...part.matchAll(PLACEHOLDER)].map(m => m[1] ?? '')
      if (keys.some(k => values[k] === undefined)) continue
      const lead = /^\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/.exec(part)?.[1] ?? ''
      if (lead && values[lead]?.startsWith('-') && tool.params[lead]?.type === 'string' && !tool.params[lead]?.allowDash)
        return { error: `parameter "${lead}" cannot start with "-" (it would be read as an option)` }
      argv.push(part.replace(PLACEHOLDER, (_m, key: string) => values[key] ?? ''))
    }
  }
  return { argv }
}

export function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[cut: ${text.length - max} more characters]` : text
}

export function formatResult(r: { exitCode: number; stdout: string; stderr: string }, max: number): string {
  const parts = [`exit code: ${r.exitCode}`]
  if (r.stdout) parts.push(`stdout:\n${cap(r.stdout.replace(/\s+$/, ''), max)}`)
  if (r.stderr) parts.push(`stderr:\n${cap(r.stderr.replace(/\s+$/, ''), max)}`)
  if (!r.stdout && !r.stderr) parts.push('(no output)')
  return parts.join('\n')
}
