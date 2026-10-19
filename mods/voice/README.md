# voice

Keeps Claude's replies plain and backed by evidence. Two parts, each with its own switch.

## Slop filter

Hooks `session.append` on the model's response rows and rewrites their text blocks before they are stored. The model and the transcript file read the clean text; thinking and tool-use blocks are never touched.

| Removed | Examples |
|---|---|
| Praise openers (only at a sentence, line or list-item start) | "Great question!", "You're absolutely right, ...", "That's a great point." |
| Closers (last line only, never one that mentions code or a link) | "I hope this helps!", "Let me know if you have questions." |
| Filler adverbs | honestly, genuinely, truthfully |
| Throat-clearing | "it's worth noting that", "needless to say" |
| Swapped, because deleting breaks the sentence | straightforward -> simple, delve -> dig |

Fenced code (also an unclosed one), inline code, URLs, "quoted" text and `>` blockquote lines are never touched. Words inside longer words are left alone ("dishonestly"). What the removal leaves behind is repaired: stray commas and spaces, and the next word is capitalised at a sentence start. A reply that would end up empty is kept as it was. Known limit: the capitalised word may be a lowercase identifier written without backticks ("Honestly, npm is fine" becomes "Npm is fine").

**Transcript versus screen.** The engine's documentation says the screen may paint a reply just before its row is rewritten. The mod therefore also rewrites the `AssistantMessage` drawing with the same function, so what is drawn matches what is stored (the stored row is the source of truth; the drawing is best effort). It cannot change anything an SDK stream or Remote Control already received.

Status line: `voice: 5 edits`. In `flag` mode it reads `voice: 5 flagged` and nothing is rewritten.

## Evidence auditor

On `turn.complete` of an answer, the mod asks a small model to list factual claims about code or systems that cite no file:line, command output or URL. The call runs after the turn, so it never delays an answer, and its result is dropped if a newer turn started.

Skipped: refused, aborted or errored turns, subagent runs, answers shorter than the minimum length, and answers with fewer than three code or system signals (backticks, file names, words like `config`, `service`, `commit`), so chat replies cost nothing.

The result shows as a row above the prompt: `3 unbacked claims` with two buttons, plus the first three claims when there is room.

- **Back them up** submits a prompt (as your own words) that lists the claims and asks Claude to cite file:line, command output or a URL for each, or mark it UNKNOWN, and correct any that turn out wrong.
- **Dismiss** hides the row. The next turn also clears it.

The row is added to the shared band with `await next(e)`, so other mods' rows stay. It yields to surveys. The terminal and desktop surfaces draw it; other surfaces have no band.

The auditor is a model judging text it cannot check against the code, so treat the list as leads: it finds missing citations, not false statements.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `slopFilter` | on | Turn the filter off entirely. |
| `mode` | `rewrite` | `rewrite` edits the stored text; `flag` only counts. |
| `extraPhrases` | empty | Comma-separated phrases to delete (whole words, any spacing), or `/regex/flags` entries. Example: `leverage, /\bseamless(ly)?\b/i`. Invalid entries and ones that match the empty string are skipped. |
| `audit` | on | Turn the auditor off. |
| `auditModel` | `haiku` | Alias or id for the audit call. |
| `auditMinLength` | 600 | Characters an answer needs before it is audited. |

## Cost

- Slop filter: no model calls, a few regex passes per reply.
- Auditor: one `$.model.complete` call per qualifying answer. Input is the answer (cut at 12,000 characters) plus about 250 tokens of instructions; output is capped at 700 tokens, usually under 150. On Haiku that is a fraction of a cent. "Back them up" costs one normal turn.
- Neither part adds anything to the main conversation's context, except the "Back them up" prompt when you press it.
