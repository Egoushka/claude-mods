# handoff-autopilot

Long sessions cost the most, because every turn re-reads everything that came before. The cure is a fresh session that
starts from a handoff note, but writing the note is the chore that gets skipped. Handoff-autopilot offers to write it
for you once the session has grown, drafts it from the session itself in one click, and gives you the prompt that
starts the next session.

```
/plugin install handoff-autopilot --marketplace Egoushka/claude-mods
```

## What you see

Nothing, until the context window passes the threshold (60% by default). Then one row above the prompt, after a turn
ends:

```
This session has used 62% of its context. Draft a handoff before it grows?     [Draft] [Not now]
```

- **Draft** asks the model, over the session you already have, to write the handoff. The row dims while it works
  (`Drafting the handoff…`), then turns to the theme's success colour:

  ```
  Handoff saved to docs/HANDOFF.draft.md.     [Copy start prompt] [Done]
  ```

  **Copy start prompt** puts `Continue: read docs/HANDOFF.draft.md, check it against git, and carry on.` on the
  clipboard. Open a new session and paste it. A mod cannot open the new session for you, so that last step stays a
  paste.
- **Not now** hides the row until the context has grown another 15 points, then asks once more.
- If the draft fails, the row turns to the theme's error colour with the reason in plain words (`nothing to hand off
  yet`, `the API answered 529`) and **Try again** / **Dismiss**.

`/handoff-draft` drafts at any time, whatever the context use, and works with the offer turned off.

Everything uses the theme's own colours. It is checked on terminal, desktop, VS Code and mobile trees in the tests;
the Desktop app has not been looked at on screen yet.

## The draft

The model is told to write only the document, to use what the session saw, to mark anything it did not see confirmed as
"unverified", and never to invent a commit, a PR number or a test result. The sections are severity, goal and state,
what is done with its evidence, numbered next actions, open questions for you, "if X then Y" contingencies, and read-only
commands that verify the state. It cannot run commands, so read it against `git status` before you rely on it; the
start prompt says to check git for the same reason.

The file goes to `docs/HANDOFF.draft.md` under the session's folder, is overwritten on each draft, and is never a
`HANDOFF.md` of your own. Keep it out of commits (`echo docs/HANDOFF.draft.md >> .git/info/exclude`) if the repo is
public: a handoff can name local paths.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `atPercent` | 60 | context use at which the row appears; 0 turns the offer off |
| `file` | `docs/HANDOFF.draft.md` | where the draft is written, relative to the session's folder |

## Cost

One model call per draft, and only when you press **Draft** or run `/handoff-draft`. It is a fork of the session, so
the API serves the session's history from its prompt cache while the cache is warm (about five minutes after the last
turn); after that the history is billed again once, which is what the draft costs on a long session. Output is a page
of text. No call is made to decide whether to show the row.
