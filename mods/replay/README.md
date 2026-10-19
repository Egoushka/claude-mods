# replay

Scrub through what a session changed, one turn at a time.

`/replay` opens a pane. Its header reads `◀ turn 4 (3 of 7) ▶`: the arrows (keys `p` and `n` when the pane has focus) move between turns that changed a file, and the numbered strip under it jumps to a turn. Below, each change of that turn is a file name with `+added −removed`, and its unified diff drawn by the `Code` element in `diff` format.

## What is recorded

Every successful `Edit`, `Write` and `MultiEdit`. The file is read just before the tool runs and again just after, and the diff is computed from the two (3 lines of context, a plain line diff), so it shows what is on disk, not what the model asked for: `replace_all`, whitespace, and a `Write` over an existing file all come out right. A new file shows as all additions. A call that is denied or fails is not recorded.

A "turn" is one run of the main loop (one prompt); edits made by subagents count toward the turn that started them. `/clear` empties the record.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `maxChanges` | 100 | The last N changes are kept in memory; older ones drop off |
| `maxDiffChars` | 12000 | A bigger diff keeps its first hunks (the first is cut to its first lines if it alone is too big) and says how many it left out |

## Cost

Two file reads and one stat per edit; no model calls. A diff is a line-by-line table, so a change with two sides over about 1500 lines each is shown as a plain replacement instead of a minimal diff.

## Limits

- A file over 4 MiB, or one that cannot be read, is listed with a note and no diff.
- Edits made by Bash (`sed -i`, a formatter, a generator) are not seen; only the three edit tools are.
- The record lives in session state, so it is gone when the session ends. Use `git` for history.
