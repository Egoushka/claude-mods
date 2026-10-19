# recall

Gives Claude the context you would otherwise retype. Five parts, each on its own switch.

```
/plugin install recall --marketplace <owner>/<repo>
```

## What it does

**Memory ghost.** On every prompt you type, it calls a memory MCP tool with your prompt and adds the answer to what the model reads (never shown in the transcript). The band above the prompt shows "N memories" with a **Show** button that opens a pane listing them. Off while `memoryServer` is empty. The call is cut off after 3 seconds, so a slow server never stalls a prompt; a failing or empty answer adds nothing. The result is read as a JSON list (also `{results|memories|items: [...]}`) or, failing that, as paragraphs and bullets, and capped at `maxChars`.

**Smart @-mentions.** For `@file`, adds under the file: its last 5 commits (`git log`), likely test files (git-tracked files whose name holds the file's name and looks like a test: `*.test.*`, `*_spec.*`, `test_*`, `*Tests.*`, `tests/` folders) and up to 8 files that mention its name (`git grep -l -w`). Outside a git repo it adds nothing. Name matching is a heuristic: a file named `cache` also matches `cache_test`, and a common word as a file name makes the "mentioned by" list noisy.

**Correction harvester.** After each prompt, a Haiku call asks whether you are correcting what the assistant just did. A correction is boiled down to one imperative line and stored per project. When a later correction matches an earlier one (word overlap, else a second Haiku call over the last 15), the band shows `Rule candidate: <summary>` with **Draft rule** (asks Claude to propose the rule as an edit to `instructionsFile` and wait for your confirmation) and **Dismiss**. Corrections are never written to your instructions file by the plugin itself.

**Friction log.** Records, with time and a short evidence line: tool calls denied (by any plugin in the chain, or by a permission denial), a call that errors a 2nd and a 5th time in a row, corrections, and interrupted turns. `/friction` opens the log in a pane. The log is kept per project in the plugin store (last 200); set `frictionFile` to also append markdown lines to a file.

**Selection verbs.** Select text with the mouse, then run `/verify` or `/why` (each puts a quoted request in the prompt box for you to edit and send; text after the command is appended) or `/remember` (saves the selection). With nothing selected they say so and do nothing; `/remember some text` saves the text you typed.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `memoryServer` | empty (off) | MCP server name as `/mcp` lists it |
| `recallTool`, `recallArgs` | `recall`, `{"query": "{{query}}"}` | tool and a JSON template; `{{query}}` is replaced in every string |
| `maxChars` | 2000 | memory text added per prompt |
| `smartMentions` | on | the @-mention context |
| `harvestCorrections` | on | the correction harvester |
| `instructionsFile` | `CLAUDE.md` | target of a drafted rule |
| `frictionFile` | empty | markdown file to append friction lines to |
| `retainServer`, `retainTool`, `retainArgs` | empty, `retain`, `{"content": "{{text}}"}` | where `/remember` saves; empty server keeps notes in the plugin store |

## Cost

- Memory ghost: one MCP call per typed prompt, plus up to `maxChars` of extra input tokens on that turn.
- Smart @-mentions: four short `git` commands per mention, plus a few hundred input tokens.
- Correction harvester: one Haiku classification per prompt of 13+ characters once the assistant has spoken (about 300 input tokens). A correction adds one Haiku summary and sometimes one more Haiku comparison. Turn it off with `harvestCorrections` to spend nothing.
- Friction log and selection verbs: no model calls.

## Limits

- Slash commands, queued and plugin-sent prompts are not recalled for or classified; only prompts typed in the prompt box (or sent from a phone) are.
- `/verify`, `/why` and `/remember` read the mouse selection, which the engine reports only in the fullscreen terminal and in the desktop app. Elsewhere they say nothing is selected.
- Permission denials reach the log through a `classic.PermissionDenied` hook, which an organization-managed Claude Code skips for plugins you install yourself. Denials by hooks (`tool.call` `deny`) are logged either way.
- The plugin store has no per-project partition, so state is keyed by the session's start folder.
