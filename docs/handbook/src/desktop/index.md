# Native desktop

Veyyon has two front ends. The terminal host draws inside a terminal emulator
through differential ANSI writes. The native desktop is a GPUI application in
`crates/veyyon-desktop`; it renders on the GPU through wgpu and Vulkan, and
attaches to a GUI host (`veyyon gui`) over a Unix domain socket or a TCP
loopback socket.

The desktop runs no agent of its own. Sessions, models, tools, approvals and
settings are the host's, reached over that socket, so the sessions it lists are
the sessions the terminal host lists. It draws the sidebar, transcript, composer,
workspace panels and terminal output at once.

The published installer does not install the desktop executable. It is built
from source.

## Start the desktop

To run the desktop front end from a configured checkout with Bun on `PATH`:

```sh
VEYYON_BIN="$PWD/packages/coding-agent/src/cli.ts" cargo run -p veyyon-desktop
```

`VEYYON_BIN` selects the executable used to start `veyyon gui`. Without this
environment variable, the desktop searches `PATH` for `veyyon`.

The initial and minimum window dimensions are 800 × 560 pixels.

Text is set in Inter, and monospace text (the terminal drawer, diffs, code
blocks, and file paths) in JetBrains Mono. Both families are embedded in the
executable, so no system font is required.

## Attach to a host

To attach to a running host at a specific endpoint:

```sh
cargo run -p veyyon-desktop -- --endpoint tcp:127.0.0.1:17654
```

Endpoint resolution checks `--endpoint`, then `VEYYON_GUI_ENDPOINT`, then
`<agent-dir>/gui-host.sock`. Use `unix:<path>` for a Unix domain socket or
`tcp:<host>:<port>` for TCP. An empty TCP host selects `127.0.0.1`. An endpoint
without a recognized scheme selects the default socket; it is not a relative
socket path.

The default agent directory is `~/.veyyon/profiles/<profile>/agent`, where
`VEYYON_PROFILE` selects the profile and `default` is used otherwise. Without an
explicit endpoint, the desktop attaches to the default socket if it accepts
connections. If the socket is absent, the desktop starts `veyyon gui` in the
current working directory and waits up to five seconds for its listening banner.
An explicit endpoint disables automatic host startup.

Unix socket paths are limited by `sockaddr_un.sun_path`: 107 bytes on Linux, 103
bytes on macOS. When `<agent-dir>/gui-host.sock` exceeds this limit, both the
desktop and the host use `<runtime-dir>/veyyon-gui-<digest>.sock`, where
`<digest>` is the first 16 hexadecimal characters of the SHA-256 digest of the
agent directory, and `<runtime-dir>` is `$XDG_RUNTIME_DIR`, `/run/user/<uid>` on
Linux, or `$TMPDIR` on macOS. Without an available runtime directory, and for an
explicit `unix:` endpoint over the limit, startup fails with the path, its size
and the limit.

## Surfaces

The application window divides into these regions:

- **Sidebar**: Pinned, unsent, deferred and archived blocks, then projects and
  their threads, with branches folded under the thread they came from. The
  sidebar holds thread search, a row menu, inline rename, and a footer with
  settings, the profile switcher and the connection state. `Primary-B` shows or
  hides it.
- **Transcript**: The central reading area. Displays conversation turns, user
  messages, streaming assistant markdown, tool calls and unified diffs.
- **Composer**: The input card at the lower edge of the transcript. Accepts
  multi-line prompt text, slash commands, file attachments and dictation, and
  states the model and thinking level.
- **Dock**: The strip above the composer that holds the decision the session
  waits on, the goal it runs and the autoswarm console. One decision shows at a
  time, the oldest first; `1` to `9` pick its options, `Enter` its default, and
  `Escape` folds it.
- **Right panel**: Six tabs over the session's changes, files, agents, plan,
  diagnostics and usage. `Primary-Shift-D` shows or hides it.
- **Terminal drawer**: Tabs over the host's terminals, the processes its
  supervisor runs, and each process's output. `Primary-J` shows or hides it.
- **Command palette**: Every action the window offers, ranked against the typed
  query. `Primary-K` opens it.

## Host capabilities

The protocol defines thirty capabilities covering sessions, turn control,
tools, approvals, files, changes, terminals, process supervision, models,
providers, authentication, MCP, settings, themes, and diagnostics.

When the desktop connects to a host, each capability resolves to a three-state
`CapabilityStatus`:

- `UnknownUntilAttached`: Transport connection is not yet complete, or the host
  has not yet responded for that capability. Associated controls are drawn at
  rest with standard visual styling. Activating the control initiates host
  attachment, followed by action execution once attached.
- `Available`: The host provides the capability. Associated controls are
  enabled and interactive.
- `Unavailable { reason }`: The host explicitly does not offer the capability.
  Associated controls are drawn muted with reduced opacity, and pointer
  interaction is disabled. The reason reported by the host is displayed directly
  at the control. No retry affordance is provided. When an entire surface
  depends on an unavailable capability, that surface is omitted from the layout.

When an action request is in flight, the control enters a pending state that
blocks duplicate submissions until the host answers.

## Keyboard shortcuts

`Primary` represents `Cmd` on macOS and `Ctrl` on Linux and Windows. Default
bindings are in `crates/veyyon-desktop-app/src/keymap.rs`.

### Global shortcuts

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
| `` Ctrl-Shift-` `` | Open a terminal in the drawer |
| `Primary-Q` | Quit |

### Sidebar shortcuts

These apply while the sidebar holds focus and no row menu is open.

| Shortcut | Action |
| --- | --- |
| `Up` / `Down` | Select the thread above or below |
| `Enter` | Open the selected thread |
| `F2` | Rename the selected thread |
| `Delete` | Delete the selected thread, after confirmation |
| `Escape` | Close the rename field or the delete confirmation |
| `P` | Pin or unpin the selected thread |
| `D` | Defer or recall the selected thread |
| `K` | Archive or restore the selected thread |
| `Left` / `Right` | Hide or show the branches under the selected thread |

### Composer shortcuts

| Shortcut | Action |
| --- | --- |
| `Tab` | Accept the highlighted completion |
| `Shift-Tab` | Move to the next thinking level |
| `Alt-Q` | Switch a prompt sent during a turn between steering and queueing |

### Panel and drawer shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl-PageDown` / `Ctrl-PageUp` | Show the next or previous tab |
| `Ctrl-Shift-C`, `Cmd-C` in a terminal | Copy the terminal's selected text |
| `Ctrl-Shift-V`, `Cmd-V` in a terminal | Paste the clipboard into the terminal |

A focused terminal keeps `Ctrl-B`, `Ctrl-F`, `Ctrl-K`, `Ctrl-N` and `Ctrl-Q` for
the shell it runs.

## Connection states

The transport displays five lifecycle states:

- **Detached**: The endpoint is disconnected. Displays an **Attach** button.
- **Connecting**: Attachment attempt is in progress, reporting the attempt count.
- **Syncing**: Receiving initial state snapshots, reporting item counts and
  progress.
- **Reconnecting**: Transport interrupted after initial sync. Displays the
  attempt count, backoff countdown, error reason, and a **Retry Now** button.
- **Fatal**: Transport encountered an unrecoverable failure. Displays the error
  and a **Re-attach** button.

Before a session loads, transport status is a dialog in place of the queue,
transcript and panels. After a session loads, a transport failure keeps the
queue and the transcript on screen and adds a banner under the titlebar.
Neither state repeats itself in the window's status line, and neither offers a
second copy of its button in the banner.

A control is offered only while the transport can carry what it would send.
Detached, Connecting, Syncing and Fatal disable every control except the one
that ends the state, each stating the transport as the reason. Reconnecting
disables the controls that change state — sending a prompt, answering a
question, accepting a plan, deleting a session — and leaves navigation over what
the client already holds enabled.

## Persisted state

Window state is stored under `<agent-dir>/desktop/`:

| File | Contents |
| --- | --- |
| `window.json` | Position, dimensions, maximized state, and display |
| `shell.json` | Appearance, the open sessions and the selected one, and each panel layout |
| `queue.json` | Collapsed queue sections and parked-section pagination |
| `panels.json` | Per-session panel and drawer visibility, dimensions, selected tabs, and diff mode |
| `transcript.json` | Per-session disclosure state and reading position |
| `composer.json` | Per-session draft text, attachments, and queue mode |
| `reviews.json` | Local review threads, line anchors, and resolution state, partitioned by repository and file |

A reading position is the transcript entry the top turn was opened by, not a
turn index, so it survives the session paging in earlier turns. A transcript
left at the live edge stores no position and opens at the live edge. A position
naming a turn the host has not sent yet is held and applied on the frame that
turn is drawn.

`VEYYON_DESKTOP_STATE_DIR` selects another directory. With no home directory to
build a profile path under, nothing is stored and nothing is written.

A change reaches the disk 400 milliseconds after the first change of its
window, and everything waiting is written on quit. Each document is written to a
sibling `.json.writing` file and renamed over the previous one. `composer.json`
and `reviews.json` are fsynced before that rename; the other documents are not.

A document from a version this build does not write, a truncated document, and
a document holding a key this build does not write are all replaced by the
default and reported on stderr at warn level, stating the file, the session for
a per-session document, what was wrong, and the version this build writes.
Nothing is migrated. One session's rejected entry leaves every other session's
in place.

A measure the pointer never dragged is absent rather than stored, so the panel
and the drawer follow the breakpoint ladder at the width the window opens at. A
stored window whose display this machine no longer has opens centred on a
display it does have, at the size it had. A stored size below 800 × 560 opens at
800 × 560. A stored session the host no longer lists is dropped rather than
reopened, and the session is asked for once, so a session closed afterwards
stays closed.

`panels.json` does not hold which tabs the panels offer: the tabs are the
host's and arrive with it.

## Web inspection

Browser automation runs through the runtime `browser` tool in an external
browser process. The desktop window does not embed web renderers or HTML
inspection tools. File inspection actions open local workspace files.

## Headless rendering

`crates/veyyon-desktop-scene` renders the window offscreen to PNG for tests. The
shipped executable does not link it.

## Reference

- [Surfaces and interactions](surfaces.md)
- [Motion](motion.md)
- [Source installation](../using/install.md)
