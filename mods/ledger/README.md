# ledger

Active hours per repo, and a drafted post when you merge a pull request in a public repo.

## Hours

Time counts as active in two ways: the length of each turn, and the gap between the end of one turn and your next prompt when that gap is shorter than `idleMinutes`. A longer gap is a break and counts for nothing. Time is keyed by the repo root (`git rev-parse --show-toplevel`, the session folder outside a repo) and the local day, and kept in the plugin's store, so it survives sessions.

`/hours` opens a pane with today, this week (from Monday) and this month per repo, and a total. The Copy CSV button (Export CSV when `csvPath` is set) writes `repo,day,hours` rows to `csvPath`, or copies them to the clipboard when no path is set.

With `hourlyRate` and `monthlyGoal` both above 0, the pane starts with a goal line: `Oct: 42h ≈ 31.5k UAH of 60k`.

## Build in public

When a `gh pr merge` Bash call succeeds, the pull request is read with `gh pr view --json title,body,url,state`. If it is merged, and the repo's `owner/name` or folder matches `publicRepos`, one `$.model.complete` call writes a short post (what shipped, why it matters, no hype). It lands in `draftsDir` as `<timestamp>-<title>.md` and a toast gives the path. For `--auto` merges, the pull request is looked at again when a turn ends. Each pull request is drafted once.

Nothing is posted anywhere. The draft is a file for you to edit and publish.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `idleMinutes` | 10 | A gap under this counts as active |
| `csvPath` | empty | File for the CSV export; empty copies to the clipboard |
| `hourlyRate` | 0 | Money per hour for the goal line |
| `currency` | USD | Label on the goal line |
| `monthlyGoal` | 0 | Income goal per month; 0 turns the goal line off |
| `publicRepos` | empty (off) | Regex over `owner/name` and the repo folder, e.g. `^my-org/` |
| `draftsDir` | empty (off) | Folder for drafted posts |
| `draftModel` | haiku | Model that writes the draft |

Drafting needs both `publicRepos` and `draftsDir`.

## Cost

Hours are local. Each drafted post is one `$.model.complete` request (at most 400 output tokens, the pull request's title and the first 4000 characters of its description as input), plus a `gh pr view` call.

## Limits

- The idle rule is a heuristic: thinking time away from the keyboard inside one turn counts, and work in another tool between two prompts counts only if the gap is short.
- Two sessions in one repo at once both count their own turns, so overlapping time is added twice.
- The store is read and written whole on each update; two sessions writing at the same instant can lose one update.
- The post detection reads the command text, so a merge done outside Claude Code is not seen.
