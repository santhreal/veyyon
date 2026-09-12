# Native desktop

The native desktop is a source-built GPUI application in the private
`veyyon-desktop` crate. It connects to the Veyyon GUI host. The published
installer does not install this desktop executable.

## Run from a checkout

From a configured source checkout, with Bun on `PATH`:

```sh
VEYYON_BIN="$PWD/packages/coding-agent/src/cli.ts" cargo run -p veyyon-desktop
```

`VEYYON_BIN` selects the executable used to start `veyyon gui`. Without this
variable, the desktop searches `PATH` for `veyyon`.

The initial window and minimum window dimensions are 800 × 560 pixels, configured
in `crates/veyyon-desktop-tokens/tokens/surface/shell.toml`. Startup validates the
design tokens and bundled theme. Token directory changes reload while the
application runs.

Monospace text — the terminal drawer, diffs, code blocks and file paths — is set
in the first font family installed on the machine out of the ordered list under
`[type.family]` in `crates/veyyon-desktop-tokens/tokens/scale.toml`. The shipped
list is JetBrains Mono, DejaVu Sans Mono, Liberation Mono, Menlo, SF Mono,
Consolas, Courier New. With none of them installed, startup fails and prints the
whole list; install one of those families, or add a monospaced family the machine
has to the list.

## Connect to a host

```sh
cargo run -p veyyon-desktop -- --endpoint tcp:127.0.0.1:17654
```

Endpoint selection uses `--endpoint`, then `VEYYON_GUI_ENDPOINT`, then
`<agent-dir>/gui-host.sock`. Use `unix:<path>` for a Unix socket or
`tcp:<host>:<port>` for TCP. An empty TCP host selects `127.0.0.1`. An endpoint
without a recognized scheme selects the default socket; it is not a relative
socket path.

The default agent directory is `~/.veyyon/profiles/<profile>/agent`, with
`VEYYON_PROFILE` selecting the profile and `default` used otherwise. Without an
explicit endpoint, the desktop attaches to the default socket if it accepts a
connection. Otherwise it starts a host in the current working directory and
waits up to five seconds for its listening banner. An explicit endpoint disables
automatic host startup.

A Unix socket path is limited by `sockaddr_un.sun_path`: 107 bytes on Linux, 103
on macOS. When `<agent-dir>/gui-host.sock` is longer, both the desktop and the
host use `<runtime-dir>/veyyon-gui-<digest>.sock` instead, where `<digest>` is
the first 16 hex characters of the SHA-256 of the agent directory and
`<runtime-dir>` is `$XDG_RUNTIME_DIR`, else `/run/user/<uid>` on Linux, else
`$TMPDIR` on macOS. With no such directory, and for an explicit `unix:` endpoint
over the limit, startup fails with the path, its size and the limit.

## What the window remembers

State is stored under `<agent-dir>/desktop/`.

| Document | Contents |
|---|---|
| `window.json` | Position, size, maximised state and display |
| `shell.json` | Appearance, active session, ordered tabs, named spaces and each space's queue and panel layout |
| `queue.json` | Collapsed queue sections and parked-section pagination |
| `panels.json` | Per-session panel and drawer visibility, dimensions, selected tabs and diff mode |
| `transcript.json` | Per-session disclosure state and reading position |
| `composer.json` | Per-session draft text, attachments and queue mode |
| `reviews.json` | Local review threads, line anchors and resolution state, partitioned by repository and file |

A reading position is the transcript entry the top turn was opened by, not a
turn index, so it survives the session paging in earlier turns. A transcript
left at the live edge stores no position and comes back at the live edge. A
position naming a turn the host has not sent yet is held and applied on the
frame that turn is drawn.

`VEYYON_DESKTOP_STATE_DIR` selects another directory. With no home directory to
build a profile path under, the window remembers nothing and writes nothing.

A change reaches the disk 400 milliseconds after the first change of its
window, and everything waiting is written on quit. Each document is written to a
sibling `.json.writing` file and renamed over the previous one. `composer.json`
and `reviews.json` are fsynced before that rename; the other documents are not.

A document from a version this build does not write, a truncated document, and
a document holding a key this build does not write are all replaced by the
default and reported on stderr at warn level, naming the file, the session for
a per-session document, what was wrong and the version this build writes.
Nothing is migrated. One session's rejected entry leaves every other session's
in place.

A measure the pointer never dragged is absent rather than stored, so the panel
and drawer follow the breakpoint ladder at the width the window opens at. A
remembered window whose display this machine no longer has opens centred on a
display it does have, at the size it had. A remembered size below 800 × 560
opens at 800 × 560. A remembered session the host no longer lists is dropped
rather than reopened, and the session is asked for once, so a session closed
afterwards stays closed.

`shell.json` does not hold the queue rail's width, `panels.json` does not hold
which tabs the panels offer, and no document holds token overrides. The rail
has no draggable width, the tabs are the host's and come back with it, and
tokens are read from their files.

## Web inspection

Browser automation runs through the runtime's `browser` tool in a separate
browser. The native window does not embed web pages, an element picker or page
annotations. The file inspector's external-open action accepts workspace files,
not web URLs.

## Connection states

Each transport state is shown in one place.

Before a session loads, the window shows one dialog in place of the queue,
transcript and panels. Detached states the endpoint is not connected and offers
**Attach**. Connecting states the attempt number. Syncing states the snapshot
count, with a bar over the received fraction when the host declares a total and
an indeterminate indicator when it does not.

After a session loads, a transport failure keeps the queue and the transcript on
screen and adds a banner under the titlebar. Reconnecting shows the attempt, the
retry countdown, the reason and **Retry Now**. Fatal shows the failure and
**Re-attach**. Neither state repeats itself in the window's status line, and
neither offers a second copy of the button in the banner.

A control is offered only while the transport can carry what it would send.
Detached, Connecting, Syncing and Fatal disable every control except the one
that ends the state, each stating the transport as the reason. Reconnecting
disables the controls that change state — sending a prompt, answering a
question, accepting a plan, deleting a session — and leaves navigation over
what the client already holds enabled.

## Render scenes

```sh
cargo run -p veyyon-desktop -- scene render 'capability-gate/turn-control-*' --out desktop-scenes
cargo run -p veyyon-desktop -- scene render '*' --contact-sheet --out desktop-scenes
```

`scene list` prints the scene catalogue. `scene render` writes PNG files for the
matching scenes. Capability scenes include draft text so submission controls
are actionable when the host capability is available.

`--contact-sheet` tiles the matched scenes into one captioned sheet. A set too
large for one texture and one readback buffer is split across
`contact-sheet-01.png`, `contact-sheet-02.png` and so on, each holding whole
rows so a cell keeps the column it would have had on one sheet. Whole-catalogue
sheets at the default 1180x800 frame page at nine rows.

Each rendered scene prints one line of measurements: the six §9.6 clutter
metrics, the count of hit rects the frame registered, and `PASS` or `FAIL`
against the whole-window ceilings. A breach prints a second line naming the
metric, what it measured, and its ceiling; a text-size breach also lists the
sizes. Gaps count the rhythm the frame authored: a span larger than the largest
spacing step, a value backed by one span, and a span a line of prose crosses
are content or remainder rather than rhythm and are not counted.

## Reference

- [Surfaces and interactions](surfaces.md)
- [Motion](motion.md)
- [Source installation](../using/install.md)
