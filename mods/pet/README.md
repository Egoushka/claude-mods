# pet

A small creature per repo, in the band above the prompt. It eats what you ship and gets sick when things break.

```
 /\_/\    Pip  level 3 · 24/40 xp
( ^.^ )   fed ████████░░ happy
 > ^ <    green tests, yum
          [ pet ]
```

## What feeds it

| Event (a Bash call that ...) | Effect |
|---|---|
| runs a test suite and exits 0 (`npm/pnpm/yarn/bun test`, `vitest`, `jest`, `pytest`, `go test`, `cargo test`, `dotnet test`, `mvn/gradle ... test`, `make test`, `claude plugin test`, ...) | +5 xp, much less hungry, heals |
| `git commit` succeeds | +3 xp, a little less hungry |
| `gh pr merge` succeeds | +15 xp, a feast |
| `gh pr checks` / `gh run watch` shows all passing | +4 xp |
| a test run fails | sick for 20 minutes |
| `git push --force` (or `-f`, `--force-with-lease`) succeeds | sick for 60 minutes |
| `gh pr checks` / `gh run watch` shows a failure | sick for 30 minutes |

The `pet` button is worth 1 xp, once a minute. Hunger rises by one point every six minutes. Level n needs `10 * (n-1)²` xp; a level-up shows a toast. Quoted text in a command is ignored, so `git commit -m "fix jest"` is a commit and not a test run.

State is per repo root (name, xp, level, hunger, mood) and kept in the plugin's store. A repo gets a stable default name; `/pet name <name>` renames it, `/pet reset` starts over, `/pet` shows its state.

The pet composes the band: it draws its row and then whatever else draws there. It hides while a survey is up.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `enabled` | true | Turns the pet off: no band, no feeding, no command |
| `compact` | false | One line: `(=^.^=) Pip L3 ████░ [ pet ]` |

## Cost

Nothing leaves the machine and there are no model calls. Each Bash call is classified with a few regexes.

## Limits

Detection reads command text and exit status, nothing else. A test script that swallows its exit code looks green, and a test command it does not know is ignored. The creature has no idea what the tests were.
