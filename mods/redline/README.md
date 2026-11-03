# redline

A row above the prompt that appears only when something you care about is red, and says nothing the rest of the time.
Two things can turn it on: a failing check on the current branch's pull request, and a health command you name
(a status script for your server, say).

```
/plugin install redline --marketplace Egoushka/claude-mods
```

## What you see

One line in the theme's error colour, above the prompt, with two buttons:

```
Homelab: needs a look: web (unhealthy) · CI failing: lint +1 more     [Fix] [Hide]
```

- Health comes first, then CI. Only the failing parts are named; pending and passing checks are not.
- The line shortens with `…` or `+N more` when the terminal is narrow.
- **Fix** puts a prompt in the box ("The homelab check is red: "…". Find the cause with read-only
  commands and propose a fix.", plus a line about the failing CI checks) and does not send it. You read it, edit it, press enter.
- **Hide** removes the row until what is red changes. It comes back when another check fails or a new line appears, and
  it forgets the hiding once everything is green.

When everything is green, the row is not drawn. While a survey is up above the prompt, it stays out of the way.

Colours come from the theme, so it reads in light and dark. The tests mount it on the terminal, desktop, VS Code and
mobile trees; the Desktop app has not been looked at on screen yet.

## How it knows

Every `everySeconds` (120 by default) and once at start, the mod runs two optional commands in the session folder:

- **CI**: `gh pr checks --json name,state`. It needs the GitHub CLI signed in. A branch with no pull request counts as
  green. Failed, errored, timed-out and action-required checks count as red.
- **Health**: the command you give in `healthCommand`, as a JSON list (`["my-status"]`, no shell). With no
  `healthOkPattern`, a non-zero exit means red and the row shows the last line of output. With a pattern, the output must
  match it on some line to be green, and any other output is red with its last line. If the command itself cannot
  run (non-zero exit with a pattern set, for example a missing key), the mod keeps the last answer and stays quiet
  instead of flashing red.

State is only written when the answer changes, so the row does not redraw every two minutes.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `watchCi` | on | watch the current branch's pull request checks with `gh` |
| `healthCommand` | empty (off) | JSON list: the command that tells you whether your own system is healthy |
| `healthOkPattern` | empty | regular expression the output must match to count as healthy |
| `healthLabel` | `Health` | the word in front of the health line |
| `everySeconds` | 120 | how often to check |

Example for a homelab status script whose last line reads `needs a look: nothing` when all is well:

```
healthCommand   ["lab","status"]
healthOkPattern needs a look: nothing$
healthLabel     Homelab
```

## Cost

No model calls. One `gh` call and one health command every two minutes, only while a session is open; set `watchCi` off
and leave `healthCommand` empty and nothing runs.

## Not here

It does not fix anything and does not watch Actions runs that have not reported yet. The desktop app's own Auto-fix
for a pull request is separate and stays opt-in; redline is for terminal and editor sessions and for the health line the
app does not have.
