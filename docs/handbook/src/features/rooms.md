# Rooms

A room is every conversation running in one terminal. Each is a full session with its own
transcript, model, tools, spawned agents and draft. A conversation you leave keeps running, and
the room view shows all of them at once.

## Quick start

1. Ask something long in the conversation you are in.
2. Type `/room new`. A second conversation opens and the screen moves to it; the first one keeps
   answering.
3. Press `alt+w`, or `→` twice on an empty composer. The screen pulls back into a window beside
   the other conversation.
4. Press `1` or `2`, or click a window, to go into it.

`alt+.` and `alt+,` move to the next and previous conversation without opening the view.

## The room view

```text
 Room · 3 conversations · ! 1 needs you · 1 working                     side by side

             ╭─ › 2  parser rewrite ─────────── ⠼ running bash 0:41 ─╮
  ╭─ 1 ───╮  │ › split the tokenizer out of the parser               │  ╭─ 3 ───╮
  │ › add │  │                                                       │  │ › fix │
  │ tests │  │ ▏ bash  bun test test/parser                          │  │ the   │
  │  …    │  │ ▏ edit  src/parser/tokenizer.ts                       │  │ flaky │
  │ Done: │  │                                                       │  │  …    │
  │ 12 of │  │ The tokenizer now owns its own state machine; the     │  │ ! wai │
  │ 12    │  │ parser reads tokens through one iterator.             │  │ ting  │
  ╰───────╯  ╰─ claude-sonnet-4 · ~/src/lang ─────────────────────────╯  ╰───────╯

                                  1   2   3!  +

      ←→ move · enter open · 1–3 jump · n new · x close · tab all windows · esc back
```

The view has two layouts:

- **Side by side** puts the selected window in front at full height. Its neighbours recede to
  either side, smaller and fainter the further away they are. `←` and `→`, a horizontal swipe
  or the wheel glide the row.
- **All windows** lays every conversation out in a grid at one size. The arrow keys move between
  windows, and the pointer selects the window under it.

Tab switches between the two. The `room.view` setting (Settings → Interaction → Session) selects
the one the view opens in.

The last slot is always `+`, which opens a new conversation.

## A window

Each window streams its conversation while the view is open:

- The top edge has the ordinal, the session's name, and the state: `starting`, `thinking`,
  `writing`, `running <tool>`, `compacting` or `retrying` with the turn's clock, `done` with the
  time it finished, `failed`, `stopped`, or `needs you`.
- The body starts with the prompt the conversation is working on. A row for each tool call
  follows, then the tail of the answer. A `⋯` row marks where the middle was cut.
- The bottom edge has the model and the working directory.

A conversation with no name has no name on its top edge; its prompt is the first thing in its
body. A session is named from its first substantial prompt when a title model is available, and
`/rename` names one by hand.

A window narrower than the edge text keeps its state and drops its name. A very narrow window
shows its ordinal and a state glyph.

## Keys in the room view

| Key | Effect |
| --- | --- |
| Enter, Space, click | Go into the selected window |
| `1`–`9` | Go into that window |
| `←` `→` (`↑` `↓` in all windows) | Select another window |
| Home, End | Select the first window, or the `+` slot |
| `n` | Open a new conversation and go into it |
| `x`, Delete | Close the selected conversation; press it twice while the conversation is working |
| Tab | Switch layouts |
| Esc, `alt+w` | Go back to the conversation the view was opened from |

## Moving between conversations

| Action | Keys |
| --- | --- |
| Open the room view | `alt+w` (`app.room.view`), `→` twice on an empty composer, `/room`, or a click on the status line's room chip |
| Next or previous conversation | `alt+.` / `alt+,` (`app.room.next`, `app.room.previous`) |
| A conversation by number or id | `/room <n>`, `/room <id>` |
| Open a conversation beside this one | `/room new`, or `n` in the room view |
| Print the room | `/room list` |

Going into a window zooms it forward until it is the screen. The next and previous keys do the
same without the view: the screen pulls back, the row slides, and the next conversation pushes
in. The line under the transcript names the conversation you arrived in and says whether it is
still working.

With `display.transitions` off, or on a terminal without 24-bit colour, the view opens and
switches without motion.

## When a conversation needs you

A conversation that asks you something while it is off screen does not open the question over
the one you are reading. The question waits until you go into that conversation. Until then:

- its window shows `needs you` on its edge and `waiting for your answer` at its foot;
- the room view's title and the ordinal under the windows mark it with `!`, and the key row reads
  `enter answer` while its window is selected;
- the status line's `room` chip counts it ahead of the working ones: `3 peers · ! 1 needs you · 1 working`;
- the status line says once which conversation is waiting and which key opens the room.

## Drafts, closing and exit

Text you leave in the composer stays with its conversation and comes back when you return to it.

`x` in the room view closes a conversation: a question it was holding is dismissed, its turn is
stopped, its draft is saved beside its transcript, and it leaves the room. The first conversation
in the terminal holds the MCP servers and background jobs the others share, so it closes only
when you exit.

At exit every conversation's transcript is flushed, each unsent draft is saved, and the questions
held by conversations off screen are dismissed.

## The status line

The `room` segment counts the other conversations in the room, then how many are waiting for you
and how many are working: `2 peers · ! 1 needs you · 1 working`. It is hidden while you are alone
and is in every preset. Clicking it opens the room view.

The run clock beside the location keeps each conversation's own time. Going into a conversation
that is working shows how long its turn has run, including the time it ran off screen.

The `background` segment counts conversations running with nothing drawing them that are not in
the room, such as a turn handed off by `/new`. A room member running off screen is counted by
`room` and not by `background`.

## Working directories

The process working directory follows the conversation on screen. A conversation that changes
directory while it is off screen records the move, and the terminal re-roots to it when you go
into that conversation.

## Extensions

Each conversation loads its own extensions. An extension's questions, status text, widgets,
title, editor text and autocomplete reach the screen only while its conversation is on it. A
question waits, as above; the rest is dropped while the conversation is off screen, and its
autocomplete applies again when you go back into it.

A conversation opens without waiting for its extensions' `session_start` handlers, so a handler
that asks a question asks it when you go into the new conversation.

## Messaging between conversations

Conversations in one room are `irc` peers. Each lists the others under `irc list`, marked as room
peers, and can message them by id. `to: "all"` reaches only the sender's own spawns, and a spawned
agent cannot reach the conversation next door or its spawns.

## Recording

`proof/scenes/room-view.sh` drives three conversations through the room view with a local model,
`proof/scenes/room-needs-you.sh` holds an approval asked by a conversation off screen until it is
entered, and `proof/scenes/settings-room-view.sh` records the `room.view` setting both ways:

```sh
SCENE_COMMAND='bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-1.5b --no-tools' \
	SCENE_MOTION_FLOOR=1 proof/record.sh proof/scenes/room-view.sh
SCENE_COMMAND='bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-1.5b --tools bash --approval-mode ask-command' \
	SCENE_MOTION_FLOOR=1 proof/record.sh proof/scenes/room-needs-you.sh
SCENE_MOTION_FLOOR=0 proof/record.sh proof/scenes/settings-room-view.sh
SCENE_MOTION_FLOOR=0 proof/record.sh --settings 'room.view: all-windows' proof/scenes/settings-room-view.sh
```

Both model scenes need the llama.cpp sidecar; `proof/scenes/new-session-keeps-running.sh` states
how it is started. Add `--before` to record the base branch's arm of either one.
