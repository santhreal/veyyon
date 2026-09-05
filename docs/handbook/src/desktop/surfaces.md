# Surfaces and interactions

## Shell

The queue lists sessions beside the active transcript. User messages, assistant
responses, tool activity, and pending decisions appear in the transcript. The
composer floats above its lower edge. The right panel displays workspace content;
the terminal drawer displays terminal output below the session.

The queue collapses when the window cannot fit it beside the transcript. At the
minimum window width, the composer remains available across the transcript.

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
the composer. Search filters the host model catalog. Use the arrow keys to select
a row and `Enter` to confirm. Selection remains subject to host availability.

`Escape` or a click outside closes the picker and returns focus to the composer.
Opening, filtering, and dismissing it leaves the draft unchanged.

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

Selecting a composer command removes its command prefix while retaining the
payload and attachments. `Escape` dismisses the slash palette without deleting
the typed slash text.

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

Output is written to `proof/captures/x11/`, or the absolute directory in `OUT_DIR`.
The [capture requirements](../foundations/verification.md) specify paired static
frames and animated clips. Headless scene PNGs do not replace native captures.

See [Motion](motion.md) for transition behavior.
