# runstrip

A row above the prompt that lists the chargehand runs this session started and has not seen finish, with what each has
cost so far. It is drawn only while a run is going and says nothing the rest of the time.

```
/plugin install runstrip --marketplace Egoushka/claude-mods
```

It does nothing until you name a chargehand server in `servers`.

## What you see

One line in the theme's suggestion colour, above the prompt:

```
Chargehand: 2 running: run_8f3a… 4m verify $3.10, run_c41d… 1m
```

- Each run shows a short id, how long it has been going, its stage when the server reports one, and the batch cost so
  far when the server prices the run. A run without a price shows no cost, not `$0.00`.
- The line shortens to `+N more` when the terminal is narrow.
- When a run ends, the row drops it and a toast says how it ended: `Chargehand run run_8f3a… completed, $3.10.`
  A run the server lost reads `was lost: the server stopped before it finished`.
- While a survey is up above the prompt, the row stays out of the way.

Colours come from the theme, so it reads in light and dark. The tests mount it on the terminal, desktop, VS Code and
mobile trees; the Desktop app has not been looked at on screen yet.

## How it knows

- **Which runs.** When this session calls `orchestrate` on a server you named and the answer is a `run-status/v1`
  that says `queued` or `running`, the run id is kept. An `orchestrate` that returns its result straight away adds
  nothing. Runs started by other sessions are not shown here; [switchboard](../switchboard) is for those.
- **How they are doing.** Every `everySeconds` the mod asks the same server's `result` tool for each unfinished run. It
  reads the structured answer (or JSON in the first text block): `run-status/v1` while the run goes on, `result/v1` or
  another final status once it ends. A read that fails keeps the run and tries again; a run that never answers is dropped
  after six hours.
- **No pile-up.** `result` can wait close to a minute for a run, so a run is not read again while its last read is out.

The mod reads; it never starts, stops or changes a run.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `servers` | empty (off) | names of the chargehand MCP servers as `/mcp` lists them, comma separated (`chargehand`, or `chargehand,chargehand-local`) |
| `everySeconds` | 15 | how often each unfinished run is read; at least 5 |

## What it costs

No model calls. One MCP `result` call per unfinished run per interval, on a server you named.
