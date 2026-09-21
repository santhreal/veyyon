# Native desktop

Veyyon has two front ends. The terminal host draws inside a terminal emulator
through differential ANSI writes. The native desktop is a GPUI application in
`crates/veyyon-desktop`; it renders on the GPU through wgpu and Vulkan, and
attaches to a GUI host (`veyyon gui`) over a Unix domain socket or a TCP
loopback socket.

The desktop runs no agent of its own. Sessions, models, tools, approvals and
settings are the host's, reached over that socket, so the sessions it lists are
the sessions the terminal host lists. It draws the queue, transcript, composer,
run bar, workspace panels and terminal output at once.

The published installer does not install the desktop executable. It is built
from source.

## Start the desktop

To run the desktop front end from a configured checkout with Bun on `PATH`:

```sh
VEYYON_BIN="$PWD/packages/coding-agent/src/cli.ts" cargo run -p veyyon-desktop
```

`VEYYON_BIN` selects the executable used to start `veyyon gui`. Without this
environment variable, the desktop searches `PATH` for `veyyon`.

The initial and minimum window dimensions are 800 × 560 pixels, configured in
`crates/veyyon-desktop-tokens/tokens/surface/shell.toml`. Startup validates the
token configuration files and bundled themes. Changes to token files reload
while the application runs.

Monospace text (the terminal drawer, diffs, code blocks, and file paths) is set
in the first font family installed on the system from the ordered list under
`[type.family]` in `crates/veyyon-desktop-tokens/tokens/scale.toml`:
JetBrains Mono, DejaVu Sans Mono, Liberation Mono, Menlo, SF Mono, Consolas,
Courier New. Every other run is set from the `ui` list in the same table:
Inter, Segoe UI, SF Pro Text, Helvetica Neue, Cantarell, Noto Sans,
DejaVu Sans, Arial. Both lists are matched against the system font database.
If none of a list's families is installed, startup fails and prints the list.
Install one of the families, or append an installed family to the list.

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

The application window divides into six interactive surfaces:

- **Queue**: A sidebar listing sessions organized into five collapsible
  sections: Unsent, Pinned, Live, Deferred, and Parked. The header provides
  session search and session creation. At window widths of 980 pixels and above,
  the queue docks as a column beside the transcript. Below 980 pixels, the queue
  floats as an overlay and opens through `Primary-B`.
- **Session transcript**: The central reading area. Displays conversation turns,
  user messages, streaming assistant markdown, tool call execution blocks,
  unified diffs, and decisions awaiting response.
- **Composer**: A floating input card docked above the lower edge of the
  transcript. Accepts multi-line prompt text, slash commands, file attachments,
  and queued inputs.
- **Run bar**: A 28-pixel status bar displayed directly below the composer
  during an active turn. Displays a status badge, operation text describing the
  running tool or decision, and a stop control when the turn is stoppable.
- **Right panel**: A dockable side panel displaying workspace file trees, opened
  file contents, diff reviews, and inspector data. A hairline divider separates
  the panel from the transcript; dragging the divider adjusts the panel width.
- **Terminal drawer**: A monospace drawer positioned below the transcript.
  Contains interactive terminal sessions and output logs from background
  processes supervised by the host.

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

`Primary` represents `Cmd` on macOS and `Ctrl` on Linux and Windows.

### Global shortcuts

| Shortcut | Action |
| --- | --- |
| `Primary-K` | Open command palette |
| `Primary-N` | Create new session |
| `Primary-,` | Open settings |
| `Primary-B` | Toggle queue sidebar |
| `Primary-J` | Toggle terminal drawer |
| `Primary-\` | Toggle right panel |
| `Primary-1` .. `Primary-9` | Focus live session 1 through 9 |
| `Primary-[` | Select previous session |
| `Primary-]` | Select next session |
| `Primary-W` | Close panel tab or park session |
| `Primary-Shift-W` | Close window |
| `Primary-Q` | Quit application |
| `F10` | Open menu bar |

### Queue shortcuts

Focus the queue by selecting a row or pressing `Primary-B`.

| Shortcut | Action |
| --- | --- |
| `Up` / `Down` | Move row selection |
| `Enter` | Open selected session |
| `P` | Toggle pin on selected session |
| `D` | Toggle defer on selected session |
| `K` | Toggle park on selected session |
| `/` | Filter session list |

### Transcript shortcuts

Focus the transcript by selecting its text area.

| Shortcut | Action |
| --- | --- |
| `Home` | Scroll to first turn |
| `End` | Scroll to live edge and resume following |
| `PageUp` / `PageDown` | Scroll by viewport height |
| `Primary-Up` / `Primary-Down` | Move to previous or next turn |
| `Primary-F` | Find in transcript |
| `Space` | Toggle disclosure on focused block |
| `Primary-A` | Select full turn text |
| `Primary-C` | Copy selected text |

### Composer shortcuts

Focus the composer text area.

| Shortcut | Action |
| --- | --- |
| `Enter` | Send prompt or submit active response |
| `Shift-Enter` | Insert newline |
| `Primary-Enter` | Split turn half |
| `Escape` | Dismiss palette or cancel input |
| `Primary-.` | Abort running turn |
| `Primary-/` | Toggle queue mode (immediate or steer) |
| `1` .. `9` | Select numbered option on attached decision |
| `Primary-Shift-M` | Open model picker |
| `Primary-Shift-T` | Open thinking level selector |
| `Primary-U` | Attach workspace file |
| `Alt-Up` | Take back newest queued prompt into draft |

### Panel shortcuts

Focus the right panel or terminal drawer.

| Shortcut | Action |
| --- | --- |
| `Primary-Alt-[` | Switch to previous tab |
| `Primary-Alt-]` | Switch to next tab |
| `Primary-Shift-D` | Toggle diff presentation mode |

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

`shell.json` does not hold the queue rail's width, `panels.json` does not hold
which tabs the panels offer, and no document holds token overrides. The rail has
no draggable width, the tabs are the host's and arrive with it, and tokens are
read from their files.

## Web inspection

Browser automation runs through the runtime `browser` tool in an external
browser process. The desktop window does not embed web renderers or HTML
inspection tools. File inspection actions open local workspace files.

## Headless scene rendering

The desktop binary supports offscreen rendering for visual verification:

```sh
cargo run -p veyyon-desktop -- scene render 'capability-gate/turn-control-*' --out desktop-scenes
cargo run -p veyyon-desktop -- scene render '*' --contact-sheet --out desktop-scenes
```

`scene list` prints the scene catalogue. `scene render` writes PNG files for the
matching scenes. Capability scenes include draft text, so submission controls
are actionable when the host capability is available.

`--contact-sheet` tiles the matched scenes into one captioned sheet. A set too
large for one texture and one readback buffer is split across
`contact-sheet-01.png`, `contact-sheet-02.png` and so on, each holding whole
rows, so a cell keeps the column it would have had on one sheet.
Whole-catalogue sheets at the default 1180x800 frame page at nine rows.

Each rendered scene prints one line of measurements: the six clutter metrics,
the count of hit rects the frame registered, and `PASS` or `FAIL` against the
whole-window ceilings in `ceilings.toml`. A breach prints a second line stating
the metric, what it measured, and its ceiling; a text-size breach also lists the
sizes. Gaps count the rhythm the frame authored: a span larger than the largest
spacing step, a value backed by one span, and a span a line of prose crosses are
content or remainder rather than rhythm, and are not counted.

## Reference

- [Surfaces and interactions](surfaces.md)
- [Motion](motion.md)
- [Tokens and themes](tokens.md)
- [Source installation](../using/install.md)
