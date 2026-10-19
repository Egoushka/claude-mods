# Writing a mod in this repo

A mod is a Claude Code plugin whose hooks are one TypeScript module (`register(on, options)`), run inside the CLI.
Each mod lives in `mods/<name>/` and is listed in `.claude-plugin/marketplace.json`.

## Layout

```
mods/<name>/
  .claude-plugin/plugin.json   name, version, description, author, license, "types", userConfig
  hooks/hooks.json             { "modules": ["./register.tsx"] }
  hooks/register.tsx           export const register: Register = (on, options) => { ... }
  hooks/*.ts                   pure helpers (testable without the engine)
  types/index.d.ts             the PluginState contract for every $.state key
  tests/*.test.ts              claude plugin test
  README.md                    what it does, its settings, what it costs
```

## The reference

The engine writes the whole API as a `.d.ts` (about 22k lines). Grep it for the name at hand
(`'tool.call'`, `Pane: {`, `export type ToolCallResult`) and read the declaration and its doc comment.
`claude plugin validate mods/<name>` reads the module the way the engine will.

## Rules learned the hard way

- **`$` may only be passed to functions declared at the top level of the file** (or imported from the mod's own files).
  A closure inside `register` that takes `$` fails validation. Keep per-session variables inside `register` and pass them as arguments.
- `session.start`'s `e` carries `cwd`, `surface` and `isInteractive`. Use `e.cwd`.
- State a drawing reads lives in `$.state` through `atom`, `read`, `update` from `'claude-code'`, declared in `types/index.d.ts`.
  A render hook never writes state; handlers and other events do.
- The band above the prompt (`ui.render` on `{ component: 'AbovePrompt' }`) is one instance shared by every mod.
  Compose, never take it: `const rest = await next(e)` and return `<Box flexDirection="column">{mine}{rest}</Box>`,
  or return `rest` when there is nothing to show. Yield to `e.props.hasSurvey`.
- Elements come from `const { Box, Text, Button } = $.ui.resolve(e)`; tables differ per surface (`Raster`, `Image` are terminal-only).
- A guard (`tool.call`, `prompt.submit`, ...) gets `.catch(($, e, next) => next.called ? next(e) : { deny: '...' })`.
- Model calls: `$.model.classify(text, labels, { model: 'haiku' })`, `$.model.complete({ model, prompt })`,
  `$.model.fork({ prompt })` (reuses the session's prompt cache). Each costs tokens: say so in the README.
- Anything personal (hosts, MCP server names, paths, chat ids) is a `userConfig` field with a neutral default that turns the feature off.
  Nothing in this repo names its author's infrastructure.
- No `import()`, no Node, no DOM. `$.fs`, `$.process.run`, `$.http.fetch`, `$.mcp.call` reach outside.

## Tests

`claude plugin test mods/<name>`. Nothing answers beneath the plugin except what the test registers, so stub the events your hooks reach:

```ts
on('session.start', ($, e) => e)
on('ui.status', ($, e) => ({ value: e }) as never)
on('tool.call', () => ({ result: 'ran' }) as never)
await $.session.start({ cwd: '/home/me/app', surface: null, isInteractive: true })
```

Pure helpers are tested by importing them directly.

## Checking everything

```bash
TYPES=/path/to/claude-code.d.ts ./scripts/check.sh
```

Type-checks, validates and tests every mod. A loaded mod has the types at `mods/<name>/.claude-plugin/types/claude-code/index.d.ts`.
