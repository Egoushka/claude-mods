import type { Phase } from '../types'

export const BUMP = 15

export const DRAFT_PROMPT = `Write the handoff for this session, so a fresh session can carry on without this conversation.

Reply with the Markdown document only, no preface. You cannot run commands now: use only what this session saw, and put anything you did not see confirmed under State, marked "unverified". Never invent a commit, a PR number or a test result.

Use these sections, in this order:

# Handoff: <the work, in plain words>
## Severity
One of stable, watch, unstable, then one line on what breaks or is lost if the next session gets this wrong.
## Summary
**Goal:** what done looks like, in one or two sentences.
**State:** what works, what is half-built, what is uncommitted or unpushed, what is running.
**Done:** one bullet per result, each with its evidence (a commit, a command and its output).
## Actions
Numbered, concrete first steps: the file, the command or the question.
### Waiting on the user
Open questions, with the options and your recommendation.
## Contingencies
"If <check> shows <X>: <do Y>", and what was tried and failed.
## Verify
Read-only commands and the output expected.`

export const shouldOffer = (percent: number | undefined, nextAt: number): boolean =>
  percent !== undefined && nextAt > 0 && percent >= nextAt

export const startPrompt = (file: string): string =>
  `Continue: read ${file}, check it against git, and carry on.`

export const rowText = (p: Phase): string => {
  switch (p.step) {
    case 'offer':
      return `This session has used ${Math.round(p.percent ?? 0)}% of its context. Draft a handoff before it grows?`
    case 'working':
      return 'Drafting the handoff…'
    case 'ready':
      return `Handoff saved to ${p.file ?? 'the draft file'}.`
    case 'failed':
      return `Handoff draft failed: ${p.note ?? 'unknown reason'}`
    default:
      return ''
  }
}

export const failureNote = (reason: string, status?: number): string => {
  if (reason === 'nothing-to-fork') return 'nothing to hand off yet'
  if (reason === 'empty-reply') return 'the model sent no text'
  if (reason === 'aborted') return 'the turn was interrupted'
  return status ? `the API answered ${status}` : 'the API refused the request'
}
