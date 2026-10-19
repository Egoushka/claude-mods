# cockpit

A live pane for what surrounds the session. `/cockpit` opens it.

| Section | What it shows | Source |
|---|---|---|
| cost, context | session cost, context fill | `session.measure` and `$.session.usage()`, pushed by the engine |
| git | branch and number of changed paths | `git status --porcelain -b`, every `refreshSeconds` and after each turn |
| pr checks | pass, fail and pending counts for the current branch's PR | `gh pr checks --json name,state`; the row is absent without `gh`, a PR or checks |
| your gauges | whatever you configure | MCP tool, command or HTTP URL |
| Inbox | messages other sessions or agents sent you | `session.receive` |

Every row has a `↻` button; `↻ refresh all` and `/cockpit` refresh everything. Numeric readings keep the last 40 values and draw a sparkline: a `Raster` on the terminal, block characters (`▁▃█`) on other surfaces.

## Custom gauges

`gauges` is a JSON array:

```json
[
  { "label": "Queue", "kind": "mcp", "server": "ops", "tool": "queue_depth", "args": { "queue": "main" }, "every": 30, "pick": "data.depth" },
  { "label": "Load", "kind": "command", "argv": ["uptime"], "every": 15, "pick": "/load averages?: ([\\d.]+)/" },
  { "label": "Health", "kind": "http", "url": "https://example.com/health.json", "every": 60, "pick": "status" }
]
```

- `every` is seconds (default 60, minimum 5). Each gauge has its own timer.
- `pick` is a dotted path into JSON (`data.items.0.count`) or a `/regex/` (first capture group, else the match). Without `pick`, the first non-empty line is shown.
- A reading that is a plain number (`42`, `12.5%`, `1,200`) is numeric and gets history. Anything else is shown as text.
- A failing gauge keeps its last value and shows the error dimmed next to it. Bad entries in the JSON are skipped and listed in red at the pane's foot.

## Inbox

Messages from peers and other sessions (`peer`, `peer-send-message`, `projects-relay`, `slack-ping` deliveries) are listed in the pane (the last 30) and raise a toast. With `quietInbox` on they are consumed: they do not reach the transcript or the model, so you must look at the pane. Your own prompts (including Remote Control), harness wakes and messages inside a subagent are never touched.

## Away mode

When a turn ends with an answer and you have been idle longer than `awayMinutes`, a summary is sent.

- **Presence.** On macOS the idle time is read from `ioreg -c IOHIDSystem` (`HIDIdleTime`). Elsewhere the idle time is unknown, and an unknown idle time counts as present, so nothing is sent. Set `presenceServer` and `presenceTool` to read the idle seconds from an MCP tool instead (it must answer a number, bare or in JSON).
- **Summary.** `answer` (default) is the first 300 characters of the final answer. `haiku` makes one small model call per away turn for a one-sentence summary and falls back to `answer` if it fails.
- **Channel.** `$.ui.notify` by default. Set `awayServer`, `awayTool` and optionally `awayArgs` to send through an MCP tool, for instance a chat bot. `awayArgs` is a JSON object; every string containing `{{text}}` gets the summary (the value is inserted after parsing, so quotes in the summary cannot break the JSON). Empty means `{"text": "{{text}}"}`. If the MCP call fails, a notification is used.

## Settings

| Setting | Default | |
|---|---|---|
| `gauges` | `[]` | custom gauges, JSON |
| `refreshSeconds` | 30 | git and PR refresh period |
| `quietInbox` | off | consume inbox messages |
| `awayMode` | on | summary when you are away |
| `awayMinutes` | 5 | idle time that counts as away |
| `awaySummary` | `answer` | `answer` or `haiku` |
| `presenceServer`, `presenceTool`, `presenceArgs` | empty | presence from an MCP tool |
| `awayServer`, `awayTool`, `awayArgs` | empty | away message through an MCP tool |

## What it costs

No model calls unless `awaySummary` is `haiku` (one Haiku call per turn that ends while you are away). Timers run `git status` and `gh pr checks` every `refreshSeconds`, plus your gauges at their own rates; `command` gauges run whatever argv you configured, so only put your own commands there.

## Limits

- The pane is read-only apart from the buttons; the sparkline scales to the last 40 readings, not to a fixed range.
- Gauge history lives in session state, so it starts over with each session.
- `ioreg` presence is macOS only.
- Inbox sorting relies on the delivery's `origin`; deliveries the engine cannot classify (`unclassified`) are left alone.
