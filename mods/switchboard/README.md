# switchboard

See your other Claude Code sessions at a glance. With several sessions open, one of them is usually waiting for you
to answer a question or approve a command, and you find out late. Switchboard tells you which, and stays out of the
way the rest of the time.

```
/plugin install switchboard --marketplace Egoushka/claude-mods
```

## What you see

**The row.** Above the prompt, only while another session has been waiting on you for 30 seconds or more, one line in
the theme's warning colour:

```
2 sessions need you: infra · deploy 3m, web · fix-login 41s     [Open]
```

When nobody waits, nothing is drawn. The names are the repo folder and the branch (`repo · branch`, or just the repo on
its default name). The line shortens to `... +2 more` when the terminal is narrow. **Open** shows the pane.

**The pane.** `/board` (or the **Open** button) opens a pane titled "Sessions" with one line per live session, the ones
that need you first, then the ones working, then the ones done, the oldest first within each group:

```
● infra · deploy   needs you   3m  ctx 41%
● web · fix-login  working    12m  ctx 70%
● app · main       done        5m  ctx 12%  this one
```

The dot and the state word share a colour: warning for needs you, success for working, inactive for done. With no other
session it says "No other sessions are running."

Everything uses the theme's own colours, so it reads in light and dark. It is checked on terminal, desktop, VS Code
and mobile trees in the tests; the Desktop app has not been looked at on screen yet.

## How it knows

Each session writes one small JSON file, `<session id>.json`, into a shared folder (`~/.claude/switchboard` unless you
set `dir`) every 15 seconds and whenever its state changes, and reads the other files in the folder. Nothing is sent
anywhere. A file that has not been refreshed for 90 seconds counts as gone (the session was closed or crashed); files
older than a day are deleted by whichever session runs next. A session's own file is removed when it ends cleanly.

A session reads as:

- **needs you** when a tool call is waiting for your approval or the model asked you a question;
- **working** from the moment you send a prompt until the turn ends;
- **done** when the turn has ended and it waits for your next prompt.

Subagents do not change the state; only the main conversation does.

The file holds the session id, the `repo · branch` name, the state, when it began, when it was last refreshed and the
context percentage. No prompts, paths or tool output.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `dir` | empty (`~/.claude/switchboard`) | the shared folder; sessions that use the same folder see each other |
| `showBand` | on | the row above the prompt; off leaves only `/board` |
| `minWaitSeconds` | 30 | how long a session must wait before it shows in the row |

## Cost

No model calls. One `git rev-parse` and one small file write per session every 15 seconds, plus a read of the other
sessions' files.
