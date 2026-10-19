import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { VoiceAudit, VoiceStats } from '../types'
import { bandLabel, buildAuditPrompt, buildBackupPrompt, parseClaims, shouldAudit } from './audit'
import { filterSlop, parseExtra } from './slop'

const initialStats: VoiceStats = { edits: 0, audited: 0, isAuditing: false }
const stats = atom({ plugin: 'voice', key: 'stats' } as const, initialStats)
const audit = atom({ plugin: 'voice', key: 'audit' } as const, { claims: [] } as VoiceAudit)

async function refreshStatus($: EngineInterface, verb: string) {
  const s = await read($, stats)
  const parts: string[] = []
  if (s.edits) parts.push(`${s.edits} ${verb}`)
  if (s.isAuditing) parts.push('auditing…')
  $.ui.status(parts.length ? `voice: ${parts.join(' · ')}` : undefined)
}

async function countEdits($: EngineInterface, edits: number, verb: string) {
  await update($, stats, s => ({ ...s, edits: s.edits + edits }))
  await refreshStatus($, verb)
}

// One small-model call per qualifying answer; a newer turn makes an older result stale.
async function runAudit($: EngineInterface, answer: string, model: string, id: number, current: () => number, verb: string) {
  await update($, stats, s => ({ ...s, isAuditing: true }))
  await refreshStatus($, verb)
  const reply = await $.model
    .complete({ model, prompt: buildAuditPrompt(answer), maxTokens: 700, effort: 'low', timeoutMs: 30000 })
    .catch(() => undefined)
  if (current() !== id) return
  const claims = reply?.isAnswered ? parseClaims(reply.text) : []
  await update($, audit, () => ({ claims }))
  await update($, stats, s => ({ ...s, isAuditing: false, audited: s.audited + 1 }))
  await refreshStatus($, verb)
}

async function backThemUp($: EngineInterface, claims: readonly string[]) {
  await update($, audit, () => ({ claims: [] }))
  await $.prompt.submit({ text: buildBackupPrompt(claims), asUser: true })
}

async function dismiss($: EngineInterface) {
  await update($, audit, () => ({ claims: [] }))
}

export const register: Register = (on, options) => {
  const isFilterOn = options.slopFilter !== false
  const isRewrite = options.mode !== 'flag'
  const verb = isRewrite ? 'edits' : 'flagged'
  const extra = parseExtra(typeof options.extraPhrases === 'string' ? options.extraPhrases : '')
  const isAuditOn = options.audit !== false
  const model = typeof options.auditModel === 'string' && options.auditModel.trim() ? options.auditModel.trim() : 'haiku'
  const minLength = typeof options.auditMinLength === 'number' ? options.auditMinLength : 600

  let generation = 0

  on('session.start', async ($, e, next) => {
    await update($, stats, () => initialStats)
    await update($, audit, () => ({ claims: [] }))
    await refreshStatus($, verb)
    return next(e)
  })

  // The stored row is rewritten, so the model and the transcript file read the clean text.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    if (!isFilterOn) return next(e)
    let edits = 0
    const content = e.message.content.map(block => {
      if (block.type !== 'text' || typeof block.text !== 'string') return block
      const r = filterSlop(block.text, extra)
      edits += r.edits
      return isRewrite && r.edits > 0 ? { ...block, text: r.text } : block
    })
    if (edits === 0) return next(e)
    await countEdits($, edits, verb)
    return next(isRewrite ? { ...e, message: { ...e.message, content } } : e)
  }).catch(($, e, next) => next(e))

  // The screen may paint a reply before its row is stored; draw the same text it will keep.
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (!isFilterOn || !isRewrite) return next(e)
    const r = filterSlop(e.props.text, extra)
    return next(r.edits > 0 ? { ...e, props: { ...e.props, text: r.text } } : e)
  })

  on('turn.start', async ($, e, next) => {
    generation += 1
    await update($, audit, () => ({ claims: [] }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (isAuditOn && e.reason === 'answer' && !e.agentId && shouldAudit(e.answer, minLength)) {
      generation += 1
      const id = generation
      void runAudit($, e.answer, model, id, () => generation, verb)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (e.props.hasSurvey) return rest
    const { claims } = await read($, audit)
    if (claims.length === 0) return rest

    const { Box, Text, Button } = $.ui.resolve(e)
    const shown = e.props.maxRows >= 6 ? claims.slice(0, 3) : []
    return (
      <Box flexDirection="column">
        <Box key="voice" flexDirection="column">
          <Box>
            <Text color="yellow">{bandLabel(claims.length)} </Text>
            <Button key="back" label="Back them up" onPress={() => backThemUp($, claims)} />
            <Text> </Text>
            <Button key="dismiss" label="Dismiss" onPress={() => dismiss($)} />
          </Box>
          {shown.map((c, i) => (
            <Text key={`c${i}`} dimColor wrap="truncate-end">
              {`  ${i + 1}. ${c}`}
            </Text>
          ))}
        </Box>
        {rest}
      </Box>
    )
  })
}
