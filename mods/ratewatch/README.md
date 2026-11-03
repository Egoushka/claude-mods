# ratewatch

One toast when a usage window passes 80%, so the wall does not surprise you in the middle of a task. With several
sessions open it also says which of them spent the most.

```
/plugin install ratewatch --marketplace Egoushka/claude-mods
```

## What you see

A toast, once per window, for 20 seconds:

```
Usage: 5-hour limit 82% used, resets in 1h 20m. Spent so far: infra $12.50, app $3.00 (this one).
```

- The windows are the ones your plan reports: the 5-hour limit, the weekly limit, and a gateway's spend limit. If two
  pass the line together, they share one toast.
- It fires the first time a window is over the line, not on every response after that. When a window resets it starts
  fresh and can warn again.
- "Spent so far" lists up to three live sessions, the biggest first, with what each has cost since it started. It is
  each session's total, not its share of the window (the engine does not report a share), so read it as a hint where
  to look.
- Off a subscription there are no windows, so nothing ever appears.

Nothing else is drawn: no band, no pane, no status entry.

## How it knows

The engine reports the windows after every response (`session.measure`). Each session also writes one small JSON file,
`<session id>.json`, into a shared folder (`~/.claude/ratewatch` unless you set `dir`) at most every 30 seconds, holding
its id, the repo folder name, its cost so far and the time. The toast reads the files of the sessions refreshed in the
last 10 minutes. A session removes its file when it ends cleanly; one that crashes leaves a file that stops counting
after 10 minutes. No prompts, paths or tool output are written. Nothing is sent anywhere.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `percent` | 80 | warn when a window passes this (10 to 100) |
| `share` | on | write and read the cost files; off leaves only this session's cost in the toast and writes nothing |
| `dir` | empty (`~/.claude/ratewatch`) | the shared folder; sessions that use the same folder see each other |

## Cost

No model calls. One small file write per session every 30 seconds while its cost changes.

## Not here

It does not slow, stop or switch the model when you are near the limit; it only tells you. Context size is a different
thing: [thrift](../thrift) coaches that.
