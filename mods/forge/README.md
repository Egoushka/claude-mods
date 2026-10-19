# forge

Claude extends itself, with your approval. It registers a tool `forge` (always in the tool list) that the model calls with `{ name, purpose, files }` to propose a new mod. Nothing is written until you press Approve.

**Mods are not sandboxed.** A mod's hooks run inside Claude Code with the same reach as the CLI: files, processes, the network, your tool calls. Approval is the only safety boundary, and the dialog is where it holds: read every file before you press Approve. Forge never installs or enables what it writes.

## What happens

1. The proposal is checked before you see it: name `a-z0-9-` (40 characters at most); paths relative, no `..`, no empty or `.` segments, no `.git`, `.env*` or `node_modules`; only `.ts`, `.tsx`, `.json` and `.md` files (so `.d.ts` too); at most 24 files, 120,000 characters each, 400,000 in all; every `.json` parses; `.claude-plugin/plugin.json` exists and carries the same name. A failed check goes back to Claude as an error and no dialog opens.
2. A dialog pane opens with the purpose, the target folder and each file in a code view, with **Approve** (`a`) and **Reject** (`r`). Escape closes it without deciding; `/forge-show` reopens it.
3. On Approve the files are written under `forgeDir` (default `~/.claude/forged-mods/<name>/`), then `claude plugin validate <dir>` runs and its verdict goes to Claude with the line that loads it: `claude --plugin-dir <dir>`, or `CLAUDE_CODE_PLUGIN_DIRS=<dir>` where no flag can be given. An existing folder is never overwritten.

## How the tool call waits

A hook has about ten seconds of its own time, and a person often needs longer. The call therefore waits `approvalWaitSeconds` (default 7, never more than the hook has left) for your press. Answer in time and the result comes back in the same call. Otherwise it returns **PENDING**, telling Claude to stop and ask you to answer the dialog. The dialog stays open; when you press Approve or Reject later, or run `/forge-approve` or `/forge-reject`, the result goes to you as a toast and to Claude as a hidden message it reads on its next turn. Set the seconds to 0 to always work this way. One proposal is open at a time.

## Repetition

Shell calls (Bash) and MCP calls the model makes are normalized (quoted strings, numbers, hashes and paths blurred) and kept per session. Calls another mod makes (a gauge polling an MCP server) and subagent calls are left out, and so are reads, edits and searches: that loop is ordinary work. At the end of a turn, a sequence of 2 to 8 different calls that has run 3 times without overlap shows a row above the prompt, shortened to its smallest repeating unit: `forge: Claude ran git status → npm run build 3 times. Bundle it into one tool?` **Draft a tool** submits a prompt asking Claude to judge whether it is worth automating and, if so, to propose it through `forge`. Each sequence is offered once.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `forgeDir` | `~/.claude/forged-mods/<name>/` | Where approved mods go; `<name>` is replaced (appended when missing), `~` is your home |
| `suggestRepeats` | true | Offer a mod when a sequence repeats |
| `approvalWaitSeconds` | 7 | How long the call holds for your answer before returning PENDING |

## Cost

No model calls of its own. The tool's schema and description sit in every request's tool list (about 400 tokens), and each proposal is the tokens Claude spends writing the files. The repetition scan is local string work.

## Limits

- Validation checks the shape of a proposal and what `claude plugin validate` accepts, not what the code does. A valid mod can still do harm.
- A write that fails halfway leaves a partial folder; Claude is told, and the folder is yours to remove.
- A mod already approved is not changed by a second proposal under its name: use a new name.
