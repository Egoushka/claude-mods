import type { Pet } from '../types'

export type Mood = 'happy' | 'content' | 'hungry' | 'sick'
export type PetEvent = 'test-pass' | 'test-fail' | 'commit' | 'merge' | 'force-push' | 'ci-green' | 'ci-red' | 'stroke'

const MINUTE = 60000
const NAMES = ['Pip', 'Moss', 'Bit', 'Nib', 'Tux', 'Zed', 'Orb', 'Fig', 'Ash', 'Kit', 'Dot', 'Rue']

export const levelFor = (xp: number) => 1 + Math.floor(Math.sqrt(Math.max(0, xp) / 10))
export const xpForLevel = (level: number) => 10 * (level - 1) ** 2

// A stable default name per repo, so a fresh clone does not rename the creature.
export function nameFor(repo: string): string {
  let h = 0
  for (const ch of repo) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return NAMES[h % NAMES.length] ?? 'Pip'
}

export const newPet = (repo: string, now: number): Pet => ({
  name: nameFor(repo),
  xp: 0,
  level: 1,
  hunger: 40,
  fedAt: now,
  sickUntil: 0,
  happyUntil: 0,
  strokedAt: 0,
  said: '',
  saidUntil: 0,
})

// One point of hunger per six minutes, so a pet left alone for an afternoon is hungry, not starving.
export const hungerNow = (p: Pet, now: number) => Math.min(100, p.hunger + Math.floor(Math.max(0, now - p.fedAt) / (6 * MINUTE)))

export function moodOf(p: Pet, now: number): Mood {
  if (now < p.sickUntil) return 'sick'
  const hunger = hungerNow(p, now)
  if (now < p.happyUntil || hunger < 25) return 'happy'
  return hunger < 60 ? 'content' : 'hungry'
}

type Effect = { xp: number; feed: number; sick: number; happy: number; says: string }
const EFFECTS: Record<PetEvent, Effect> = {
  'test-pass': { xp: 5, feed: 25, sick: -1, happy: 10, says: 'green tests, yum' },
  'test-fail': { xp: 0, feed: 0, sick: 20, happy: 0, says: 'red tests, ugh' },
  commit: { xp: 3, feed: 10, sick: 0, happy: 3, says: 'a commit, nom' },
  merge: { xp: 15, feed: 40, sick: 0, happy: 30, says: 'a merge, feast!' },
  'force-push': { xp: 0, feed: 0, sick: 60, happy: 0, says: 'that force push hurt' },
  'ci-green': { xp: 4, feed: 10, sick: 0, happy: 5, says: 'CI is green' },
  'ci-red': { xp: 0, feed: 0, sick: 30, happy: 0, says: 'CI is red, I feel sick' },
  stroke: { xp: 1, feed: 0, sick: 0, happy: 5, says: 'purr' },
}

// `sick: -1` heals; a positive number sickens for that many minutes.
export function apply(p: Pet, event: PetEvent, now: number): Pet {
  const fx = EFFECTS[event]
  if (event === 'stroke' && now - p.strokedAt < MINUTE) return { ...p, said: 'enough for now', saidUntil: now + 8000 }
  const xp = p.xp + fx.xp
  return {
    ...p,
    xp,
    level: levelFor(xp),
    hunger: Math.max(0, hungerNow(p, now) - fx.feed),
    fedAt: now,
    sickUntil: fx.sick < 0 ? 0 : fx.sick > 0 ? now + fx.sick * MINUTE : p.sickUntil,
    happyUntil: fx.happy > 0 ? Math.max(p.happyUntil, now + fx.happy * MINUTE) : p.happyUntil,
    strokedAt: event === 'stroke' ? now : p.strokedAt,
    said: fx.says,
    saidUntil: now + 20000,
  }
}

const unquote = (command: string) => command.replace(/'[^']*'|"[^"]*"/g, '""')
const TEST_RUNNER =
  /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?t(?:est)?|npx\s+(?:vitest|jest|mocha|playwright\s+test)|vitest|jest|pytest|py\.test|rspec|phpunit|go\s+test|cargo\s+(?:test|nextest)|dotnet\s+test|make\s+(?:test|check)|(?:mvn|mvnw|gradle|gradlew)\b[^;&|]*\btest|claude\s+plugin\s+test|tox|ctest)(?=$|[\s;&|)])/
const FORCE_PUSH = /\bgit\s+(?:-C\s+\S+\s+)?push\b[^;&|]*(?:\s--force(?!-)|\s-f\b|\s--force-with-lease|\s\+\S)/
const COMMIT = /\bgit\s+(?:-C\s+\S+\s+)?commit\b(?![^;&|]*--dry-run)/
const MERGE = /\bgh\s+pr\s+merge\b/
const CI = /\bgh\s+(?:pr\s+checks|run\s+(?:watch|view))\b/
const CI_RED = /\b[1-9]\d*\s+failing\b|\tfail\b|\bfailure\b|\bfailed\b|\bX\s/i
const CI_GREEN = /\bpass(?:ed|ing)?\b|\bsuccess\b|\ball checks\b/i

// What a finished Bash call means for the pet, if anything.
export function classify(command: string, isError: boolean, output: string): PetEvent | undefined {
  const c = unquote(command)
  if (FORCE_PUSH.test(c)) return isError ? undefined : 'force-push'
  if (MERGE.test(c)) return isError ? undefined : 'merge'
  if (CI.test(c)) {
    if (CI_RED.test(output)) return 'ci-red'
    return !isError && CI_GREEN.test(output) ? 'ci-green' : undefined
  }
  if (COMMIT.test(c)) return isError ? undefined : 'commit'
  if (TEST_RUNNER.test(c)) return isError ? 'test-fail' : 'test-pass'
  return undefined
}

const FACE: Record<Mood, string> = { happy: '^.^', content: 'o.o', hungry: 'o.O', sick: 'x.x' }

export function sprite(mood: Mood, level: number): string[] {
  const ears = level >= 5 ? ' /\\^/\\' : ' /\\_/\\'
  const legs = mood === 'sick' ? ' > ~ <' : mood === 'hungry' ? ' > o <' : ' > ^ <'
  return [ears, `( ${FACE[mood]} )`, legs]
}

export const compactFace = (mood: Mood) => `(=${FACE[mood]}=)`

export function bar(value: number, width: number): string {
  const full = Math.round((Math.max(0, Math.min(100, value)) / 100) * width)
  return '█'.repeat(full) + '░'.repeat(width - full)
}
