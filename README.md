# claude-mods

Ten mods for Claude Code. A mod is a plugin whose hooks run inside the CLI as TypeScript: it can stop or rewrite tool calls, edit what the model reads, draw panes and a band above the prompt, call MCP servers and run its own model requests.

Needs Claude Code 2.1.287 or newer. Each mod installs on its own.

## Install

At the prompt of a terminal session:

```
/plugin install guardrails --marketplace Egoushka/claude-mods
```

From a shell:

```bash
claude plugin install guardrails --marketplace Egoushka/claude-mods
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `Egoushka/claude-mods`, then Add plugin.

Swap `guardrails` for any name below. Settings show up in the config menu; every personal value (hosts, MCP servers, paths) defaults to off.

## The mods

| Mod | What it does | Model calls |
|---|---|---|
| [guardrails](mods/guardrails) | Work/personal boundary, secret masking in tool output, a second opinion before irreversible commands, shell autocorrect, loop breaker, diff budget | fork per irreversible command; Haiku per prompt for the budget |
| [thrift](mods/thrift) | Model router, context coach, context forecast, `/diet` to drop system-prompt sections | Haiku per prompt (router) |
| [voice](mods/voice) | Strips filler and AI tells from replies; flags claims with no file:line, output or URL | Haiku per long answer (auditor) |
| [recall](mods/recall) | Memory recall per prompt from your MCP server, smarter @-mentions, rules from repeated corrections, friction log, `/verify` `/remember` `/why` on a selection | Haiku per prompt (harvester) |
| [cockpit](mods/cockpit) | `/cockpit` pane: cost, context, git, PR checks, your own gauges; inbox for messages from other sessions; away-mode summaries | optional Haiku summary |
| [cli-tools](mods/cli-tools) | Shell commands from your config become typed tools the model sees from turn one | none |
| [rival](mods/rival) | After a turn that changed files, a read-only subagent reviews the diff for bugs; findings in the band | one subagent review per changed turn |
| [forge](mods/forge) | Claude proposes a new mod through a `forge` tool; nothing is written until you approve it | none |
| [ledger](mods/ledger) | Active hours per repo, `/hours`, CSV export, monthly goal; drafts a build-in-public post when a PR merges (never posts) | one draft per merge, opt-in |
| [replay](mods/replay) | `/replay`: scrub a session's file changes turn by turn | none |

## Safety

Mods are not sandboxed: they run with your Claude Code session's access. Read a mod before installing it; `claude plugin validate <folder>` lists every hook it registers and every call it makes. guardrails is a seatbelt against mistakes, not a security boundary.

## Developing

See [CONTRIBUTING.md](CONTRIBUTING.md). `scripts/check.sh` type-checks, validates and tests every mod.

## License

MIT
