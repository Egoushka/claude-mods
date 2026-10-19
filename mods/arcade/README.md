# arcade

A catch-and-dodge game in the band above the prompt while Claude works. Claude's tool calls are what feed it.

```
3 pts ♥♥♡ best 21
    o        $
         #
                 o
        /A\
```

Move the ship with the mouse (hover over the game), or click it and use `←` `→` (or `a` `d`). Esc gives the keyboard back to the prompt. A tool call drops one thing:

| Tool call | Drops |
|---|---|
| Read, Grep, Glob, WebFetch, anything read-only | `o` a coin, 1 point |
| Edit, Write, MultiEdit, NotebookEdit | `$` a gold coin, 3 points |
| Bash | `#` a hazard, costs a life |
| any call that fails | two more hazards |

Every few seconds a coin drifts in on its own so the game does not stall while Claude thinks. Three lives; at zero press Enter or click to retry. Each turn is a round: the score resets when the next prompt starts, a toast gives the final score when the turn ends, and the best score is kept between sessions.

The game uses a `Client` element, a small program that runs in the drawing thread and reads the pointer and keys directly (terminal and desktop surfaces). The `hide`/`play` button folds it into one line. It draws only while a turn runs, is hidden under a survey, and needs a band of 9 rows.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `enabled` | true | Turns the game off |
| `startCollapsed` | false | Start each session with the game folded |

## Cost

None in tokens. The game redraws about eight times a second while a turn runs. The engine caps the band's redraw rate, so a slow terminal drops frames, not turns.

## Limits

- The ship follows the pointer only where the terminal reports mouse moves; otherwise click the game and use the arrow keys.
- Keys reach the game only while it has focus, so typing the next prompt happens with focus on the prompt, not the game.
