# Handoff: guardrails fence leak (#21)

Status: fixed in #22 (guardrails 0.1.3). The live probe is `scripts/probe-fence.sh`.

## What was found

Read from the Mac's Claude Desktop session logs (`~/.claude/projects`, `~/Library/Logs/Claude`) and by reproducing launches.

- The fence loads and denies in Desktop builds. A Desktop-style launch (Desktop's bundled Claude Code 2.1.325, stream-json over
  stdio, `--await-initialize`, `--setting-sources user,project,local`, bypassPermissions, the MCP server served by the host,
  resume of an existing session) is denied when the session starts in the fenced folder. The fenced regexes match the leaked
  tool names.
- Cause that reproduces: the boundary was decided once, at `session.start`, from the start folder. A session that starts outside
  (for example the parent folder) and later works inside was never fenced. Two of the leaking Desktop sessions began in the
  parent folder and moved into the fenced one; before the fix the probe ran the fenced tool in both the CLI and Desktop builds in
  that case.
- Not explained: one Desktop session that started inside the fenced folder (2026-11-19, 25 calls) shows no trace of guardrails.
  The engine gives a mod no live folder (`$.session.root()` is the start folder; the Bash cwd resets after each call), so a
  folder change after start is only visible through the paths tools name.

## What changed

- Boundary judged on every `tool.call`: the start folder, the live session root, and any built-in tool input naming a path under
  `boundaryPaths` (sticky until the next `session.start`). With no known folder a configured fence fails closed.
- Tests: `claude plugin test mods/guardrails` (15).
- Probe: `scripts/probe-fence.sh` runs four real sessions (CLI and the Desktop build, each started inside, and started outside
  then naming a fenced path) with a stand-in MCP server named like a fenced one; it passes only if the call was denied and the
  server never ran.

## Open

- The unexplained 2026-11-19 session. If a leak shows up again, run the probe first, then compare that session's plugin init.
- A session that starts outside and only reaches the fenced folder by relative path (`cd work`) is not caught.
- The fence stops calls; it does not remove the personal tools from the model's list.
