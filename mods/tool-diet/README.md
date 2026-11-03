# tool-diet

Every tool the model can call puts its description and input schema into the prompt, and every turn re-reads them.
Some tools you never use still cost thousands of tokens a turn. Tool-diet moves the tools you name behind ToolSearch,
so the model sees only their names and loads a schema when it actually wants the tool. Nothing is removed: a moved tool
still works, with one extra lookup the first time.

```
/plugin install tool-diet --marketplace Egoushka/claude-mods
```

## What you see

Nothing. There is no row, pane or toast; the mod acts only on what the model reads. `/context` shows the effect: the
tools section gets smaller.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `tools` | empty (the mod does nothing) | comma-separated tool names to move behind ToolSearch. A trailing `*` matches a prefix |

```
Workflow, Artifact, ScheduleWakeup, mcp__homelab__umami_*
```

`ToolSearch` itself is never moved. Pick the names from your own usage (a 30-day tool count), not from a guess: the
saving is the size of what you leave out, and a tool the model reaches for every day costs a lookup each session.

## What it saves, and what is not verified

- Claude Code already places every MCP server's tools behind ToolSearch by its own rule, so listing `mcp__…` tools
  mostly saves nothing. The lever is the built-in tools that ride along in full: in one measured session `Workflow` and
  `Artifact` were about 20,000 characters of description each.
- That puts the saving at roughly 10,000 tokens a session if you move those two and `ScheduleWakeup`. This is an
  estimate from description length, **not a measured result**: a headless run cannot read the prompt's token count, and
  the desktop-only tools could not be loaded there.
- To measure it: in a fresh session run `/context`, note the tools figure, set `tools`, run `/reload-plugins` or start
  a new session, run `/context` again. If the difference is under about 5,000 tokens, uninstall the mod.

## Cost

No model calls. The hook runs once per tool when its schema is first rendered. Changing the list rewrites the prompt
cache once, on the next turn.
