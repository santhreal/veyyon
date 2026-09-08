# Surfaces and interactions

## Shell

The queue lists sessions beside the active transcript. User messages, assistant
responses, tool activity, and pending decisions appear in the transcript. The
composer floats above its lower edge. The right panel displays workspace content;
the terminal drawer displays terminal output below the session.

The queue collapses when the window cannot fit it beside the transcript. At the
minimum window width, the composer remains available across the transcript.

The transcript and composer remain the primary work area. Workspace inspection
and terminal output use contextual panels rather than permanent command menus.
Typography, spacing, control sizes, and motion use the shared design tokens.
Every settings row is 44px tall, with its label on one line and its description
on one line under it. A description longer than the row truncates; the pointer
over the row opens the whole description in a tag. Focused pages scroll their
content without displacing their navigation header.

`Primary` means `Cmd` on macOS and `Ctrl` on Linux and Windows. Default bindings are
in `crates/veyyon-desktop-surface/keymap.toml`.

| Shortcut | Action |
| --- | --- |
| `Primary-N` | Create a session |
| `Primary-B` | Toggle the queue |
| `Primary-J` | Toggle the terminal drawer |
| `Primary-\` | Toggle the right panel |
| `Primary-K` | Open the command palette |
| `Primary-,` | Open settings |

## Queue

The sidebar is a session queue. Its header contains session search and the
new-session action. Sessions appear in this order:

| Section | Contents | Row shape |
| --- | --- | --- |
| Unsent | Drafts not yet submitted | Card |
| Pinned | Sessions retained at the top | Card |
| Live | Sessions running or awaiting input | Card |
| Deferred | Sessions set aside until a time or event | Compact line |
| Parked | Sessions set aside indefinitely | Compact line |

Each section collapses independently. Collapsed sections retain their header
and count; empty sections are hidden. The session list scrolls between the header
and the fixed footer.

Pinned holds the operator's order. Live sorts by its anchor, newest first, and
agent activity does not reorder it. Deferred sorts by return time, soonest
first, and a session deferred from the rail names no return time and sorts
last. Parked sorts by when each session was parked, most recent first.

Parked shows 25 lines and then an `Older (N remaining)` row. Clicking that row
adds the next 25.

Cards display the session title, workspace, status, and relevant timing.
Secondary actions remain hidden at rest and do not shift the title when revealed.
Selection, hover, and status have distinct treatments. Compact rows retain
readable text and usable pointer targets.

A card states the title the host reports for that session, including a rename
during a turn. A session with no title states `new session`.

### Row badges

A row carries at most one badge, derived from the state the host reported for
that session. Higher rows in this table win when more than one state holds.

| Badge | State |
| --- | --- |
| Approval | A tool call is waiting for approval |
| Input | A question is waiting for a reply |
| Plan | A plan is waiting for a decision |
| Failed | The last turn ended in an error |
| Due | A deferred session's return time has passed |
| Done | The last turn finished |
| Working | A turn is running, counting up from the message that started it |
| Watching | A supervised process is running under the open session |

A running turn suppresses Failed and Done, which read the status of a file
written before the turn started. Failed, Done, and Due appear until the session
is opened; opening it clears the badge. Attaching to a host that holds finished
sessions raises no badge on any of them.

Watching appears on the open session's row alone. A supervised process belongs
to the whole project directory and names no session.

The line beside the run bar's badge states what the badge cannot: the running
tool, the waiting tool and its command, the question, the plan's first line, or
the names of the running processes. A finished, failed, or due session states
nothing there, and the transcript, the error's own control, and the row carry
that instead.

The footer contains one Settings gear. It opens the same group as `/settings`.
Settings is the only slash-command destination with a permanent sidebar shortcut.
Account, Agents, Models, and other command destinations remain in command
navigation rather than becoming sidebar buttons.

Card rows show Park and Defer while the pointer is over the row. Parked lines
provide Unpark; deferred lines provide Recall.

Park, defer, and pin are window state and are not written to the session file.
They last until the window closes, and a session index sent while the window is
open does not move a session out of the section it was placed in. A session the
agent no longer holds is removed from the queue.

Right-click a card for Open, Park, Defer, Branch, and Delete. A pinned card also
offers Unpin, which a card's two hover actions have no room for. Parked lines
offer Open and Unpark; deferred lines offer Open and Recall. Branch starts a new
session before the latest user message on the selected session's active branch,
without changing the source session. Extensions can cancel the operation.
Unavailable and pending management actions are disabled in the menu.

Click the queue to focus it for the keyboard.

| Shortcut | Action |
| --- | --- |
| `Up` / `Down` | Move the selection |
| `Enter` | Open the selected session |
| `P` | Pin the selected session, or unpin it |
| `D` | Defer the selected session, or recall it |
| `K` | Park the selected session, or unpark it |
| `/` | Search the queue |

`P`, `D`, and `K` read the section the session is in: a session already in that
section returns to Live.

## Transcript

Click the transcript to focus keyboard navigation.

| Shortcut | Action |
| --- | --- |
| `Home` | Move to the first turn |
| `End` | Move to the live edge and resume following output |
| `PageUp` / `PageDown` | Move by the measured viewport height |
| `Primary-F` | Find matching transcript blocks |

Keyboard scrolling uses the configured scroll transition. Manual scrolling
interrupts that transition. Reduced motion applies the destination immediately.
Reading earlier output pauses tail following. The **Scroll to end** button
returns to the live edge, and it is shown only while the last row is off
screen: a transcript shorter than the viewport draws none, whatever stopped it
following. Switching sessions restores their saved scroll anchors.

The find bar displays the selected matching block and total matching blocks.
`Enter` advances to the next matching block; `Escape` closes the bar.

Persisted model, thinking-level, service-tier, and session changes display their
recorded values. Hidden custom messages, internal checkpoints, and the runtime's
own bookkeeping records — the pending-tool-call warning, the exit diagnostic, a
todo edit, an extension's stored state — do not create visible turns. Unknown
extension entries retain their original data.

A tool call occupies one row while it is collapsed: the card's status line, its
block header, or the section it names, followed by how many lines it is holding
back. `Space` on the focused turn and a click on the row open the same card, and
both close it again. An open card states no held-back count on its row, since
the card below it shows every line.

Developer and custom records display labeled annotations below the assistant
reading size. File, model, thinking, and lifecycle events use the same annotation
style. Branch and compaction summaries have distinct labels and a separating
line. Execution output includes its shell or Python label. Transcript search
matches annotation labels and recorded content.

An `@path` in a prompt reads that file, and each file read is drawn on the
operator's turn beside the prompt text as one collapsed row. The row states the
path with its line count and size, or why there is no body: too large to read,
binary file, or content not replicated to a collab guest. A mentioned image
states its pixel dimensions and expands to the picture.

Vertical spacing has four steps. Consecutive event lines run with no gap between
them. Blocks of one kind sit 4px apart. A change of kind starts the next group
8px down. Turns sit 16px apart. A run of tool calls therefore reads as one band
and the prose after it as a new subject.

An agent turn ends with a footer naming the model that produced it, at the
annotation size. The name is shown while the pointer is over the turn and while
the turn cursor (`Ctrl+Up`, `Ctrl+Down`) is on it. A turn the host reported no
model for has no footer. Click the name to open the session's token and cost
accounting on one line in the right panel's **Usage** tab. The tab is absent
when the host reports usage unavailable, and the footer then names the model
only. A tab opened this way stays until the host reports usage unavailable.

The turn cursor stops on the first and last turn. On the last turn the
transcript keeps following new output; on any earlier turn it stops, so
streamed output does not move the turn being read.

## Composer

The footer contains the model selector and an up-arrow primary action. A separate
stop control appears while a turn runs. Secondary composer actions are available
through slash commands rather than a permanent row of buttons.

The arrow glyph is the same in every session state. Hover the button to read
the name of the action it performs in the current state, which opens above the
button. A control the host holds back states its reason there instead.

| Session state | Primary action |
| --- | --- |
| Idle, nonempty draft | Send |
| Running in steer mode, nonempty draft | Steer the running turn |
| Running in queue mode, nonempty draft | Queue a follow-up |
| Pending question | Submit the text reply, or the first option when the draft is empty |
| Pending approval | Approve |
| Pending plan, empty draft | Accept the plan |
| Pending plan, nonempty draft | Request refinement |

Host control availability applies to keyboard, pointer, and palette submission.
An empty or whitespace-only draft does not send a new prompt.

Multiline drafts grow to the composer height limit, then scroll to keep the
caret visible. Moving the caret or resizing the field updates the visible text,
pointer hit testing, and input-method candidate position.

- `Enter` activates the primary action, or the selected slash command while its
  palette is open.
- `Shift-Enter` inserts a newline.
- `Primary-Enter` submits nonempty text in the alternate running-turn mode without
  changing the selected mode.
- `Primary-.` requests an abort.
- `Primary-/` selects steer or queue mode. The window holds the selection for
  as long as the session is open; a host frame does not change it. A host that
  reports no background submission leaves steer as the only mode.

### Submitted drafts

Send, steer, and queue requests retain editor content until the matching host
acknowledgment. A successful acknowledgment clears text only when the active
session and current text still match the submitted snapshot. Different current
text remains in the editor. Failed requests do not consume the draft.

Successful submission removes attachments included in that request. Attachments
added afterward remain unless they compare equal to a submitted attachment.
Unrelated and duplicate acknowledgments do not consume content.

### Queued prompts

A prompt sent while a turn runs waits in the session's queue, and the composer
lists what waits above the input: the steering prompts, which enter the running
turn at its next tool boundary, then the follow-up prompts, which run after the
turn ends, each oldest first. Each prompt occupies one truncated line under a
count of what is held.

`Alt-Up`, and the control at the strip's trailing edge, take the newest queued
prompt out of the queue and put its text back in the draft. The queue releases
prompts newest first, so there is no per-prompt removal control. The strip is
absent while the queue is empty.

## Model picker

Click the model selector or press `Primary-Shift-M` to open the model picker above
the composer. Rows sit under a heading per provider, stated once above the models
that provider serves. The provider holding the model in effect comes first, and
that model is the first row under it, marked `in effect`; a model that reasons is
marked `reasoning`. A row states its identifier on a second line only when the
identifier is not the name already drawn. Search matches display names, provider
names and `provider/model` identifiers in the host catalog. Use the arrow keys to
select a row and `Enter` to confirm. Selection remains subject to host
availability.

`Escape` or a click outside closes the picker and returns focus to the composer.
Opening, filtering, and dismissing it leaves the draft unchanged.

The GUI host and SDK sessions load profile models from `models.yml`, with
`models.yaml` as the fallback and migration from legacy `models.json`.
Configured models are available before the first model selection.

## Slash commands

Type `/` at the beginning of the composer to open the anchored command palette.

| Command | Action |
| --- | --- |
| `/attach` | Select attachments |
| `/model` | Open the model picker |
| `/effort` | Select an available thinking level |
| `/queue-mode` | Select steer or queue mode |
| `/steer` | Steer the running turn with the command payload |
| `/queue` | Queue the command payload |
| `/files` | Find a file in the workspace by name |
| `/project` | Browse the workspace one directory at a time |
| `/search` | Search the workspace for text |

The palette also includes session, terminal, settings, provider, and other host
commands. Attachment admission depends on the host and model input capabilities.

Command search matches slash names and action descriptions. For example,
`Primary-K`, `new session`, then `Enter` creates a session.

Selecting a composer command removes its command prefix while retaining the
payload and attachments. `Escape` dismisses the slash palette without deleting
the typed slash text.

A command name matches in any capitalisation: `/Steer` reaches the same row as
`/steer`, and the word `commands` after the slash opens the complete list
whichever way it is capitalised. `/steer` and `/queue` are the two commands
that take a payload, so text after the name is the message they send. Every
other command matches on the whole text typed after `/`, and words after its
name list no row rather than a row that would discard them.

`/files`, `/project` and `/search` open a lookup instead of closing the
palette. The palette stays open in the mode the command named, at the centred
width, and the field prompts for what that mode looks up. The keyboard goes to
that field, so the next keystroke filters the lookup rather than editing the
draft. Typing filters files by name in `/files`, and searches the workspace for
the literal text in `/search`. Emptying the field drops the rows the host
answered with, since an empty query looks nothing up. In `/project`, `Enter` on
a directory row lists that directory and `Escape` returns to the one above it.

A result row states its text on one line, with its detail beside it: the file
and line number of a search hit, the path of a file, the description of a
command. Text too wide for the row truncates the primary text and keeps the
detail, which is what names where the row came from. A detail takes at most
half the row.

## Command groups

`/account` opens the Account group with Account manager and Sign in.
`/settings` opens General, Themes, Keybindings, and Diagnostics.
`/agents` opens the Agents surface.

The sidebar Settings gear and `/settings` use the same destination and navigation
state.

Groups and focused pages use the same Back, title, and Close header. Back or
`Escape` returns to the parent group and restores its search text. At the root,
`Escape` closes the palette. Close dismisses the surface directly.
Navigation leaves the composer draft and attachments unchanged.

General settings renders viewport-adjacent rows as the list scrolls. Value updates
preserve the scroll position. The page header remains visible at the minimum
window height.

Each focused page has its own command name: `/account manager`, `/account login`,
`/hotkeys`, `/mcp`, `/agents`, `/usage`, `/context`, `/settings themes`, and
`/settings diagnostics`.

## Terminal and process output

Click the terminal grid to focus it. Terminal input is sent to the host without
local echo. An overlaid drawer blocks pointer interaction with the composer
beneath it.

Each supervised process has a drawer tab named after it, beside the terminal
tabs. The tab displays the last 200 lines of that process's output in the same
80-column monospace grid, and the drawer has no scrollback of its own. The tab
is read-only: terminal input reaches a terminal, not a process.

A host that runs no terminal and supervises no process has no drawer. The
titlebar control, `Primary-J`, and `/terminal` are absent, and a drawer left
open closes when the host stops offering one.

## Right panel content

The **File** tab displays the file opened from the tree, or the exported
transcript when no file is open. An export is highlighted by its format, so
Markdown, HTML, and JSON exports read as the same format opened from the tree.
Opening a file replaces a displayed export. The **File** tab is present without
file browsing when an export is the only document.

The panel docks as a resizable column beside the transcript. Below 980px it
floats at the trailing edge over the transcript, behind a blurred scrim. A
float covers the transcript alone: the session queue, the cards above the
composer, the composer and the run bar keep their colour, their presses and
the keyboard, so a prompt typed with the panel open is drawn where it is
typed. A float takes its height from the transcript.

Click the panel to focus it for the keyboard.

| Shortcut | Action |
| --- | --- |
| `Primary-Alt-]` | Move to the next tab |
| `Primary-Alt-[` | Move to the previous tab |
| `Primary-Shift-D` | Switch the diff between unified and split |

The tab walk wraps at both ends.

## Record native interactions

Build the current executable with `cargo build -p veyyon-desktop` and build the
recorder with `proof/docker/build-recorder.sh`. The output directory must be
writable by the recorder container, including on NFS mounts.

```sh
proof/docker/record-native.sh proof/scenes/desktop-composer.sh
```

`record-native.sh` runs the window rather than a terminal: it mounts the
executable into the container, points the session at the checkout's tokens and
themes, and renders through lavapipe, so a capture needs no GPU. It takes the
executable from `DESKTOP_BINARY`, or from this workspace's cargo target
directory, and states the build command when there is none. `SCENE_WIDTH` and
`SCENE_HEIGHT` default to 1180x800; `OUT_DIR` names the output directory.

For the host's NVIDIA device instead, set `PROOF_GPU_DEVICE=nvidia.com/gpu=all`
and `VK_ICD=/etc/vulkan/icd.d/nvidia_icd.json`. The host's CDI specification must
match its current driver and device nodes.

The scene uses automatic host startup in the container's isolated home. It checks
the initial session snapshot and waits for the session-creation interaction to
produce a new host session before entering a draft. It records model-picker
opening and dismissal, repeated palette transitions, and slash palette opening
and dismissal. Set `SCENE_WIDTH=800` for the minimum-width case.

Use `proof/scenes/desktop-navigation.sh` with the same capture environment to
exercise a completed host response, transcript paging, find, contextual panel
transitions, and session creation through command search. Set
`PROOF_LLM_BASE_URL` to an endpoint reachable from the recorder container.

Use `proof/scenes/desktop-surface-navigation.sh` with the same capture environment
to exercise command groups, focused Account and Settings pages, settings scrolling,
parent navigation, draft-focus restoration, and queue action visibility.

Use `proof/scenes/desktop-terminal.sh` to open the terminal drawer, focus its grid,
and execute a shell command. Set `SCENE_WIDTH` to `800` and `1180` for overlaid and
docked drawers.

Use `proof/scenes/desktop-tool-view.sh` to record a real tool call and disclose its
card twice, once with `space` on the focused turn and once by clicking the card's
row. The two open frames show the same card, which is what a host-held disclosure
means.

Use `proof/scenes/desktop-live-edge-pill.sh` to drive a real turn, step the turn
cursor off the last turn of a transcript that fits the viewport, and count the
accent pixels the jump button fills with. Record its other arm with
`PROOF_BASE_REF=HEAD`, since the change is inside the executable alone.

Use `proof/scenes/desktop-queue-badge.sh` to run a real turn and count the
pixels of the `working` tint the row's badge fills with, while the turn runs and
after it ends. Record its other arm with `PROOF_BASE_REF=HEAD`, since the change
is inside the executable alone.

Use `proof/scenes/desktop-settings-field.sh` to type into a real General
settings row and count the lit pixels of its value column at rest, while a new
value is typed, and after the host has stored it. Record its other arm with
`PROOF_BASE_REF=HEAD`, since the change is inside the executable alone.

Use `proof/scenes/desktop-settings-column.sh` to press the leading third of a
settings row's control column and then a queue card the open dialog covers. It
counts the lit pixels of the column's leading half and the pixels of the
titlebar's session name that a press behind the scrim moves. Record its other
arm with `PROOF_BASE_REF=HEAD`, since the change is inside the executable alone.

Use `proof/scenes/desktop-turn-control.sh` to submit a real prompt on a local
model and photograph the run bar while the turn runs: its primary action as
steer, the same run after `primary-/` puts it in queue mode, a follow-up
submitted behind the running turn, and the turn stopped by `primary-.`. It waits
on the host's own session state rather than on a pause, so an idle composer
fails the take instead of being photographed as a running turn. The steer and
queue frames are one differential: the primary action is the whole difference
between them. Record its other arm with `PROOF_BASE_REF=HEAD`, since the change
is inside the executable alone.

Use `proof/scenes/desktop-settings-row.sh` to photograph the General page at
rest and with the pointer on a row's description. It counts the control bands
in the page body, the distance between the first two, and the pixels a hovered
row changes under itself. Record its other arm with the base ref that precedes
the change, and name a copy of the token files as they stood in
`PROOF_TOKENS_DIR`: the source hold covers `packages/` and its siblings, never
`crates/`, so a pre-change executable handed a token file with a key it does
not know fails to load.

Output is written to `proof/captures/x11/`, or the absolute directory in `OUT_DIR`.
The [capture requirements](../foundations/verification.md) specify paired static
frames and animated clips. Headless scene PNGs do not replace native captures.

Native Before recording also requires `PROOF_NATIVE_BEFORE_BINARY` to identify
the executable built from the baseline source, since holding source files back
rebuilds no binary. The recorder rejects missing, non-executable, or
byte-identical Before and After binaries. `SCENE_ARM=before` sends
`record-native.sh` down that path. For a native-only change, set
`PROOF_BASE_REF=HEAD` to retain the same host source in both arms.

See [Motion](motion.md) for transition behavior.
