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
Wrapped descriptions expand their rows; adjacent labels and controls do not
overlap. Focused pages scroll their content without displacing their navigation
header.

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

Cards display the session title, workspace, status, and relevant timing.
Secondary actions remain hidden at rest and do not shift the title when revealed.
Selection, hover, and status have distinct treatments. Compact rows retain
readable text and usable pointer targets.

The footer contains one Settings gear. It opens the same group as `/settings`.
Settings is the only slash-command destination with a permanent sidebar shortcut.
Account, Agents, Models, and other command destinations remain in command
navigation rather than becoming sidebar buttons.

Card rows show Park and Defer while the pointer is over the row. Parked lines
provide Unpark; deferred lines provide Recall.

Right-click a card for Open, Park, Defer, Branch, and Delete. Branch starts a new
session before the latest user message on the selected session's active branch,
without changing the source session. Extensions can cancel the operation.
Unavailable and pending management actions are disabled in the menu.

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
Reading earlier output pauses tail following; the **Scroll to end** button
returns to the live edge. Switching sessions restores their saved scroll anchors.

The find bar displays the selected matching block and total matching blocks.
`Enter` advances to the next matching block; `Escape` closes the bar.

Persisted model, thinking-level, service-tier, and session changes display their
recorded values. Hidden custom messages and internal checkpoints do not create
visible turns. Unknown extension entries retain their original data.

Developer and custom records display labeled annotations below the assistant
reading size. File, model, thinking, and lifecycle events use the same annotation
style. Branch and compaction summaries have distinct labels and a separating
line. Execution output includes its shell or Python label. Transcript search
matches annotation labels and recorded content.

## Composer

The footer contains the model selector and an up-arrow primary action. A separate
stop control appears while a turn runs. Secondary composer actions are available
through slash commands rather than a permanent row of buttons.

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

### Submitted drafts

Send, steer, and queue requests retain editor content until the matching host
acknowledgment. A successful acknowledgment clears text only when the active
session and current text still match the submitted snapshot. Different current
text remains in the editor. Failed requests do not consume the draft.

Successful submission removes attachments included in that request. Attachments
added afterward remain unless they compare equal to a submitted attachment.
Unrelated and duplicate acknowledgments do not consume content.

## Model picker

Click the model selector or press `Primary-Shift-M` to open the model picker above
the composer. Search matches display names and `provider/model` identifiers in
the host catalog. Use the arrow keys to select a row and `Enter` to confirm.
Selection remains subject to host availability.

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

The palette also includes session, terminal, settings, provider, and other host
commands. Attachment admission depends on the host and model input capabilities.

Command search matches slash names and action descriptions. For example,
`Primary-K`, `new session`, then `Enter` creates a session.

Selecting a composer command removes its command prefix while retaining the
payload and attachments. `Escape` dismisses the slash palette without deleting
the typed slash text.

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

Command search also accepts `/providers`, `/login`, and `/extensions` for the
corresponding focused destinations.

## Record native interactions

Build the current executable with `cargo build -p veyyon-desktop` and build the
recorder with `proof/docker/build-recorder.sh`. Set `DESKTOP_BINARY` to the absolute
path of that executable. The output directory must be writable by the recorder
container, including on NFS mounts.

```sh
PROOF_HOST_REPO_SOURCE="$DESKTOP_BINARY" \
PROOF_HOST_REPO_TARGET=/desktop-bin/veyyon-desktop \
SCENE_TERMINAL=native \
SCENE_RUNTIME_DIR=/out/runtime \
SCENE_WIDTH=1180 SCENE_HEIGHT=800 \
SCENE_COMMAND='env VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.json VEYYON_BIN=/repo/packages/coding-agent/src/cli.ts VEYYON_DESKTOP_TOKENS_DIR=/repo/crates/veyyon-desktop-tokens/tokens VEYYON_DESKTOP_THEMES_DIR=/repo/crates/veyyon-desktop-tokens/themes /desktop-bin/veyyon-desktop' \
proof/docker/record-x11.sh proof/scenes/desktop-composer.sh
```

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
to exercise command groups, focused Account and Settings pages, parent navigation,
and queue action visibility.

Output is written to `proof/captures/x11/`, or the absolute directory in `OUT_DIR`.
The [capture requirements](../foundations/verification.md) specify paired static
frames and animated clips. Headless scene PNGs do not replace native captures.

See [Motion](motion.md) for transition behavior.
