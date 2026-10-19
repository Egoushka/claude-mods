# rival

A quiet second reviewer. After a turn that changed files, a read-only subagent reads the diff and looks for correctness bugs. A row above the prompt says `rival: 2 findings` with **Show** (a pane listing each as `file:line`, a concrete failure scenario and a confidence), **Fix these** (submits a prompt that quotes the findings and asks Claude to verify each and fix only the real ones) and **Dismiss**.

| Part | What it does | Hooks |
|---|---|---|
| Reviewer agent | `rival:reviewer`, registered at session start. Tools: Read, Grep, Glob, Bash. Its prompt asks for correctness bugs only, each with file:line, a failing scenario and a confidence, as JSON. No style, naming or test remarks. | `$.agent.register` |
| Read-only guard | While the reviewer runs, its Bash is limited to `git diff`, `git log` and `git show` (no chaining, redirects, `--output`, `-c`), and any tool outside the four is refused. | `tool.call` |
| Hidden from the model | The reviewer is not in the main model's agent list and cannot be dispatched by it. | `agent.offer` |
| Trigger | At the end of a main-loop turn, `git diff HEAD --stat` is hashed. A changed hash with at least `minLines` changed lines starts a background review. One review at a time, at most one per `cooldownMinutes`; an unchanged diff is never reviewed twice. | `turn.complete`, `$.agent.spawn` |
| Band and pane | The row, the findings pane, the fix prompt. The row yields to a survey and sits above whatever other mods draw. | `ui.render` |

## Settings

| Field | Default | Meaning |
|---|---|---|
| `enabled` | true | Turn the reviews off without uninstalling |
| `model` | `sonnet` | Alias or id the reviewer runs on |
| `minLines` | 20 | Skip diffs with fewer changed lines |
| `cooldownMinutes` | 10 | Minutes between reviews; changes made meanwhile go to the next review. 0 reviews every changed turn |
| `minConfidence` | 50 | Drop findings the reviewer rates lower (0 to 100) |

## Cost

Every qualifying turn is one extra subagent run on `model`, billed to you, with its own prompt (it does not share the main session's cache and loads no CLAUDE.md). Input is the diff (cut at 60,000 characters, about 15k tokens at most) plus whatever files it reads over at most 14 turns; output is a few hundred tokens. Expect on the order of 20k to 80k input tokens per review on a mid-size change, so a long session of small edits adds up. Raise `minLines` or `cooldownMinutes`, pick a cheaper `model`, or set `enabled` to false to cut it. These numbers are estimates, not measurements.

## Limits

- The diff is `git diff HEAD`: untracked files are not in it. Outside a git repository nothing happens.
- Finding quality is the model's. Treat a finding as a lead, which is why **Fix these** asks Claude to verify before it edits.
- The review is a background subagent started by this mod. Whether the engine also hands its report to the main model as a notification is not documented; if it does, the JSON arrives in the transcript as well.
- The Bash restriction is a pattern check, best effort, like the other guards in this repo.
