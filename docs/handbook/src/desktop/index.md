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

## Render scenes

```sh
cargo run -p veyyon-desktop -- scene render 'capability-gate/turn-control-*' --out desktop-scenes
```

`scene list` prints the scene catalogue. `scene render` writes PNG files for the
matching scenes. Capability scenes include draft text so submission controls
are actionable when the host capability is available.

## Reference

- [Surfaces and interactions](surfaces.md)
- [Motion](motion.md)
- [Source installation](../using/install.md)
