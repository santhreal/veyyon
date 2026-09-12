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
in `crates/veyyon-desktop-surface/keymap.toml`.

| Shortcut | Action |
| --- | --- |
| `Primary-N` | Create a session |
| `Primary-B` | Toggle the queue |
| `Primary-J` | Toggle the terminal drawer |
| `Primary-\` | Toggle the right panel |
| `Primary-K` | Open the command palette |
| `Primary-,` | Open settings |
| `Primary-Shift-W` | Close the window |
| `Primary-Q` | Quit |
| `F10` | Open the menu bar |

### Menu bar

The titlebar holds five menus: `Veyyon`, `Session`, `View`, `Edit` and `Turn`.
A press on a word opens its menu under it; a press on the same word closes it.
A press anywhere outside the open menu closes it and does nothing else.
`Escape` closes it too. `F10` opens the first menu without a pointer.

While a menu is open it holds the keyboard. `Up` and `Down` walk its entries,
`Left` and `Right` move to the next menu along the bar, and `Enter` runs the
entry the walk is on. Closing the menu gives the keyboard back to what held it,
with any draft in the composer untouched. The entry the walk stands on carries
the fill every row surface selects with. A verb the host does not offer is
drawn muted, is skipped by the walk and answers no press; a verb withdrawn
while the walk stands on it is not run by `Enter` either, and the menu stays
open.

Every entry runs the same action as its chord and states that chord at its
trailing edge, including a chord rebound on the Keybindings page. Four verbs
read an argument from the chord that invokes them and appear in no menu:
focusing a session by number, moving a selection, scrolling and selecting a
decision option. Four more are what a key already means where it is pressed:
the composer's send, its newline, its half-split and the dismissal `Escape`
carries. `F10` itself is the ninth, since it has nothing to do from inside an
open bar.

### Closing the window

`Primary-Shift-W` closes the window and `Primary-Q` ends the process.
`Primary-W` closes the panel tab or parks the session, which is what it has
always done. Closing the window writes every store first: the placement, the
appearance, the queue shape and the open session. On macOS the application
stays up with no window and the dock icon opens one again, in the placement,
appearance and session the closed window left; everywhere else a process with
no window has no way in, so it ends with the window.

## Tabs and spaces

The session-tab row is below the space row. Select a tab to open its session;
drag a tab to reorder it. A session already open in the space selects its
existing tab rather than creating a duplicate.

**New space** creates a separate tab layout. Edit the space name and press
`Enter` to rename it. Switching spaces restores the selected session, queue
layout and workspace panels. Space order remains stable when selection changes.

Unsent text and attachments remain associated with their session. Closing a tab
with an unsent draft requires confirmation. **Cancel** retains the tab;
**Close tab** closes it without deleting the saved draft. Closing and reopening
the application restores the selected space, tabs and draft attachments.

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

### Attachment tray

Attachments display as cards above the footer. The tray wraps within two rows
and scrolls vertically when more cards are present, up to eight attachments.
Each card displays a preview, filename, classified type and byte count. Images
use thumbnails; video uses a film glyph; UTF-8 text previews contain at most
256 characters; binary previews contain the first 16 bytes in hexadecimal.
An undecodable preview displays its error.

Filenames and captions truncate inside the card width from
`crates/veyyon-desktop-tokens/tokens/surface/composer.toml`. Hover a card to
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
| `/steer` | Steer the running turn with the command payload |
| `/queue` | Queue the command payload |
| `/files` | Find a file in the workspace by name |
| `/project` | Browse the workspace one directory at a time |
| `/search` | Search the workspace for text |
| `/export` | Export the active session to HTML |
| `/compact` | Compact the active session transcript |
| `/handoff` | Hand off the active session to a new agent |
| `/reload-transcript` | Reload the active session transcript |

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
`Escape` returns to the surface the previous descent came from and restores its
search text. A surface opened directly -- the rail footer gear, a slash
command, a keybinding -- has nothing above it: it draws no Back control, and
`Escape` closes it. Close dismisses the surface directly.
Navigation leaves the composer draft and attachments unchanged.

General settings renders viewport-adjacent rows as the list scrolls. Value updates
preserve the scroll position. The page header remains visible at the minimum
window height.

Each focused page has its own command name: `/account manager`, `/account login`,
`/hotkeys`, `/mcp`, `/agents`, `/usage`, `/context`, `/settings themes`, and
`/settings diagnostics`.

The Themes page lists the appearances this build ships above the themes the
host reported for the agent it runs. An appearance row states the theme's name
and its polarity, with a Select control beside it and an Active badge on the
one in use. Pointing at a row draws the whole window in that appearance;
moving the pointer off the row draws the chosen one again. Select settles on
the appearance, which is written to the window's own state and restored the
next time it opens. A remembered appearance this build does not ship resolves
to the default one.

The rows under them are the host's own themes for its agent, and selecting one
sends the choice to the host. The two listings are independent: an appearance
decides what the window draws, and a host theme decides what the agent
reports.

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

The Agents page runs a background task from the field above its listing:
`Enter`, or Run beside it, spawns the task as a subagent of the active
session and empties the field. The task appears in the listing when the host
answers with it.

The Sign in page draws the step the host's authentication flow waits on. A
flow awaiting the browser draws Open Browser, which opens the URL the host
issued, beside Cancel. A flow awaiting a secret draws a masked field with
Submit and Cancel; Submit sends what the field holds, and an empty field is
refused in the attention strip. A failed flow draws Retry and Dismiss. A
cancelled flow draws Start Flow. A completed flow states the connected
account and draws no control.

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
proof/docker/record-native.sh proof/scenes/desktop-composer.sh
```

The session-workflow scene submits a real prompt, pastes a file, reorders tabs,
opens history, switches spaces and restores the draft after application restart.
It requires a reachable model endpoint. The diff-review scene creates and
replies to a thread, resolves and reopens it, restarts the application, and
refreshes changed source to check relocated and orphaned anchors.

```sh
PROOF_LLM_BASE_URL=<provider-url> \
  proof/docker/record-native.sh proof/scenes/desktop-session-workflows.sh
proof/docker/record-native.sh proof/scenes/desktop-diff-review.sh
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

Every desktop scene reads this preamble's frames back before it records its own,
and ends the take naming the guard that failed: the draft reaching the composer,
each overlay drawing over the transcript, each dismissal returning the transcript
to the frame it opened over, and the draft surviving both. The reading is printed
as `scene: draft <n>px, kept <n>px, moved <n>px, picker <n>/1000 open ...`.

The preamble also owns where a prompt is typed. `submit_prompt` clicks the
editor line the preamble derived from the token files, clears the draft, types
the text, reads the composer band back, and presses `Return` only when the ink
is there; `type_prompt` stops before the `Return` for a scene that photographs
the typed draft. A scene that restates the aim as a number clicks whatever that
number reaches at the current layout, and a click outside the card focuses the
transcript, so the keystrokes reach no draft and the take reports a turn the
model never ran.

Use `proof/scenes/desktop-navigation.sh` with the same capture environment to
exercise a completed host response, transcript paging, find, contextual panel
transitions, and session creation through command search. It reads back the model
row entered, the card grown by an eighty-line draft, Home, a page, a find and its
next match, the panel's two states, the command palette and the session its row
made. Set `PROOF_LLM_BASE_URL` to an endpoint reachable from the recorder
container.

Use `proof/scenes/desktop-surface-navigation.sh` with the same capture environment
to exercise command groups, focused Account and Settings pages, settings scrolling,
parent navigation, draft-focus restoration, and queue action visibility.

Use `proof/scenes/desktop-terminal.sh` to open the terminal drawer, focus its grid,
and execute a shell command. It reads back the drawer drawn over the session and
the command answered inside it, so a withheld `Capability::Terminals` ends the
take rather than publishing the session under both frame names. Set `SCENE_WIDTH`
to `800` and `1180` for overlaid and docked drawers.

Use `proof/scenes/desktop-terminal-width.sh` to print a ninety-six-column rule
into the drawer's terminal and read how far across the drawer it reaches. The
strip it measures starts past the eightieth column, where nothing but terminal
text draws, so a grid left at the old eighty-column constant leaves it as blank
as the frame taken before the command. Record both arms at each width the drawer
reaches, since the width is what the grid is counted from:

```sh
for px in 800 1180; do
	SCENE_WIDTH=${px} SCENE_MOTION_FLOOR=5 \
		proof/docker/record-native.sh proof/scenes/desktop-terminal-width.sh
done
```

Use `proof/scenes/desktop-tool-view.sh` to record a real tool call and disclose its
card twice, once with `space` on the focused turn and once by clicking the card's
row. The two open frames show the same card, which is what a host-held disclosure
means. The collapsed frame is taken after the keyboard reaches the turn, so the
three frames differ in the disclosure alone. The card's row is found by clicking
down the transcript column until a click draws the frame the keyboard produced; a
click that opens the right panel is undone with `Primary-\` before the next row.
The take runs a minute and a half, most of it a tool turn whose transcript stands
still, and the frames it publishes are stills, so pass `SCENE_MOTION_FLOOR=5`:

```sh
SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh proof/scenes/desktop-tool-view.sh
```

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
submitted behind the running turn, `/Steer <message>` typed as a command, the
strip listing the steer the host holds, and a turn stopped by `primary-.`. It
waits on the host's own session state rather than on a pause, so an idle
composer fails the take instead of being photographed as a running turn. The
steer and queue frames are one differential: the primary action is the whole
difference between them. The steering message is read twice, in the strip as
soon as the host reports holding it and in the transcript once the turn it
joined has ended, and the abort runs against a turn of its own, since a chord
pressed at a settled session photographs a finished turn under the name of an
aborted one. Record its other arm with `PROOF_BASE_REF=HEAD`, since the change
is inside the executable alone.

Use `proof/scenes/desktop-settings-row.sh` to photograph the General page at
rest and with the pointer on a row's description. It counts the control bands
in the page body, the distance between the first two, and the pixels a hovered
row changes under itself. Record its other arm with the base ref that precedes
the change, and name a copy of the token files as they stood in
`PROOF_TOKENS_DIR`: the source hold covers `packages/` and its siblings, never
`crates/`, so a pre-change executable handed a token file with a key it does
not know fails to load.

Use `proof/scenes/desktop-content-search.sh` to open Content Search from the
palette, type a word this workspace contains, and empty the query again. The
three frames are the mode with nothing to show, the host's answer to that word,
and the rows gone with the query. A lookup take is still between keystrokes, so
pass `SCENE_MOTION_FLOOR=9`:

```sh
SCENE_MOTION_FLOOR=9 proof/docker/record-native.sh proof/scenes/desktop-content-search.sh
```

Use `proof/scenes/desktop-turn-footer.sh` to run a real turn and reveal the
model's name on it twice, once with the turn cursor on the last turn and once
with the pointer over the name, then click the name and photograph the panel
that opens. The name's own box is the bounding box of the keyboard reveal, so
the pointer reaches it without a row height being assumed. Record its other arm
with `PROOF_BASE_REF=HEAD`, since the change is inside the executable alone.

Use `proof/scenes/desktop-settings-keybinding.sh` to rebind an action on the
Keybindings page and then type a chord that states no key. It counts the ink in
the row's control column at rest, with the chords typed, and after the commit
has been read back from the host, then measures the strip band for the refusal.
Record the other arm with a build of this tree that holds the field back, since
the change is inside the executable alone:

```sh
SCENE_MOTION_FLOOR=6 proof/docker/record-native.sh \
  proof/scenes/desktop-settings-keybinding.sh
SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=6 \
  PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
  proof/docker/record-native.sh proof/scenes/desktop-settings-keybinding.sh
```

Use `proof/scenes/desktop-unsent-rail.sh` to leave an unsubmitted draft in an
inactive session and measure the rail's inked bounding box when the draft is in
the active session and after switching to another session. Record the other arm
with a build of this tree that holds the derived section back, since the change
is inside the executable alone:

```sh
SCENE_MOTION_FLOOR=6 proof/docker/record-native.sh \
  proof/scenes/desktop-unsent-rail.sh
SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=6 \
  PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
  proof/docker/record-native.sh proof/scenes/desktop-unsent-rail.sh
```

Use `proof/scenes/desktop-decision-card.sh` to run a real tool call, answer the
approval it raises by clicking the accent answer, and open the row the third of
three concurrent decisions folds into. The differential is the approval mode,
which is a setting, so both arms are seeded before the session starts and each
writes its own directory:

```sh
OUT_DIR="${PWD}/proof/captures/x11/off" SCENE_MOTION_FLOOR=5 \
  proof/docker/record-native.sh proof/scenes/desktop-decision-card.sh
OUT_DIR="${PWD}/proof/captures/x11/on" SCENE_MOTION_FLOOR=5 \
  SCENE_SETTINGS='tools.approvalMode: ask' \
  proof/docker/record-native.sh proof/scenes/desktop-decision-card.sh
```

The off arm records the two frames a mode that stops for nothing can reach: the
read runs unasked and no card is drawn. The folded frames exist only in the on
arm.

Use `proof/scenes/desktop-mono-pane.sh` to open a file whose lines are wider
than the right panel and reach the far end of one, measuring the pane's pinned
gutter and its scrolling code column separately. Record the other arm with a
build of this tree that holds the pane back, since the change is inside the
executable alone:

```sh
SCENE_MOTION_FLOOR=6 proof/docker/record-native.sh \
  proof/scenes/desktop-mono-pane.sh
SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=6 \
  PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
  proof/docker/record-native.sh proof/scenes/desktop-mono-pane.sh
```

Use `proof/scenes/desktop-split-grip.sh` to open the terminal drawer into its
split and point at the hairline above it. It reads the split's own row out of
the frame, counts the lines in the grip band, measures the middle of the tab
row, and compares the band under the pointer with the band at rest. A pointer
move and a one-pixel tint are most of what the take contains, so it declares a
still take's motion floor. Record the other arm with a build of this tree that
holds the one edge, the tint and the dash's removal back, since the change is
inside the executable alone:

```sh
SCENE_MOTION_FLOOR=6 proof/docker/record-native.sh \
  proof/scenes/desktop-split-grip.sh
SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=6 \
  PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
  proof/docker/record-native.sh proof/scenes/desktop-split-grip.sh
```

Use `proof/scenes/desktop-export-header.sh` to export a session the window is
not on, from that row's own context menu, and read where the rail's selection
lands. It reads the selected card and the menu's rows out of the frame it
opened in, and reads the Export row's ink against the menu's first row: a row
the gate refused is drawn at a fraction of its strength, swallows the click,
and both arms then show the export never running, so the take waits for the
host and abandons rather than clicking it. The change is inside the host, so
the other arm reuses this build with the host's source held at the commit
before it and names no second binary:

```sh
SCENE_MOTION_FLOOR=6 proof/docker/record-native.sh \
  proof/scenes/desktop-export-header.sh
SCENE_ARM=before PROOF_BASE_REF=da49c36a25^ SCENE_MOTION_FLOOR=6 \
  proof/docker/record-native.sh proof/scenes/desktop-export-header.sh
```

Use `proof/scenes/desktop-session-transcript.sh` to run one turn in each of two
sessions and switch between them. It runs a one-line prose reply in the session
the prelude created and a twelve-line reply of digits in a session created with
`ctrl+n`, then clicks the card of each by its own top rather than walking from
the selected one, since the rail also lists the seeded session. Each click
asserts the selection lands on the card that was clicked, each photographed
frame asserts the transcript column inks as tall as a settled turn, and the
host is asked on a second connection, after every frame, whether each session
holds its own prompt and not the other's. Three frames come out of one arm:
two states of one surface, and the first state reached again. Fifty of the
take's seconds are spent waiting on two turns of a 1.5B model, so it declares a
still take's motion floor:

```sh
SCENE_MOTION_FLOOR=6 proof/docker/record-native.sh \
  proof/scenes/desktop-session-transcript.sh
```

Use `proof/scenes/desktop-transcript-prose.sh` to open a session whose reply
carries inline markdown and photograph the transcript setting it. The reply is
a committed fixture in `proof/docker/seed-sessions/`, written into the session
store for this scene alone, so both arms of the pair draw the same paragraph
instead of two replies a model wrote; the scene reaches it through the rail's
own search, pressed on the control rather than the `/` chord. It reads the
palette's overlay, the typed filter and the ink the reply brings to a column
that was empty, then asks the host on a second connection whether the reply
still holds the raw markers the fixture wrote. The change is inside the
executable, so the before arm names a build of this tree without the inline
reader:

```sh
SCENE_MOTION_FLOOR=6 proof/docker/record-native.sh \
  proof/scenes/desktop-transcript-prose.sh
SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=6 \
  PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
  proof/docker/record-native.sh proof/scenes/desktop-transcript-prose.sh
```

Use `proof/scenes/desktop-streamed-shape.sh` to open a persisted pipe table through
native session search and inspect its rendered grid. The scene checks the header
rule and the original Markdown returned by the host.

Use `proof/scenes/streamed-shape-diagnostic.sh` with a reachable model endpoint to
record a live numbered reply. The scene requires transcript changes while the
session reports Working and checks the persisted numbered bold items.

```sh
proof/docker/record-native.sh proof/scenes/desktop-streamed-shape.sh
PROOF_LLM_BASE_URL=<provider-url> \
  proof/docker/record-native.sh proof/scenes/streamed-shape-diagnostic.sh
SCENE_ARM=before PROOF_BASE_REF=HEAD \
  PROOF_NATIVE_BEFORE_BINARY=<matched-before-binary> \
  proof/docker/record-native.sh proof/scenes/desktop-streamed-shape.sh
```

For a native Before arm, supply a separate executable with the same navigation,
tokens and protocol. `PROOF_BASE_REF` alone does not replace the native executable.
Inspect live recordings in motion; a completed reply does not show arrival.

Use `proof/scenes/desktop-attachment.sh` to paste an image into the composer,
send the prompt that carries it, and read back what the host received. The
clipboard is loaded through `xclip` with a generated plasma PNG, since the file
chooser on Linux is the XDG portal and no container runs one; the paste ends in
the same `attach` as the chooser and a drag. It asserts the clipboard offered
`image/png` before the chord, that the tray inked a card where the empty
composer drew nothing, that the editor line came back to where it was once the
prompt was away, and then asks the host on a second connection whether the
session holds an image block of exactly the bytes that were pasted. A fourth
frame selects a model from the picker and pastes again, which is the state a
card states `Not accepted by <model>` in: every model seeded for these takes is
a local text model, so the refusal is the caption, and nothing is sent from
that state:

```sh
proof/docker/record-native.sh proof/scenes/desktop-attachment.sh
SCENE_ARM=before PROOF_BASE_REF=HEAD \
  PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
  proof/docker/record-native.sh proof/scenes/desktop-attachment.sh
```

Use `proof/scenes/desktop-appearance.sh` to open the Themes page, rest the
pointer on the appearance the window is not drawn in, and press its Select. It
reads the mean grey of the page's own ground and of the session rail beside the
sheet, so a preview that reached the row alone and a selection that reverted
when the pointer left are separate failures. The two arms of the pair are the
two appearances: the before arm's page lists none, so both readings stay dark
through the same three frames. The change is inside the executable, so the
before arm names a build of this tree without the appearance library:

```sh
SCENE_MOTION_FLOOR=6 proof/docker/record-native.sh \
  proof/scenes/desktop-appearance.sh
SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=6 \
  PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
  proof/docker/record-native.sh proof/scenes/desktop-appearance.sh
```

Use `proof/scenes/desktop-detail.sh` to press the composer's model chip with the
secondary button and then dismiss what it opened. It reads one rectangle, the
band the popover is drawn in above the press, twice per frame: how many pixels
of it carry the ground the theme authors for a floating surface, and how many of
it changed against the frame before. A popover that never appeared, one drawn
below the chip or slid against the window's foot, and one that outlived its
dismissal are separate failures. The before arm's chip answers no secondary
press, so the band holds no floating ground and moves by nothing through the
same three frames. The change is inside the executable, so the before arm names
a build of this tree without the popover:

```sh
proof/docker/record-native.sh proof/scenes/desktop-detail.sh
SCENE_ARM=before PROOF_BASE_REF=HEAD \
  PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
  proof/docker/record-native.sh proof/scenes/desktop-detail.sh
```

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
