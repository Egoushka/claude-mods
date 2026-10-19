# guardrails

Rules you'd otherwise write in CLAUDE.md and hope the model follows, enforced by the engine.

| Feature | What it does | Hooks |
|---|---|---|
| Boundary | A session whose folder matches `boundaryPaths` cannot call `fencedTools` or reach `fencedHosts` (WebFetch URLs, shell commands). Sessions outside it cannot call `insideOnlyTools`. Use it to keep employer code away from personal services, or the reverse. | `session.start`, `tool.call` |
| Secret masking | Keys, tokens, private keys, JWTs, connection-string passwords and `*_TOKEN=`-style assignments in tool output become `[masked:<kind>]` before the model reads them. Placeholders like `${TOKEN}` are left alone. | `session.append` (door `tool-result`) |
| Second opinion | Before a force push, hard reset, `git clean -f`, branch delete, `rm -rf`, SQL drop/truncate/unbounded delete, EF migration, container wipe or repo delete, a forked model call reads the conversation and answers ALLOW or DENY. DENY stops the command and tells Claude to get explicit confirmation. Each approved command is asked once per session. | `tool.call`, `$.model.fork` |
| Shell autocorrect | `cd dir && gh pr …` becomes `gh pr … -R owner/repo`; `gh … \| jq` is stopped with the `--json --jq` alternative; `timeout N` is dropped (macOS has none); `echo ===` gets quoted for zsh. Claude is told what changed. | `tool.call` |
| Loop breaker | The fourth identical failing shell command is stopped, and so is the third Edit that flips a file back to a previous version. | `tool.call` |
| Diff budget | After each edit, lines changed against `HEAD` show in the status line. Over budget, one toast asks for a smaller change. The budget is sized per task by Haiku unless you fix one. | `prompt.submit`, `tool.call` |

The status line reads like `guard: 2 masked · 1 corrected · diff +120 −30 of 150`.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `boundaryPaths` | empty (off) | Regex over the session folder that marks a fenced session, e.g. `/work(/\|$)` |
| `fencedTools` | empty | Regex over tool names blocked inside, e.g. `^mcp__(personal-notes\|home)__` |
| `fencedHosts` | empty | Regex over URLs/commands blocked inside, e.g. `my-home\.example` |
| `insideOnlyTools` | empty | Regex over tools callable only inside |
| `maskSecrets` | true | |
| `secondOpinion` | true | |
| `shellFixes` | true | |
| `loopBreaker` | true | |
| `diffBudget` | 0 | Lines; 0 sizes it per task with Haiku, -1 turns it off |

## Cost

The second opinion is one forked request per distinct irreversible command; it reuses the session's prompt cache, so you pay mostly for the cached prefix read. The diff budget is one Haiku classification per typed prompt (set `diffBudget` to a number or -1 to skip it). Everything else is local.

## Limits

Regex rules are best effort: a command built to dodge them will. This is a seatbelt against mistakes, not a sandbox.
