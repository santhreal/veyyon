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

   ←→ move · enter open · 1–3 jump · n new · x close · tab all windows · esc back to 2
```

The view has two layouts:

- **Side by side** puts the selected window in front at full height. Its neighbours recede to
  either side, smaller and fainter the further away they are. `←` and `→`, a horizontal swipe
  or the wheel glide the row.
- **All windows** lays every conversation out in a grid at one size. The arrow keys move between
  windows, and the pointer selects the window under it. When the terminal is too short for every
  row, the grid shows the rows around the selected window and moves with the selection.

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
- A conversation with an unsent draft shows it at the foot: `✎ draft · explain the second fact ·
  1 image`. A question waiting for an answer takes the last row, under the draft.
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
| Esc, `alt+w` | Go back to the conversation the view was opened from; the key row names its number |

## Moving between conversations

| Action | Keys |
| --- | --- |
| Open the room view | `alt+w` (`app.room.view`), `→` twice on an empty composer, `/room`, or, with `tui.scrollIsolation` on, a click on the status line's room chip |
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

- its window shows `needs you` on its edge and `waiting for your answer` at its foot, and its
  frame keeps the ember of a waiting prompt, quieter than the selected window's;
- the room view's title and the ordinal under the windows mark it with `!`, and the key row reads
  `enter answer` while its window is selected;
- the status line's `room` chip counts it ahead of the working ones: `3 peers · ! 1 needs you · 1 working`;
- the status line says once which conversation is waiting and which key opens the room;
- a question from the `ask` tool sends its desktop notification (`ask.notify`) at once.

## When a conversation finishes

A conversation that ends its turn while it is off screen says so once on the status line, with
the key that opens the room: `2 · parser rewrite finished — alt+w opens the room`, or `failed`
when the turn ended on an error. A stopped turn says nothing, and while the room view is open the
window's edge says it instead of the status line.

With `completion.notify` on, a finished turn also sends a desktop notification, from the
conversation on screen and from one off screen alike.

## Desktop notifications

In a room, every desktop notification is titled with its conversation's number and name
(`2 · parser rewrite`, or `conversation 2` while it has none), whichever conversation is on
screen, so the notification says which one to go to. Alone, a notification keeps its own title.
None is sent while the terminal has focus.

## Drafts, closing and exit

Text and images you leave in the composer stay with their conversation and come back when you
return to it, whichever way you leave: a room switch, `/resume` of a running session, or a `/new`
that keeps the running turn.

`n` or `/room new` while a new conversation is still opening says so and opens no second one. A
conversation that fails to join the room is closed rather than left running where nothing lists
it.

`x` in the room view closes a conversation: a question it was holding is dismissed, its turn is
stopped, its draft text is saved beside its transcript, and it leaves the room. A close that fails
says why and leaves the conversation in the room; exit closes it. The first conversation in the
terminal holds the MCP servers and background jobs the others share, so it closes only when you
exit.

At exit every conversation's transcript is flushed, each unsent draft's text is saved, and the
questions held by conversations off screen are dismissed. Draft images are not saved.

## The status line

The `room` segment counts the other conversations in the room of the conversation on screen, then
how many are waiting for you and how many are working: `2 peers · ! 1 needs you · 1 working`. It
is hidden while you are alone, and while a conversation outside every room is on screen, such as
one `/new` opened. It is in every preset. With `tui.scrollIsolation` on, clicking it opens the
room view; with it off the terminal keeps the mouse and the chip is text.

The run clock beside the location keeps each conversation's own time. Going into a conversation
that is working shows how long its turn has run, including the time it ran off screen, on the run
clock and on the working line above the composer.

The `background` segment counts conversations running with nothing drawing them that are not in
the room, such as a turn handed off by `/new`. A room member running off screen is counted by
`room` and not by `background`.

## Working directories

The process working directory follows the conversation on screen. A conversation that changes
directory while it is off screen records the move, and the terminal re-roots to it when you go
into that conversation.

## Extensions

Each conversation loads its own extensions. An extension's questions, title, editor text and
autocomplete reach the screen only while its conversation is on it. A question waits, as above;
the title and editor text are dropped while the conversation is off screen, and its autocomplete
applies again when you go back into it.

Status text and widgets belong to the conversation that set them. The terminal shows the ones the
conversation on screen set, including those set while it was off screen, and going into another
conversation replaces them with that one's. A component widget is built again from its factory
each time its conversation comes back on screen.

A conversation opens without waiting for its extensions' `session_start` handlers, so a handler
that asks a question asks it when you go into the new conversation.

## Messaging between conversations

Conversations in one room are `irc` peers. Each lists the others under `irc list`, marked as room
peers, and can message them by id. `to: "all"` reaches only the sender's own spawns, and a spawned
agent cannot reach the conversation next door or its spawns.

## Recording

`proof/scenes/room-view.sh` drives three conversations through the room view with a local model
and ends with one finishing off screen, `proof/scenes/room-needs-you.sh` holds an approval asked by
a conversation off screen until it is entered, and `proof/scenes/settings-room-view.sh` records
the `room.view` setting both ways:

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
