import type { Hours } from '../types'

const pad = (n: number) => String(n).padStart(2, '0')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Local calendar day, as the sortable key the store uses.
export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Monday of the week that holds `ms`.
export function weekStartKey(ms: number): string {
  const d = new Date(ms)
  const back = (d.getDay() + 6) % 7
  return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime())
}

export const monthStartKey = (ms: number) => dayKey(ms).slice(0, 8) + '01'
export const monthName = (ms: number) => MONTHS[new Date(ms).getMonth()] ?? ''

// Adds active time to one repo and day, and drops days older than a year.
export function accrue(hours: Hours, repo: string, day: string, ms: number): Hours {
  if (ms <= 0) return hours
  const days = { ...hours[repo], [day]: (hours[repo]?.[day] ?? 0) + ms }
  const next: Hours = { ...hours, [repo]: days }
  const cutoff = Number(day.slice(0, 4)) - 1 + day.slice(4)
  for (const key of Object.keys(days)) if (key < cutoff) delete days[key]
  return next
}

export type Row = { repo: string; today: number; week: number; month: number }

export function summarize(hours: Hours, now: number): { rows: Row[]; total: Row } {
  const today = dayKey(now)
  const week = weekStartKey(now)
  const month = monthStartKey(now)
  const rows: Row[] = Object.entries(hours).map(([repo, days]) => {
    const row: Row = { repo, today: 0, week: 0, month: 0 }
    for (const [day, ms] of Object.entries(days)) {
      if (day === today) row.today += ms
      if (day >= week && day <= today) row.week += ms
      if (day >= month && day <= today) row.month += ms
    }
    return row
  })
  const total: Row = { repo: 'all', today: 0, week: 0, month: 0 }
  for (const r of rows) {
    total.today += r.today
    total.week += r.week
    total.month += r.month
  }
  return { rows: rows.filter(r => r.month > 0 || r.week > 0 || r.today > 0).sort((a, b) => b.month - a.month), total }
}

export function fmtDuration(ms: number): string {
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`
}

export const hoursOf = (ms: number) => ms / 3600000

function money(value: number): string {
  if (value >= 1000) return `${(Math.round(value / 100) / 10).toString()}k`
  return String(Math.round(value))
}

// "Oct: 42h ≈ 31.5k UAH of 60k"; undefined while the goal is off.
export function goalLine(monthMs: number, now: number, rate: number, goal: number, currency: string): string | undefined {
  if (!(rate > 0) || !(goal > 0)) return undefined
  const h = hoursOf(monthMs)
  return `${monthName(now)}: ${Math.round(h)}h ≈ ${money(h * rate)} ${currency} of ${money(goal)}`
}

export function toCsv(hours: Hours): string {
  const lines = ['repo,day,hours']
  for (const [repo, days] of Object.entries(hours).sort(([a], [b]) => a.localeCompare(b)))
    for (const [day, ms] of Object.entries(days).sort(([a], [b]) => a.localeCompare(b)))
      lines.push(`${csvCell(repo)},${day},${hoursOf(ms).toFixed(2)}`)
  return lines.join('\n') + '\n'
}

const csvCell = (text: string) => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text)

export const baseName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path

// A `gh pr merge` command and the pull request it names (a number, url or branch), if any.
export function mergeTarget(command: string): { selector?: string; repo?: string; isAuto: boolean } | undefined {
  const m = /(?:^|[;&|]\s*|&&\s*)gh\s+pr\s+merge\b([^;&|\n]*)/.exec(command)
  if (!m) return undefined
  const args = (m[1] ?? '').trim().split(/\s+/).filter(Boolean)
  const withValue = new Set(['-R', '--repo', '-b', '--body', '-F', '--body-file', '-t', '--subject', '--match-head-commit', '-A', '--author-email'])
  let selector: string | undefined
  let repo: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    if (arg === '-R' || arg === '--repo') repo = args[i + 1]
    else if (arg.startsWith('--repo=')) repo = arg.slice('--repo='.length)
    if (withValue.has(arg)) i += 1
    else if (!arg.startsWith('-') && selector === undefined) selector = arg
  }
  return { selector, repo, isAuto: args.includes('--auto') }
}

export function repoFromRemote(remote: string): string | undefined {
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\s*$/.exec(remote.trim())
  return m?.[1]
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'post'
}

export function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')
}

export function postPrompt(pr: { title: string; body: string; url: string }, repo: string): string {
  return [
    `Write a short post for a developer's build-in-public feed about a pull request that just merged in ${repo}.`,
    'Say what shipped and why it matters to someone using the project. Plain words, first person, 60 to 110 words.',
    'No hype, no emoji, no hashtags, no marketing phrases. Do not invent facts that are not in the pull request.',
    'Reply with the post text only.',
    '',
    `Title: ${pr.title}`,
    `URL: ${pr.url}`,
    `Description:\n${pr.body.slice(0, 4000)}`,
  ].join('\n')
}
