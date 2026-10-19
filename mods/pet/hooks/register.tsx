import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pet } from '../types'
import { apply, bar, classify, compactFace, hungerNow, moodOf, newPet, sprite, xpForLevel } from './pet'
import type { PetEvent } from './pet'

const current = atom({ plugin: 'pet', key: 'current' } as const, null)

async function repoRoot($: EngineInterface, cwd: string): Promise<string> {
  const r = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel']).catch(() => undefined)
  const top = r?.exitCode === 0 ? r.stdout.trim() : ''
  return top || cwd
}

async function loadPet($: EngineInterface, repo: string): Promise<Pet> {
  const pets = ((await $.store.get('pets')) ?? {}) as Record<string, Pet>
  return pets[repo] ?? newPet(repo, await $.clock.now())
}

// Saves one repo's pet beside the others and shows it. Read-modify-write, so two sessions keep their own pets.
async function savePet($: EngineInterface, repo: string, pet: Pet) {
  const pets = ((await $.store.get('pets')) ?? {}) as Record<string, Pet>
  await $.store.set('pets', { ...pets, [repo]: pet })
  await update($, current, () => pet)
}

async function happen($: EngineInterface, repo: string, event: PetEvent) {
  if (!repo) return
  const before = await loadPet($, repo)
  const after = apply(before, event, await $.clock.now())
  await savePet($, repo, after)
  if (after.level > before.level) $.ui.toast(`${after.name} reached level ${after.level}`)
}

async function rename($: EngineInterface, repo: string, name: string) {
  await savePet($, repo, { ...(await loadPet($, repo)), name })
}

export const register: Register = (on, options) => {
  if (options.enabled === false) return
  const isCompact = options.compact === true
  let repo = ''

  on('session.start', async ($, e, next) => {
    repo = await repoRoot($, e.cwd)
    const pet = await loadPet($, repo)
    await savePet($, repo, pet)
    await $.command.register({ name: 'pet', description: 'Check on the repo pet, rename it or start over', argumentHint: 'name <name> | reset' })
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const event = classify(e.command, ran.isError === true, ran.text ?? '')
    if (event) await happen($, repo, event).catch(() => undefined)
    return ran
  })

  on('command.run', { command: 'pet' }, async ($, e) => {
    const args = e.args.trim()
    const named = /^name\s+(\S.{0,23})$/.exec(args)
    if (named?.[1]) {
      await rename($, repo, named[1].trim())
      return { text: `Your pet is now called ${named[1].trim()}.` }
    }
    if (args === 'reset') {
      await savePet($, repo, newPet(repo, await $.clock.now()))
      return { text: 'Your pet starts over.' }
    }
    const pet = await loadPet($, repo)
    const now = await $.clock.now()
    return { text: `${pet.name}: level ${pet.level}, ${pet.xp} xp, feeling ${moodOf(pet, now)}.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const pet = await read($, current)
    if (e.props.hasSurvey || !pet) return rest

    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const mood = moodOf(pet, now)
    const speech = now < pet.saidUntil ? pet.said : ''
    const color = mood === 'sick' ? 'error' : mood === 'hungry' ? 'warning' : 'success'
    const stroke = <Button key="pet" label="pet" hotkey="p" onPress={() => happen($, repo, 'stroke')} />

    const mine = isCompact ? (
      <Box>
        <Text color={color}>{compactFace(mood)}</Text>
        <Text>
          {' '}
          {pet.name} L{pet.level} <Text dimColor>{bar(100 - hungerNow(pet, now), 5)}</Text>
          {speech && <Text dimColor> {speech}</Text>}{' '}
        </Text>
        {stroke}
      </Box>
    ) : (
      <Box>
        <Box flexDirection="column" marginRight={2}>
          {sprite(mood, pet.level).map((row, i) => (
            <Text key={String(i)} color={color}>
              {row}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>
            {pet.name} <Text dimColor>level {pet.level} · {pet.xp}/{xpForLevel(pet.level + 1)} xp</Text>
          </Text>
          <Text>
            <Text dimColor>fed </Text>
            {bar(100 - hungerNow(pet, now), 10)} <Text color={color}>{mood}</Text>
          </Text>
          <Text dimColor>{speech || ' '}</Text>
          {stroke}
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {mine}
        {rest}
      </Box>
    )
  })
}
