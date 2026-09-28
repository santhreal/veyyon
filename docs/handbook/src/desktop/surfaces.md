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
Typography, spacing, control sizes, and motion use the theme in
`crates/veyyon-desktop-ui`.
Every settings row is 44px tall, with its label on one line and its description
on one line under it. A description longer than the row truncates; the pointer
over the row opens the whole description in a tag. Focused pages scroll their
content without displacing their navigation header.

A hairline separates the transcript from the docked right panel and from the
terminal drawer. Drag it to resize the panel or the drawer. The pointer
catches it inside an 8px band centred on the hairline, and the hairline is
drawn in the accent colour while the pointer is inside that band or a drag
holds it.

The titlebar centre holds the open session's name as an editable field. Type
over it and press `Enter` to rename that session. The rename applies to the
session on screen, so opening another session before pressing `Enter` renames
that one instead. A name that is empty or only spaces is rejected in the
attention strip and sends nothing. `Escape` restores the name the host reports.

`Primary` means `Cmd` on macOS and `Ctrl` on Linux and Windows. Default bindings are
in `crates/veyyon-desktop-app/src/keymap.rs`.

| Shortcut | Action |
| --- | --- |
| `Primary-N` | Start a thread in the active project |
| `Primary-B` | Toggle the sidebar |
| `Primary-J` | Toggle the terminal drawer |
| `Primary-Shift-D` | Toggle the right panel |
| `Primary-K` | Toggle the command palette |
| `Primary-Shift-P` | Open the command palette |
| `Primary-F` | Search threads |
| `Primary-,` | Open settings |
| `Primary-Shift-M` | Open the model picker |
| `Primary-Shift-A` | Attach files to the next prompt |
| `Primary-.` | Stop the running turn |
| `Shift-Tab` in the composer | Move to the next thinking level |
| `Alt-Q` in the composer | Switch a prompt sent during a turn between steering and queueing |
| `` Ctrl-Shift-` `` | Open a terminal in the drawer |
| `Primary-Q` | Quit |

### Closing the window

`Primary-Q` closes the window and ends the process. Closing the window writes
what it remembers first: the placement, the appearance and the open session.
On macOS the application stays up with no window and the dock icon opens one
again, in the placement, appearance and session the closed window left;
everywhere else a process with no window has no way in, so it ends with the
window.

## Sessions and drafts

The queue rail lists every session by partition. Select a row to open its
session. The titlebar states the open session's name; edit it to rename the
session.

`Primary-W` closes the active right-panel tab. With one tab or none it parks
the open session instead.

Unsent text and attachments remain associated with their session. Closing and
reopening the application restores the open session and its draft attachments.

## History

Use `/history` or **Open session** to search stored sessions. Results include
content matches and are grouped by day and repository. Selecting a result opens
a read-only transcript without switching the active session or replacing its
draft.

**Sessions** returns to search. **Close** or `Escape` dismisses the preview.
**Resume session** opens the selected session for editing. Resuming a session
already open in the current space selects its existing tab and restores its
draft. Loading failures display **Retry loading** instead of a resume action.

## Queue

The sidebar is a session queue. Its header contains session search and the
new-session action. The new-session action is disabled while the host does not
offer session creation and while a create request is in flight. `Primary-N`
creates a session whatever state that action is in, and a refusal from the host
is stated under the action. Sessions appear in this order:

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

`/` in the queue opens session search over the rail's own rows. Typing narrows
the rail as it is typed, and the query stays on the rail after the search
closes: the header states it and the control beside it clears it. A query that
matches no session leaves the rail stating the step out of it. Creating a
session clears the query, so the new session is listed.

Pinned holds the operator's order. Live sorts by its anchor, newest first, and
agent activity does not reorder it. Deferred sorts by return time, soonest
first, and a session deferred from the rail names no return time and sorts
last. Parked sorts by when each session was parked, most recent first.

Unsent is derived from the composer, not from a move. A session that is Pinned
or Live, holds unsubmitted text in its composer, and is not the session on
screen is listed there, newest session first. Its row leaves the section it was
placed in for as long as the text is held, and the park, defer and pin actions
on that row still act on its placement. Sending or clearing the text returns
the row to its section, and a prompt the host accepts is dropped whether or
not that session is still on screen when the answer arrives. The session on
screen never moves while it is typed in.
A deferred or parked session keeps unsubmitted text where it was set aside, and
the text returns with the session on recall or unpark.

Parked shows 25 lines and then an `Older (N remaining)` row. Clicking that row
adds the next 25.

The queue docks as a column beside the transcript. Below 980px it floats at the
leading edge behind a blurred scrim, and is closed when a window opens.
`Primary-B` and the titlebar's leading control open it there; `Escape`, the
same control, and a press outside it close it. A float takes no width from
anything, so opening it reflows nothing.

A float covers the whole area below the titlebar and is modal while it is open:
it carries every section, every row and the footer at the height a docked
column has, because at that width it is the only way to reach another session.
The right panel floats differently — it annotates the transcript and leaves the
composer lit.

A docked column and a float carry the same rows, the same sections and the same
footer. The collapsed state `Primary-B` sets on a docked column is the standing
preference and returns with the next window; a float is that window's own and
never returns opened.

Cards display the session title, workspace, status, and relevant timing.
Secondary actions remain hidden at rest and shift nothing in the row when
revealed. A click on the space a hidden action reserves opens the session.
Selection, hover, and status have distinct treatments. Compact rows retain
readable text and usable pointer targets.

A card states the title the host reports for that session, including a rename
during a turn. A session with no title states `new session`.

### Branches

A session started from another one is drawn under it, indented one step per
generation, in the section that holds it. A row with sessions under it carries
a chevron on its leading edge: pressing the chevron folds the branch, and every
generation under it leaves the rail until it is unfolded. Indentation stops at
the depth the sidebar allows, so a deep chain keeps its title readable.

A fold belongs to the space it was made in and is written to the window's
store, so it survives the next session index the host sends and returns with
the next window.

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

Right-click a card for Open, Park, Defer, Branch, Export, Compact, Handoff, and
Delete. A pinned card also offers Unpin, which a card's two hover actions have
no room for. Parked lines offer Open and Unpark; deferred lines offer Open and
Recall. Branch starts a new session before the latest user message on the
selected session's active branch, without changing the source session.
Extensions can cancel the operation. Unavailable and pending management actions
are disabled in the menu. The row under the pointer is filled and the cursor
becomes a pointing hand; a disabled row is neither filled nor pressable.

Branch, Export, Compact, and Handoff run against the session whose row was
right-clicked, and each opens that session: the transcript, the titlebar name
and the row selection state the session the action ran on, so an export taken
from another row leaves the window on the session that was exported.

Click the queue to focus it for the keyboard.

| Shortcut | Action |
| --- | --- |
| `Up` / `Down` | Move the selection |
| `Enter` | Open the selected session |
| `Left` / `Right` | Fold the branch under the cursor, or unfold it |
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
| `Primary-A` | Select the whole entry's text |
| `Primary-C` | Copy the selected text |

Keyboard scrolling uses the configured scroll transition. Manual scrolling
interrupts that transition. Reduced motion applies the destination immediately.
Reading earlier output pauses tail following. The **Scroll to end** button
returns to the live edge, and it is shown only while the last row is off
screen: a transcript shorter than the viewport draws none, whatever stopped it
following. Switching sessions restores their saved scroll anchors.

The find bar displays the selected matching block and total matching blocks.
`Enter` advances to the next matching block; `Escape` closes the bar.

### Markdown during arrival

Pipe tables display as aligned columns with a header rule. Inline code, emphasis
and strong emphasis display while a reply or thought is still arriving, including
an opener received before its first content character. Completed literal
punctuation remains visible. Display repair does not change the stored reply.

### Selecting text

Drag across the transcript to select the text it drew. A drag crosses
paragraphs, blocks and entries. A press with Shift held extends the selection
from where it is instead of starting a new one, and a press with no modifier
starts one wherever it lands. `Primary-A` selects the whole entry, `Primary-C`
copies the selection, and `Escape` drops it once nothing else is open over the
transcript. Selected text is drawn on the row selection ground.

A copy that crosses blocks is one line per block. A picture or a file row
states a name beside its control rather than prose, and a tool card the host
drew a view for states its text through that view, so neither carries a
selection; the turn menu's **Copy** takes the whole turn in both cases. A code
pane's lines are separate selections, one per line, and the pane's caption
heads the row that opens it rather than being part of the body. A line the pane
sets shorter than its text copies the text behind it, never the mark the line
was cut with.

Persisted thinking-level, service-tier and session changes display their
recorded values. A model change displays its recorded value from the first
prompt onward; the model a session opens on displays none, because the composer
footer states the model in hand and each agent turn ends with the model that
produced it. A session's name displays no row either, since the titlebar and the
queue row state it. Hidden custom messages, internal checkpoints, and the
runtime's own bookkeeping records — the pending-tool-call warning, the exit
diagnostic, a todo edit, an extension's stored state — do not create visible
turns. Unknown extension entries retain their original data.

An agent reply is drawn as markdown. `**strong**` and `__strong__` set the bold
weight, `*emphasis*` and `_emphasis_` the slant, `` `code` `` the monospaced
family on the inset ground, and `[text](target)` draws the text in the accent,
underlined, followed by its target in the muted ink. A heading is set at the
heading ramp, a `-`, `*` or `+` item draws a bullet, an ordered item keeps its
own number, an indented item keeps its depth, a blockquote carries a rule down
its leading edge, and a fenced block draws in a code pane with its language as
the caption.

A pipe table draws as a grid. The delimiter row under the header states what
each column is set against: `:--` the leading edge, `:-:` the centre, `--:`
the trailing edge, and a cell with no colon the leading edge. Every column
takes one share of the row's measure, so a narrow window shortens the cells
rather than pushing the last column out of the surface. The header is set in
the secondary ink at the medium weight with a hairline under it. A header with
no row under it is a header, a row with fewer cells than the header draws the
cells it has, and a header with no delimiter row under it is a paragraph,
which is what a line of prose with a pipe in it stays.

A reply still arriving is drawn as the shape it is becoming. Up to the first
byte of the block the text ends in, the reply is finished: it is drawn as it
is, and its words are what a drag selects. The block after that boundary is
the one the next delta extends, so it is closed before it is drawn — an
unterminated fence, table, list marker, heading, code span, emphasis or link
target draws as the finished shape rather than as its own markers — and it
offers nothing to select, because its shape changes with the next delta. The
boundary only moves forward, so text that settled stays where it was drawn and
does not reflow when the next delta lands.

A marker that markdown reads as text is drawn as written: an underscore inside
a name, a `*` with a space after it, an unpaired delimiter, a bracket with no
target, and anything inside a code span. A closer a stream is in the middle of
writing is finished rather than doubled: `**strong*` draws as strong. A label
with no target is the text it is, in an arriving reply as in a finished one,
since a target nobody wrote would be drawn beside it.

A tool call occupies one row while it is collapsed: the card's status line, its
block header, or the section it names, followed by how many lines it is holding
back. `Space` on the focused turn and a click on the row open the same card, and
both close it again. An open card states no held-back count on its row, since
the card below it shows every line.

Text in a tool card stays inside the card. A line wider than the card is cut at
the card's edge and ends in an ellipsis. The primary text of a row yields first;
the detail beside it — a `path:line`, a description, a diff count — keeps the
width it needs, up to half the row. A chip drawn from the tool's own text — a
badge, a language marker, a trailing count — keeps up to a quarter. Lines of
tool output are held to one row each, so a card's line count is the number of
rows it draws. A markdown section wraps instead.

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

### Prompt history

`Primary-R`, the history control in the composer footer, and `/prompts` open
the prompts submitted earlier, most recent first. The listing is the same store
the terminal reads, so a prompt typed in either front end is recalled in both.

Opening the mode with an empty query lists the most recent prompts. Typing
narrows the listing to the prompts that hold the query. Each row states the
prompt on one line and when it was submitted under it.

Selecting a row closes the mode and puts the prompt in the composer as an
unsent draft, replacing whatever the draft held. Editing before sending is the
point of the recall; the row sends nothing on its own.

A prompt is recorded when the window submits, steers, or queues typed text.
Text a command supplies is not a prompt anyone typed and is not recorded, and a
prompt submitted twice in a row is one row.

### Attachment tray

Attachments display as cards above the footer. The tray wraps within two rows
and scrolls vertically when more cards are present, up to eight attachments.
Each card displays a preview, filename, classified type and byte count. Images
use thumbnails; video uses a film glyph; UTF-8 text previews contain at most
256 characters; binary previews contain the first 16 bytes in hexadecimal.
An undecodable preview displays its error.

Filenames and captions truncate inside the card width. Hover a card to
display its remove control. Removing a card preserves the remaining attachments
and draft text.

Use `/attach`, drop files onto the composer, or paste copied files or images.
A file paste creates attachments rather than inserting filesystem paths into
the draft. Preview generation does not change the stored attachment bytes.

A card whose media the active model is not listed as taking draws
`Not accepted by <model>` in the accent where the size goes, and keeps the
attachment. A running turn takes text alone, so the tray states
`Sent with the next prompt` beside the cards until the turn ends.

### Queued prompts

A prompt sent while a turn runs waits in the session's queue, and the composer
lists what waits above the input: the steering prompts, which enter the running
turn before its next model request, then the follow-up prompts, which run after
the turn ends, each oldest first. A turn that calls a tool makes that request
as soon as the tool answers; a turn writing one long answer makes it when that
answer ends, so a steer sent mid-answer is delivered at the end of it. Each
prompt occupies one truncated line under a count of what is held.

`Alt-Up`, and the control at the strip's trailing edge, take the newest queued
prompt out of the queue and put its text back in the draft. The queue releases
prompts newest first, so there is no per-prompt removal control. The strip is
absent while the queue is empty.

## Run bar

The run bar appears directly below the composer while a turn is active. It is
28 pixels tall and spans the width of the composer.

The bar displays three elements:

1. **Status badge**: A chip indicating turn state (`Working`, `Approval`,
   `Input`, `Plan`, or `Watching`) using the role tint defined in the active theme.
2. **Detail line**: Text beside the badge describing active operations. This
   line reports the running tool, the waiting tool command, the question text,
   the first line of a pending plan, or the names of supervised processes. The
   text truncates when it exceeds available bar width.
3. **Stop action**: An abort control displayed when the turn is stoppable.
   At window widths above 560 pixels, the control displays the text label `Stop`.
   Below 560 pixels, the text label is replaced by a stop icon.

When turn control is unavailable from the host, the stop control is drawn muted
with reduced opacity, and pointer interaction is disabled. When turn control
is available, hovering the control applies a background fill, and selecting it
sends an abort request to the host. When no turn is active or stoppable, the
stop control is omitted.

## Attached decisions

A decision the agent is waiting on attaches directly above the composer, in the
composer's own width: an approval, a question, or a plan.

| Decision | Answers |
| --- | --- |
| Approval | `Deny for session`, `Deny`, `Approve for session`, `Approve` |
| Question | One control per option, and the composer's primary action sends a free-text reply |
| Plan | `Revise`, `Accept` |

An approval's four answers are the ones the tool wrapper accepts. The two
`for session` answers apply to every later call of the same tool until the
session ends; the other two apply to the call on screen.

A plan's body is capped at 400 pixels and the last 64 pixels of a body cut at
that cap fade into the card, which is what states there is more of the plan than
the card shows. A body that fits is drawn to its last line.

Every card draws text. An approval's detail is the request as the tool states
it, one line per row of a monospaced pane, including the command about to run
with whatever characters it contains. A plan arrives as markdown and is
flattened before it is drawn: the first line with text on it names the card, and
the body keeps its list indentation while heading hashes, emphasis markers,
backticks and code fences come off. A link is drawn as its text followed by its
target in parentheses.

Two decisions are shown at once. Every decision past the second folds into one
24-pixel line stating how many are waiting; the pointer over that line, or the
keyboard on it, opens it onto one line per folded decision, naming the kind and
the subject of each. It closes when the pointer leaves and the keyboard moves
on.

## Goal

`/goal <objective>` sets the session's goal from the command palette, and
`/goal pause`, `/goal resume` and `/goal drop` control the one already set.
The window drives the same goal record the terminal does, so a goal set in
either surface is the same goal, with the same objective, budget and turn
count.

While a session holds a goal, the composer footer carries a chip stating it.
Press the chip to open the goal card above the composer, in the composer's own
width, and press it again to close the card. The card states the objective, the
status, the turns completed, the time the goal has run, and the tokens used
against the budget when one is set. It carries `Pause`, `Resume` and `Drop`,
each drawn only for the statuses that accept it: no `Resume` on an active goal,
no `Pause` on a paused one. `Drop` ends the goal, so it is drawn in the error
ink on the card's ground and the accent goes to `Pause` or `Resume` beside it.
A completed goal offers `Drop` alone, with no accent on the row.

The card's edge states the status in the tint that names it.

| Status | Edge |
| --- | --- |
| `active` | `tint.working` |
| `paused`, `budget-limited` | `tint.attention` |
| `complete` | `tint.done` |
| `dropped` | `tint.input` |

A goal the host stopped driving states why on the card, in the words the host
reported: a turn that failed three times in a row, a budget spent, or another
mode holding the session. A host that serves no goals withholds the capability,
and the controls are drawn as a gate stating that instead of answering a press.

## Loop

`/loop` repeats the last prompt after each turn ends, and `/loop off` stops
it. The window drives the same loop the terminal does, over the session mode
the host records, so a loop started in either surface is the same loop with
the same prompt and the same iteration and duration limits.

While a loop runs, the composer footer carries a chip stating the mode. Press
the chip to stop the loop, which is the same as `/loop off`. The next turn is
opened through the prompt path a press takes, so a loop turn is a turn like
any other: it streams, it is stopped by the run bar, and it is recorded in the
transcript.

A loop and a goal refuse each other rather than driving one session. Setting a
goal while a loop runs is refused with the mode that holds the session, and so
is the reverse.

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

Command, model, history-search and theme lists use the same keyboard selection
rules. Unavailable rows are skipped and cannot be confirmed by pointer or
`Enter`. Theme hover previews do not replace keyboard selection or commit the
theme; dismissal restores the active appearance.

The GUI host and SDK sessions load profile models from `models.yml`, with
`models.yaml` as the fallback and migration from legacy `models.json`.
Configured models are available before the first model selection.

## Slash commands

Type `/` at the beginning of the composer to open the anchored command palette.

| Command | Action |
| --- | --- |
| `/attach` | Select attachments |
| `/history` | Search stored sessions and open a read-only preview |
| `/model` | Open the model picker |
| `/effort` | Select an available thinking level |
| `/queue-mode` | Select steer or queue mode |
| `/files` | Find a file in the workspace by name |
| `/project` | Browse the workspace one directory at a time |
| `/search` | Search the workspace for text |
| `/prompts` | Recall a prompt submitted earlier |
| `/export` | Export the active session to HTML |
| `/compact` | Compact the active session transcript |
| `/handoff` | Hand off the active session to a new agent |
| `/reload-transcript` | Reload the active session transcript |

The palette also includes session, terminal, settings, provider, and other host
commands. Attachment admission depends on the host and model input capabilities.

Every command the host runs is listed beside these, including the ones this
workspace installs: skills, extension commands, project command files and MCP
prompts. A row states where its command came from, and a command that takes
arguments states what it takes. Text typed after the command name is sent with
it. A subcommand is its own row. The host states the list on connection and
restates it when a plugin reload or a project switch changes it, so a command
file added to the workspace appears without restarting the window.

A command runs one at a time. While the host is answering one, the rows that
run another are drawn dim and take no selection, and they return when the
answer arrives.

Command search matches slash names and action descriptions. For example,
`Primary-K`, `new session`, then `Enter` creates a session.

Selecting a composer command removes its command prefix while retaining the
payload and attachments. `Escape` dismisses the slash palette without deleting
the typed slash text.

A command name matches in any capitalisation: `/Model` reaches the same row as
`/model`. A command that takes arguments prompts for them after it is chosen,
and `Escape` returns from that prompt to the full list.

`/files`, `/project`, `/search` and `/prompts` open a lookup instead of closing
the palette. The palette stays open in the mode the command named, at the
centred width, and the field prompts for what that mode looks up. The keyboard
goes to that field, so the next keystroke filters the lookup rather than
editing the draft. Typing filters files by name in `/files`, searches the
workspace for the literal text in `/search`, and narrows the prompts submitted
earlier in `/prompts`. Emptying the field drops the rows the host answered
with, since an empty query looks nothing up; `/prompts` is the exception, and
lists the most recent prompts on an empty query. In `/project`, `Enter` on a
directory row lists that directory and `Escape` returns to the one above it.

A result row states its text on one line, with its detail beside it: the file
and line number of a search hit, the path of a file, the description of a
command. Text too wide for the row truncates the primary text and keeps the
detail, which is what names where the row came from. A detail takes at most
half the row.

## Command groups

`/account` opens the Account group with Account manager and Sign in.
`/settings` opens General, Themes, Keybindings, and Diagnostics.
`/agents`, `/cockpit` and `/hub` open the agent dashboard.
`/extensions` opens the Extensions page.

The sidebar Settings gear and `/settings` use the same destination and navigation
state.

Groups and focused pages use the same Back, title, and Close header. Back or
`Escape` returns to the surface the previous descent came from and restores its
search text. A surface opened directly -- the rail footer gear, a slash
command, a keybinding -- has nothing above it: it draws no Back control, and
`Escape` closes it. Close dismisses the surface directly.
Navigation leaves the composer draft and attachments unchanged.

General settings renders viewport-adjacent rows as the list scrolls. Value updates
preserve the scroll position. The page header remains visible at the minimum
window height.

Each focused page has its own command name: `/account manager`, `/account login`,
`/hotkeys`, `/mcp`, `/extensions`, `/usage`, `/context`, `/settings themes`, and
`/settings diagnostics`.

The Themes page lists the appearances this build ships above the themes the
host reported for the agent it runs. An appearance row states the theme's name
and its polarity, with a Select control beside it and an Active badge on the
one in use. Pointing at a row draws the whole window in that appearance;
moving the pointer off the row draws the chosen one again. Select settles on
the appearance, which is written to the window's own state and restored the
next time it opens. A remembered appearance this build does not ship resolves
to the default one.

The rows under them are the host's own themes for its agent. Each row states
the ground it applies to, and selecting one configures it as the theme for that
ground: a dark theme becomes the dark-ground theme and a light one the
light-ground theme, matching the `theme.dark` and `theme.light` settings. Two
themes are configured at once, one per ground, so choosing a dark theme leaves
the light one alone. The Active badge marks the configured theme within each
ground. The two listings are independent: an appearance decides what the window
draws, and a host theme decides what the agent reports.

A Keybindings row is a field holding the chords bound to that action,
separated by commas. `Enter` rebinds the action, `Escape` restores what the
host reports. A chord is modifiers and a key joined by `-`, as in
`ctrl-enter` or `cmd-,`; a part that carries a space, or modifiers with no key
after them, states no chord. A field that states no readable chord is refused
in the attention strip and nothing is sent, so an action is never left bound
to a chord no key press matches. The refusal stays in the strip, above what
the host reports about its connection, until the field commits or is
restored. A host that reports no keybindings shows the shipped defaults as
chips, read-only.

The Extensions page runs a background task from the field above its listing:
`Enter`, or Run beside it, spawns the task as a subagent of the active
session and empties the field. The task appears in the listing when the host
answers with it.

The listing draws the dashboard's rows: each states the call sign, the agent
type it was spawned from, its status and its scope. Cancel is drawn on an agent
inside a turn, and Revive on a parked one, which is the one state a revive
brings back; an aborted agent is terminal and draws neither.

The Sign in page draws the step the host's authentication flow waits on. A
flow awaiting the browser draws Open Browser, which opens the URL the host
issued, beside Cancel. A flow awaiting a secret draws a masked field with
Submit and Cancel; Submit sends what the field holds, and an empty field is
refused in the attention strip. A failed flow draws Retry and Dismiss. A
cancelled flow draws Start Flow. A completed flow states the connected
account and draws no control.

## Agent dashboard

`/agents` opens a card over the session, listing the agents of the session in
view. `/cockpit` and `/hub` reach the same card. The list holds the agents the
host reports for that conversation and nothing from another one, and it is
replaced as the host reports it, so an agent that finished while the card is
open leaves the list on the next report.

A row states the agent's call sign, its kind, its status, the model it runs on
and the gist of what it is doing. The call sign is the short name the terminal
dashboard prints for the same agent: `Main` for the session's own agent, and
`Kestrel`, `Otter`, `Juniper` and the rest, in spawn order, for the agents it
spawns. A spawned agent also states the agent type it was spawned from, beside
its kind, so three agents of one type read as three names rather than three
copies of the type.

The status is one of six words. `running` is an agent inside a turn. `blocked`
is an agent inside a turn and stopped at an approval prompt, which is yours to
answer. `idle` is a live agent out of work. `waiting` is an agent stopped on a
peer that may never answer. `parked` is an agent whose session was disposed and
whose transcript is on disk. `aborted` is an agent that was terminated, which is
terminal.

An agent inside a turn, which is `running` or `blocked`, is drawn above the
rest; within each of those groups the order is the host's. Open beside a row
opens that agent's own session, and a row holding no session draws no Open.
Terminate is drawn on an agent inside a turn other than the session's own:
pressing it replaces the row with the question and the two answers, and the
termination is sent only from Terminate in that row. Revive is drawn on a
parked row, and brings that agent's session back from its transcript.

The card header holds two segments, `Live` and `Comms`, each stating in
parentheses how many rows it holds, so the count is read before the view is
opened. Pressing a segment draws that view in the card body.

The Comms tab lists the traffic those agents send each other, oldest first,
each line stating how long ago it landed, who sent it, who it reached, what it
said, and what it answers when it is a reply. A line that was not an ordinary
delivery carries what it was instead, and a line that failed states why. Lines
arrive while the card is open.

A session with no agent running states that, and a stream with nothing in it
states that separately.

## Tangential work

`/tan <work>` sends work to a background agent instead of to the session in
view. The session is forked at the point the command ran, so the agent starts
with the same conversation, model and tools and then follows the work it was
given; the conversation records that the work was sent and names the job it was
sent as, and the turn in progress is not steered.

The agent is a row in the dashboard above, named `tan`, and its transcript is
opened from that row. Work with nothing after the command is refused rather
than dispatched, and a session that cannot run background jobs states that.

## Debug tools

`/debug` asks which tool to run and lists the ten that read nothing of the
terminal: open the session's artifact folder, profile the CPU and bundle the
result, open the work-scheduling flamegraph of the last 30 seconds, write a
report bundle, write a heap snapshot with one, show the recent log entries,
show the system details, show the provider frames captured in this session,
start the JavaScriptCore remote inspector, and clear the artifact cache.

`/debug <tool>` runs one by name, spelled as the tool's own word: `dump`,
`memory`, `performance`, `work`, `logs`, `system`, `raw-sse`, `open-artifacts`,
`remote-debugger`, `clear-cache`. The output is drawn in the conversation under
the command, and is sent rather than recorded, so reloading the transcript
drops it.

Two tools ask before they act: the CPU profile runs until the issue has been
reproduced, and clearing the cache deletes artifacts older than 30 days. The
terminal protocol probe, the terminal's own state and the TUI transcript export
read the terminal itself, so `/debug` refuses them by name here and they stay
in the terminal's selector.

## Sharing a session

`/collab` opens a card over the session that shares it live over a relay.
`/share` reaches the same card. The window hosts a share; joining somebody
else's is `/join` in the terminal, which runs a replica of their transcript.

A share runs on the relay named by the `collab.relayUrl` setting. With no relay
configured the card names that setting and draws no control, because a control
that cannot work is not drawn.

With a relay configured and nothing shared, the card draws two controls: one
starts a share anybody on the link can prompt through, the other starts one
that is read-only. While a share is starting or stopping the card states that
and draws no control, so a start cannot be pressed twice.

While sharing, the card draws four links: the one another veyyon opens, the same
room in a browser, and both of those again read-only. A copy control sits beside
each, with a control that asks the host for the share as it stands and a control
that stops the share. An address wider than the card is shortened where it is
drawn, and the copy control hands over the whole one. A read-only share mints
only the read-only pair. Copying is the window's own clipboard and reaches the
host for nothing. Stopping ends the share for every guest on it.

Each party on the relay is a row, the session's own included, stating the name
that party joined under and whether it may prompt: a guest that arrived by the
read-only link reads as a viewer. Rows arrive and leave while the card is open.
A room nobody has joined states that instead of drawing an empty column.

A share that fails to start states why on the card and leaves the session
unshared, which leaves both start controls pressable again.

Every control on the card is drawn at the availability the host set for it: a
host that does not offer sharing leaves them unpressable, and a control whose
request is in flight is drawn as such rather than taking a second press.

## Terminal and process output

Click the terminal grid to focus it. Terminal input is sent to the host without
local echo. An overlaid drawer blocks pointer interaction with the composer
beneath it.

The grid holds the columns and rows the drawer has room for, counted off the
box the window draws it in. Widening the window, collapsing the queue rail or
closing the right panel gives the drawer more columns and the host is told the
new size; the text is broken again at that width on the same frame, before the
host answers. A window with less room than 80 columns or 11 rows keeps those,
which is what the drawer's minimum is for.

A line the terminal broke at the right margin is joined and broken again at
the new width. A line the host ended itself stays its own line at every width,
and a program on the alternate screen -- a pager, an editor -- keeps the rows
it drew and redraws them itself.

Each supervised process has a drawer tab named after it, beside the terminal
tabs. The tab displays the last 200 lines of that process's output in the same
monospace grid, and the drawer has no scrollback of its own. The tab is
read-only: terminal input reaches a terminal, not a process.

A process's row in the supervisor list carries Stop, Restart, Send and Signal.
Stop, Send and Signal are pressable while the process is running and disabled
otherwise. Send writes the line the drawer's input field holds to that
process's input, followed by a newline. Signal opens a menu of the five signals
the supervisor accepts -- Interrupt (`SIGINT`), Terminate (`SIGTERM`), Hang up
(`SIGHUP`), Quit (`SIGQUIT`) and Kill (`SIGKILL`) -- and sends the one selected
to that process. Kill is drawn as destructive, because no program can catch it.
`Escape` or a press outside the menu closes it without sending a signal.

A host that runs no terminal and supervises no process has no drawer. The
titlebar control, `Primary-J`, and `/terminal` are absent, and a drawer left
open closes when the host stops offering one.

## Right panel content

The **File** tab displays the file opened from the tree, or the exported
transcript when no file is open. An export is highlighted by its format, so
Markdown, HTML, and JSON exports read as the same format opened from the tree.
Opening a file replaces a displayed export. The **File** tab is present without
file browsing when an export is the only document.

A file and a diff draw one monospace row per line with word wrap off. Line
numbers, and a diff's change signs, stand in a pinned column; the code beside
them scrolls sideways across the width of the widest line, and the pinned
column stays where it is. A vertical gesture scrolls the file under both
columns. A sideways gesture scrolls the code alone. Each pane draws the rows
and the columns inside its own box, so a file of any length costs a frame the
size of the panel.

A diff's file header states the file's status as a badge beside its path. A
modified file has no badge; it is the ordinary case:

| Badge | Status |
| --- | --- |
| none | Modified |
| `new` | Added |
| `deleted` | Deleted |
| `renamed` | Renamed. The header states `old → new` |
| `conflict` | In an unresolved merge conflict |
| `untracked` | Present in the working tree and not in the index |

The set is exhaustive: every status the host sends draws its badge, or is the
modified case.

A tab with nothing to draw states the condition it is in and the step out of
it, and the step follows the reason: a diff nobody requested states the scope
to select, a clean working tree the edit or the staged scope to inspect, a
failed read the check to make. A read in flight states what is underway
instead, because it ends on its own. The session rail, the terminal drawer's
process list, the command palette and the review list state a step the same
way, and the rail also draws it as a button: Clear filter over a filter that
matched nothing, New Session over a rail with no session in it.

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

### Local diff reviews

Click a numbered line in a repository-backed diff to start a review thread.
The review list is available for the repository and for each file. Threads
support replies, resolution and reopening. Panel keyboard shortcuts remain
available while the review list or editor has focus.

Threads are stored locally by repository, working-tree or staged scope, file,
side and line context. A refreshed diff moves an anchor when its context still
identifies the line. Missing or ambiguous context marks the thread orphaned;
restoring similar source later does not silently reattach it. Orphaned unresolved
threads remain in the unresolved count.

Review threads survive application restarts. They do not block applying changes
or submitting prompts, and they are not posted to the repository hosting service.

## Detail popovers

Three controls draw less than the session states about them. A secondary press
on one opens an anchored popover with the rest.

| Control | What the popover states |
| --- | --- |
| A workspace tree row | The path whole, whether the row is a file or a directory, and the lines the host reported changed |
| The composer's model chip | The provider, the model identifier, whether reasoning is supported, and the inputs the catalog lists |
| A diff hunk header | The file, the lines the hunk covers on each side, the lines the hunk itself changed, and the symbol whole |

The popover is drawn beside the press. Where the direction it grows in has no
room for it, it is drawn on the opposite side of the same point, each axis
decided on its own, so the control stays visible and stays pressable. A card
too large for either side is slid inside the window margin instead.

The card arrives on the `float` role, ground and facts together. See
[Motion](motion.md).

While it is open it takes the window's focus, so a character the composer would
take into the draft does not reach the composer. `Escape` closes it, as does a
press outside it, and the focus returns to what held it. A second press on a
control the popover does not cover closes it too.

A popover states nothing about a payload the session no longer holds: a tree
row that left the last snapshot, a model the host withdrew, and a row index
that is not a hunk header each close it rather than drawing a card with no
facts under it.

## Settings

`Primary-,` opens the settings dialog, as do the command palette's `settings`
row and the gear on the rail footer. It holds eleven pages: General, Themes,
Keybindings, Providers, Authentication, MCP Servers, Extensions, Diagnostics,
Usage & Costs, Context Breakdown, and Profiles.

Every page draws one row shape: a 44px row with a 14/20 label, one 16px line of
description truncated to the row's width, and a 240px control column at the
trailing edge. The rest of a truncated description opens under the pointer or
the keyboard. A row the session cannot change is drawn at reduced opacity and
takes no press, stating the reason; a row whose request is in flight blocks a
second submission until the host answers.

The control is the setting's type:

| Type | Control |
| --- | --- |
| Boolean | Toggle |
| Number with declared bounds | Slider, with the exact value beside it |
| Number without bounds | Number input |
| Enum of two choices | Radio pair |
| Enum of three to five choices | Segmented control |
| Enum of six or more choices | Select |
| Array with declared choices | One checkbox per choice |
| Record, model chain, or free-form array | Text area |
| String naming a filesystem location | Path field with a file picker |
| Any other string | Text field |

A setting with no value and no default draws its control empty rather than
being left off the page.

A page the host reported nothing for states what is missing and the step that
fills it: an empty theme catalogue states where themes are discovered, MCP the
file a server is declared in, Usage the prompt that starts session accounting.
Keybindings is the exception. A host that reports no bindings leaves the
shipped defaults listed read-only, because those are the chords a press
matches.

### Searching the General page

The General page searches in place, and the page opens with the keyboard in
its search field, so the first character typed narrows it. A query matches a
setting's key, label, description or group, and the matches stay under their
section headers. A query nothing matches states `No settings matching
"<query>"` and `Clear or edit the search query`, with the field still drawn
above that row, so the query is edited rather than retyped from a page that
took its own field away.

The clear control at the end of the field empties the query. `Escape` empties
it as well, and a second `Escape` leaves the page, so a press over a query
widens the page before it closes it. Moving to another page returns the
keyboard to the sheet.

A setting whose `ui.condition` is unmet is absent from the page rather than
drawn inert, so an experimental feature's dependent knobs appear when its master
toggle is on and not before. When the host reports settings but every one of
them is conditioned away, the page states `No configurable settings available.`
and where the file that configures them is.

A value the host rejects is stated in one row above the page, which the list
cannot scroll out of sight, and the control that sent it is marked invalid
while it holds what was typed. A refusal whose row is out of view is announced
on the card stack.

### Profiles

The Profiles page lists the profile directories on disk and is reached from
`/profile` in the palette. Each row states the directory the profile is at and
the address of the host that serves it, or, for a profile with no addressable
endpoint, why it has none. The profile the attached host runs under carries an
`Active` badge in place of `Delete`.

A host process serves the one profile it was started under, so the page changes
the set of profiles rather than switching between them. A window reaches
another profile by attaching to that profile's host, at the address the row
states.

The first row names a new profile. `Create` makes the directory, seeded with
the items the switches under it leave on; turning every switch off makes an
empty profile. `Rename` on a row writes what that profile shows as, taking the
new name from the same field, and leaves the directory name it is stored under.
`Delete` removes a profile directory and everything in it.

## Announcements

Three things happen where the window draws nothing: a request the host
refuses whose control is under a closed sheet or a collapsed section, a
decision arriving on a session that is not the open one, and a notifier the
window could not run. Each raises a card at the window's trailing edge, under
the chrome, over every other floating surface. The stack takes no width from
the transcript, the composer or the run bar.

| What raised it | Tint | How long it stays |
| --- | --- | --- |
| A refused request | `error` | 8 seconds |
| A decision waiting out of view | `attention` | Until it is answered, the session is opened, or the card is pressed |
| A notifier that did not run | `plan` | 4 seconds |

A second announcement about the same thing is the same card: four refusals of
one control state one line, at the highest urgency any of them carried. Six
cards is the bound; past that the most urgent stay and a new routine
announcement is dropped rather than covering them. Pressing a card takes it
down and clears what raised it, so it does not return on the next frame.

Opening the session a decision is waiting on takes that session's cards down,
because the decision is now in view.

A card is 320 pixels wide and cuts what it cannot fit: three lines of the
announcement's own line, two of the detail under it, each ending in an
ellipsis. A host that quotes a rejected value back whole does not grow a card
down over the composer.

### Sound and desktop notification

The stack is silent and inside the window. Two settings state what else a
raised announcement does, both `off` by default:

| Setting | On |
| --- | --- |
| `notify.sound` | Plays the desktop alert once per batch of announcements |
| `notify.system` | Posts each announcement to the desktop's own notification service |

`notify.system` hands the announcement to the platform's notifier:
`notify-send` on Linux, `osascript` on macOS, a PowerShell balloon on
Windows, with the card's urgency mapped to the service's own. `notify.sound`
plays the session's alert sound: `canberra-gtk-play` or `paplay` on Linux,
`afplay` on macOS, the system exclamation on Windows.

Neither is required to be installed. One that cannot run is announced on the
same stack, once per carrier and per setting, stating which program failed and
why. That announcement is the one kind that is never carried anywhere itself.

## Record native interactions

Build the current executable with `cargo build -p veyyon-desktop` and build the
recorder with `proof/docker/build-recorder.sh`. The output directory must be
writable by the recorder container, including on NFS mounts.

```sh
proof/docker/record-native.sh proof/scenes/<name>.sh
```

`record-native.sh` runs the window rather than a terminal: it mounts the
executable into the container and renders through lavapipe, so a capture needs
no GPU. It takes the executable from `DESKTOP_BINARY`, or from this workspace's
cargo target directory, and states the build command when there is none.
`SCENE_WIDTH` and `SCENE_HEIGHT` default to 1180x800; `OUT_DIR` names the output
directory.

For the host's NVIDIA device instead, set `PROOF_GPU_DEVICE=nvidia.com/gpu=all`
and `VK_ICD=/etc/vulkan/icd.d/nvidia_icd.json`. The host's CDI specification must
match its current driver and device nodes.

A desktop scene drives the window through the driver socket rather than by
pixel positions. Set `VEYYON_DESKTOP_DRIVER` to a Unix socket path and the
window opens it before the first frame: a client dispatches an action by name,
types into the focused input, reads where a named target is drawn, subscribes
to frames, and waits for the window to settle. Without the variable no socket
is opened.

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
