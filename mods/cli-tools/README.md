# cli-tools

Turns shell commands into typed tools. Each one is registered with its schema in the prompt from the first turn (not behind ToolSearch), so the model calls it directly as `mcp__cli-tools__<name>`.

## Setting

`tools` is a JSON array of:

| Field | |
|---|---|
| `name` | 1-64 letters, digits, `_`, `-` |
| `description` | what the model reads |
| `argv` | the command as an array; `{{param}}` is replaced by the call's value |
| `params` | `{ name: { type, description, required?, enum?, allowDash? } }`; `type` is `string`, `number`, `integer` or `boolean`; `required` defaults to true |
| `timeoutMs` | default 30000, at most 600000 |

Example:

```json
[
  {
    "name": "service_logs",
    "description": "Last lines of a service's logs",
    "argv": ["svc", "logs", "{{service}}", "--tail={{lines}}"],
    "params": {
      "service": { "type": "string", "description": "Service name" },
      "lines": { "type": "integer", "description": "How many lines (default 100)", "required": false }
    },
    "timeoutMs": 20000
  },
  {
    "name": "disk_free",
    "description": "Free disk space on the machine",
    "argv": ["df", "-h"],
    "params": {}
  }
]
```

## How a call runs

1. The input is checked against `params`: required present, types right, `enum` respected, no unknown fields. Problems come back to the model as an error, and nothing runs.
2. `argv` is built. The command is never run through a shell, so characters like `;` or `$(...)` in a value are just text. An argument that uses an optional parameter the call left out is dropped, whole (`--tail={{lines}}` disappears when `lines` is absent).
3. A string value that fills a whole argument and starts with `-` is refused, since the command would read it as an option (`--exec=...`). Set `"allowDash": true` on that param to allow it.
4. `$.process.run` runs it in the session's working directory with `timeoutMs`.
5. The model gets `exit code: N`, then `stdout:` and `stderr:`, each cut to `maxOutputChars` (default 20000). A non-zero exit or a timeout is marked as an error.

`/cli-tools` lists what is registered and any problems found in the setting (bad entries are skipped; the rest load).

## Limits

- The tools are registered when the session starts. Removing one from the setting stops it from being served at once, but it may stay listed until the session restarts.
- A command's `stdout` is read whole before it is returned; very long-running or streaming commands (`tail -f`) do not fit. The engine keeps the first 4 MiB of each stream.
- There is no permission prompt per call: the commands you list are the grant. List only commands you are happy for the model to run with any allowed value.
