# thrift

Spend less on tokens and money. Four small features, each on its own switch.

```
/plugin install thrift --marketplace <owner>/<repo>
```

The band above the prompt (shared with other mods; thrift draws on top of whatever is already there) shows up to three lines:

```
thrift · route: trivial → haiku (suggested) · diet: −2.1k/request
context 112k ▲ 6k/turn · ~7 turns to compaction  ▂▃▄▅▆▇
context 163k is past 150k: [ Hand off ] [ Compact ] [ Dismiss ]
```

## Model router

On each prompt you type, one Haiku call sizes the work as `trivial`, `normal` or `hard`. The tier maps to a model you choose.

| Setting | Default | Meaning |
|---|---|---|
| `routerMode` | `suggest` | `off`: no call. `suggest`: a toast and the band line name the model that fits. `auto`: the turn runs on that model. |
| `trivialModel` | `haiku` | Alias (`haiku`, `sonnet`, `opus`) or a full model id. |
| `normalModel` | `sonnet` | |
| `hardModel` | `opus` | |

How `auto` works: the API has no per-turn model switch, so thrift hooks `turn.step` and rewrites `model` on each request of the main loop for that turn. Subagents keep their own model. The session's model (`/model`) is not changed; the next turn starts from it again. A turn already on the wanted model is left alone. Prompts typed while a turn runs, slash commands and meta prompts are not classified.

Cost: one Haiku request per prompt, about 300 input tokens (the rubric plus up to 1500 characters of your prompt) and at most 8 output tokens. It runs before the turn, so it adds a second or so of latency.

Caveats, so you can judge whether `auto` pays off:

- The prompt cache is per model. A turn on a different model than the previous one reads the whole context uncached once. In a long session that can cost more than the cheaper model saves. `auto` suits short sessions, or switching to a bigger model for a hard prompt; for a trivial prompt late in a big session, `suggest` and `/model` by hand is usually the better trade.
- The classifier is a heuristic and can be wrong. The band shows the tier so you can see it.
- Whether the engine accepts an alias in `turn.step`'s `model` is not documented in the declarations; if it refuses, set a full model id in the tier setting.

## Context coach

`session.measure` reports the context size after each response. When it passes `coachThreshold` (default 150000 tokens; `0` turns the coach off), a toast fires once and the band shows a row with buttons:

- **Hand off** submits `handoffPrompt` as a prompt (default: write a handoff note to `docs/HANDOFF.md`).
- **Compact** calls the engine's compaction. It refuses while a turn runs; thrift says so in a toast.
- **Dismiss** hides the row until the context falls below the threshold (after a compaction) and passes it again. Hand off and Compact dismiss it too.

Cost: none by itself. Hand off costs one turn of your normal model.

## Context weather

At the end of each main-loop turn thrift stores the context size (the last 30 turns) and fits a line through the last 6. The line shows the size, growth per turn and the turns left before the engine compacts (`autoCompactThreshold`), or before the window fills when auto-compaction is off. A fall of more than 30% (a compaction or `/clear`) starts the trend over. With a flat or falling trend no forecast is shown. The sparkline is one `Raster` row on the terminal, colored by how full the context was (green, amber, red against the limit), and block characters in a `Text` on the desktop, VS Code and mobile surfaces.

Setting: `weather` (default on). Cost: none. It reads the engine's own figures; `$.session.usage` with `breakdown: summary` estimates locally and sends nothing, and is called once per session and after a reset.

## Instruction diet

`/diet` opens a pane that lists the sections of the system prompt with an estimated size (characters / 4) and a **Drop** or **Restore** button each. Dropped ids are saved per working folder in the plugin's store and removed through `prompt.compose` from every request in that folder. The band shows the tokens saved per request.

Never droppable (shown as `pinned`): `intro`, `system`, `tools`, `actions`, and the short prompt's `lean_body` and `bare`. They carry the engine's tool and safety rules. The hook also keeps the engine's order, so shared sections stay ahead of session ones, which the engine requires. The pane lists what the engine and other mods compose; dropping a section another mod added is allowed.

Costs and limits:

- Saves input tokens on every request. Because the system prompt is cached, the saving is mostly in the cheaper cache-read price, plus a smaller prompt for the context window. The first request after a change misses the cache once.
- Dropping `doing_tasks` or `tone` changes how the model behaves. Try it on one project.
- Where an organization manages Claude Code, `prompt.compose` hooks of a user-installed plugin do not run (the validator says so); `/diet` then lists sections but dropping has no effect.

Setting: `diet` (default on; off removes `/diet` and the hook's effect).

## Token costs at a glance

| Feature | Model tokens |
|---|---|
| Router | one Haiku call per prompt, ~300 in / 8 out |
| Coach | none; Hand off is one normal turn |
| Weather | none |
| Diet | none; saves the sizes it shows, per request |
