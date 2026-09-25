# Rooms

A room is every conversation running in one terminal. Each is a full session with its own
transcript, model, tools, spawned agents and draft. A conversation you leave keeps running, and
the room view shows all of them at once.

## Quick start

1. Ask something long in the conversation you are in.
2. Type `/room new`. A second conversation opens and the screen moves to it; the first one keeps
   answering.
3. Press `alt+w`, or `→` twice on an empty composer. The screen pulls back into a window beside
   the other conversation. The first time, a guide to the room opens over it; any key closes it.
4. Press `1` or `2`, or click a window, to go into it.

`alt+.` and `alt+,` move to the next and previous conversation without opening the view.

## The guide

The first room view a profile opens shows a card over the dimmed windows: what a room is, the
keys that move through it, and what each mark on a window means. Any key or a click closes it,
and does nothing else, so Enter or Esc pressed to dismiss it neither goes into a window nor leaves
the view. `?` in the room view opens it again, and `/room help` prints the same guide into the
transcript. The guide names the room keys as they are bound, so a rebound `app.room.view` shows
its own key.

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

     ←→ move · enter open · n new · x close · tab all windows · esc back to 2 · ? guide
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

The row under the title shows the room's newest [`#room`](#the-room-channel) post: `#room`, who
posted it, and the message. The row is empty while the room has said nothing.

The key row under the windows drops the keys it has no room for, least used first: the digit
jump, then `r`, `x`, Tab and `n`. The arrows, Enter, `?` and Esc stay longest; `?` lists every
key.

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
body. A session is named from its first substantial prompt when a title model is available.
`/rename` names the conversation on screen by hand, and `r` in the room view names the selected
one.

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
| `r` | Name the selected conversation on a line under the windows. The line holds its name selected: typing replaces it, and an arrow, Home or End keeps it to edit. Enter saves; Esc or an empty name keeps the old name |
| Tab | Switch layouts |
| Esc, `alt+w` | Go back to the conversation the view was opened from; the key row names its number |
| `?` | Show the guide; any key closes it |

## Moving between conversations

| Action | Keys |
| --- | --- |
| Open the room view | `alt+w` (`app.room.view`), `→` twice on an empty composer, `/room`, or, with `tui.scrollIsolation` on, a click on the status line's room chip |
| Next or previous conversation | `alt+.` / `alt+,` (`app.room.next`, `app.room.previous`) |
| A conversation by number or id | `/room <n>`, `/room <id>` |
| Open a conversation beside this one | `/room new`, or `n` in the room view |
| Print the room | `/room list` |
| Post to every conversation | `/room say <message>` |
| Explain the room | `/room help` (`/rooms` is an alias of `/room`), or `?` in the room view |

Going into a window zooms it forward until it is the screen. The next and previous keys do the
same without the view: the screen pulls back, the row slides, and the next conversation pushes
in. The line under the transcript names the conversation you arrived in and says whether it is
still working. Pressing the next or previous key again while the screen moves goes on as far as
the presses add up once it lands; the conversations passed over are not entered, so an answer
waiting in one stays unread.

With `display.transitions` off, or on a terminal without 24-bit colour, the view opens and
switches without motion.

## Settings

| Setting | Effect |
| --- | --- |
| `room.view` | The layout the room view opens in: side by side or all windows (Settings → Interaction → Session) |
| `display.transitions` | Off: the view opens, and the conversations switch, without motion |
| `completion.notify` | A finished turn sends a desktop notification |
| `ask.notify` | A question from the `ask` tool sends a desktop notification at once, from a conversation off screen too |
| `tui.scrollIsolation` | On: a click on the status line's room chip opens the room view |
| `app.room.view`, `app.room.next`, `app.room.previous` | The keys that open the view and move to the next and previous conversation (`/hotkeys` lists them) |

The guide shows once per profile; `?` in the view and `/room help` show it after that.

## When a conversation needs you

A conversation that asks you something while it is off screen does not open the question over
the one you are reading. The question waits until you go into that conversation. While the room
view is open, a question from the conversation on screen waits the same way, and comes up when
the view closes onto it. Until then:

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

Until you go into it, a conversation whose turn ended off screen is unread:

- the status line's `room` chip counts it after the working ones:
  `2 peers · 1 working · 1 unread`;
- the room view's title counts it, and the ordinal under its window carries `✓` when it
  finished or `✗` when it failed;
- `/room list` marks it: `2 · parser rewrite [done 14:05, unread]`.

A conversation that starts working again, or holds a question, is counted as that instead.

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
how many are waiting for you, how many are working and how many are unread:
`3 peers · ! 1 needs you · 1 working · 1 unread`. It is hidden while you are alone, and while a
conversation outside every room is on screen, such as one `/new` opened. It is in every preset.
With `tui.scrollIsolation` on, clicking it opens the room view; with it off the terminal keeps the
mouse and the chip is text.

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

## The room channel

`#room` is the room's channel. Every conversation in the room reads it.

- A conversation posts with `irc` `send` and `to: "#room"`. Every other conversation in the room
  receives the post.
- `/room say <message>` posts as you. Every conversation receives it, including the one on screen.
- A working conversation reads a post at its next step; a post that arrives as it finishes its
  turn waits for the next one. An idle conversation reads a post at its next turn: the post waits
  in its context and starts no turn.
- A post that names an idle conversation wakes it. `@2` names conversation 2, by the number the
  room view shows; `@<id>` names a conversation by its registry id. Once 16 posts in a row by
  conversations have woken one, a name wakes nobody until you post to the room; the posts still
  reach every conversation.
- A spawned agent does not post to `#room` and does not receive it. It reports to its parent,
  which decides what the room hears.
- A conversation that joins the room later, with `/room new` or `n`, receives the room's last 20
  posts before its first turn.
- A post appears in each transcript as `#room ⟵ 2 · parser rewrite` followed by the message, and
  the room view shows the newest post under its title.
- `irc list` lists `#room` with every conversation it reaches, by number and id.

Each conversation is told its own number and the ids of the others, and to post to `#room` what
changes another conversation's work: an interface it changed, a file it moved, a decision another
depends on.

## Messaging between conversations

Conversations in one room are also `irc` peers. Each lists the others under `irc list`, marked as
room peers, and can message one by id. `to: "all"` reaches only the sender's own spawns, and a
spawned agent cannot reach the conversation next door or its spawns.

## Recording

`proof/scenes/room-view.sh` drives three conversations through the room view with a local model,
from the guide on its first open to naming one and posting to `#room`.
`proof/scenes/room-needs-you.sh` holds an approval asked by a conversation off screen until it is
entered, and `proof/scenes/settings-room-view.sh` records the `room.view` setting both ways:

```sh
SCENE_COMMAND='bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-1.5b --no-tools' \
	SCENE_MOTION_FLOOR=1 proof/record.sh proof/scenes/room-view.sh
SCENE_COMMAND='bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-1.5b --tools bash --approval-mode ask-command' \
	SCENE_MOTION_FLOOR=0 proof/record.sh proof/scenes/room-needs-you.sh
SCENE_MOTION_FLOOR=0 proof/record.sh proof/scenes/settings-room-view.sh
SCENE_MOTION_FLOOR=0 proof/record.sh --settings 'room.view: all-windows' proof/scenes/settings-room-view.sh
```

Both model scenes need the llama.cpp sidecar; `proof/scenes/new-session-keeps-running.sh` states
how it is started. Add `--before` to record the base branch's arm of either one. The needs-you
scene is a held dialog and a waiting model, still by design, so it records with the motion floor
off.

`proof/scenes/room-tour.sh` tours the room with real agents: three conversations working in the
demo repository, naming each window, and a command answered in the conversation that asked it.
`proof/scenes/room-channel.sh` shows `#room` with real agents: one conversation renames a function
that the conversation beside it is calling, the room view and the other transcript show the post,
and `/room say` posts to both. Each runs against any model with tools and a signed-in provider,
the sign-in given as a directory holding its `agent.db`:

```sh
SCENE_COMMAND='bun /repo/packages/coding-agent/src/cli.ts --model <provider/model> --approval-mode ask-command' \
	PROOF_AUTH_DIR=<auth dir> SCENE_MOTION_FLOOR=0 proof/record.sh proof/scenes/room-tour.sh
SCENE_COMMAND='bun /repo/packages/coding-agent/src/cli.ts --model <provider/model> --approval-mode ask-command' \
	PROOF_AUTH_DIR=<auth dir> SCENE_MOTION_FLOOR=0 proof/record.sh proof/scenes/room-channel.sh
```
