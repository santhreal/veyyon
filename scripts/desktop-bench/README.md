# Desktop bench

The desktop bench measures veyyon-desktop and T3 Code on one private display, with one seeded corpus, one
fake model server and one measurement method. It reads the app window's pixels through XShm and drives the
app through XTest, so no probe depends on a hook inside either app. The `palette_open_painted_*` results
are the exception: they read the frames veyyon-desktop reports on its driver socket.

## Requirements

- Linux with sway 1.9 or later, Xwayland, `xdpyinfo`, `swaymsg` and `lspci`.
- A render node for the headless output, set in `BENCH_DRM_DEVICE` (default `/dev/dri/renderD129`).
  `apps.py` pins Vulkan and GL to the PCI device in `DRM_PCI_TAG`.
- `python3` with numpy, and `libX11`, `libXext` (MIT-SHM) and `libXtst`.
- veyyon: a `veyyon-desktop` binary and `bun`. The host runs this checkout's CLI under bun
  (`veyyon-host.sh`). A binary built before the token crate was retired reads its token and theme
  directories at start; they are extracted from the git revision in the binary's file name suffix
  (`-<hex>`), else from `HEAD`, and `--assets-revision` sets it. A revision without
  `crates/veyyon-desktop-tokens` built a binary that embeds its fonts and themes, and nothing is
  extracted.
- T3 Code: the unpacked AppImage (`squashfs-root/t3code`), `codex` and `node`.

## Running

```sh
scripts/desktop-bench/run.sh t3 --binary <squashfs-root>/t3code
scripts/desktop-bench/run.sh veyyon --binary <dir>/veyyon-desktop
scripts/desktop-bench/compare.sh .internal/rebuild/bench/veyyon.json .internal/rebuild/bench/t3.json
```

`run.sh <veyyon|t3>` accepts:

|Option|Effect|
|---|---|
|`--binary PATH`|App binary. Defaults to `$BENCH_VEYYON_BIN` or `$BENCH_T3_APP`.|
|`--samples N`|Samples for each repeatable probe. Default 20.|
|`--out DIR`|Report directory. Default `.internal/rebuild/bench`.|
|`--name NAME`|Report file stem and work directory name. Default the app name.|
|`--probes LIST`|Comma-separated subset of `cold_launch,keystroke,switch,token,steady,palette_open`. Default all but `palette_open`.|
|`--survey [X,Y ...]`|Launch once, click each point, relaunch, and write a screenshot after each step.|

`bun`, `codex` and `node` come from `$BENCH_BUN`, `$BENCH_CODEX` and `$BENCH_NODE`, else from `PATH`.

`run.sh` starts a headless sway session through `session.sh` and stops it on exit. `session.sh` rejects
`:0`, `:1`, and any X display or Wayland socket that was live before it started. The apps run with
`HOME`, the XDG directories and `CODEX_HOME` under `.internal/bench/work/<name>/`; no probe reads the
invoking user's configuration.

A run writes `<out>/<name>.json` and `<out>/<name>.md`. `compare.sh a.json b.json` prints one markdown
row per probe with both medians, both p95 values and the ratio of b's median to a's.

The work directory holds one log per launch and a full-window screenshot from each probe:
`ready.png`, `keystroke.png`, `switch.png`, `token.png`, `long-thread.png` and `palette.png`.

## Report

Each report holds `app`, `name`, `binary`, `started`, `corpus`, `environment`, `probes` and `failed`.
Each probe holds `samples`, `median`, `p95` (nearest rank), `unit` and `notes`, and some hold extra
fields (`mean`, `frames`, `longest_gap_ms`, `first_token_delay_ms`). `failed` maps each probe group that
raised to its error; the other groups still run.

## Setup

1. `fake_llm.py` starts on a free port. It serves an OpenAI-compatible stream and logs each token's
   `CLOCK_MONOTONIC` send time (`t_ns`).
2. `apps.py` builds the scratch home, seeds `corpus.py` through `seed.py`, and points the app at the
   fake server. For T3 Code this includes one launch that creates the state database and one that
   projects the seeded events.
3. A warm-up launch fills the shader and font caches and performs the layout's `setup_clicks`. Its
   home is copied to `pristine-home`. Every later launch starts from a fresh copy of it.
4. A reference launch waits until the window holds still for 3 s, twice, 5 s apart, and records the
   sidebar region as the ready reference.

## Probes

A change is a set of pixels that differ between two successive grabs. A change narrower than 6 px and
smaller than 60 px is a text caret blinking and is ignored. The time of a grab is the midpoint of the
`XShmGetImage` call. Each probe's notes include the mean poll period.

|Probe|Unit|Method|
|---|---|---|
|`cold_launch_ms`|ms|From exec to the first frame whose sidebar region matches the ready reference in all but 0.1% of its pixels.|
|`cold_launch_window_ms`|ms|From exec to the first mapped top-level window at the layout's full size.|
|`keystroke_ms`|ms|With a short thread open and the composer focused, from an XTest key press to the first composer change. Keys are wide lowercase letters, 200 to 300 ms apart.|
|`switch_first_ms`|ms|From a click on a sidebar row to the first transcript change. Clicks alternate between the two newest threads.|
|`switch_settle_ms`|ms|From the same click to the last transcript change before 400 ms without one.|
|`token_to_paint_ms`|ms|One turn of 40 tokens 250 ms apart. Each token's `t_ns` is matched to the first change at or after it in the stream region above the composer.|
|`idle_cpu_ui_pct`|% of one core|30 one-second samples of the UI process with a short thread open, settled, and the pointer parked.|
|`idle_cpu_tree_pct`|% of one core|The same samples over the whole process tree.|
|`long_thread_open_ms`|ms|From a click on the 10,000-entry thread to the last transcript change before 1 s without one.|
|`memory_tree_rss_mib`|MiB|Sum of `Rss` from `smaps_rollup` over the process tree, 2 s after the long thread settles.|
|`memory_tree_pss_mib`|MiB|Sum of `Pss` over the same processes.|
|`scroll_fps`|frames/s|Wheel clicks at 60 Hz for 5 s over the long thread; distinct frames in each second.|
|`scroll_frame_interval_ms`|ms|Intervals between distinct frames in the same run.|
|`scroll_gaps`|count|Intervals longer than 1.5 times the output refresh interval.|
|`palette_open_ms`|ms|With a short thread open and settled, from the XTest press of the layout's `palette_chord` to the first change in the `palette` region. The first open of a launch is not a sample. Escape closes the palette between samples.|
|`palette_open_settle_ms`|ms|From the same press to the last change before 400 ms without one.|
|`palette_open_frames`|frames|Distinct frames per open, read until 400 ms pass without a change.|
|`palette_open_frame_interval_ms`|ms|Intervals between those distinct frames.|
|`palette_open_gaps`|count|Intervals longer than 1.5 times the output refresh interval, per open.|
|`palette_open_painted_ms`|ms|veyyon only, in a separate launch with `VEYYON_DESKTOP_DRIVER` set: from the chord press to the first frame the driver socket reports.|
|`palette_open_painted_frames`|frames|Frames the driver socket reports per open, read until 250 ms pass without one.|
|`palette_open_painted_interval_ms`|ms|Intervals between those painted frames.|
|`palette_open_painted_gaps`|count|Painted-frame intervals longer than 1.5 times the output refresh interval, per open.|

The UI process is `veyyon-desktop` for veyyon and the Chromium renderer processes (`--type=renderer`)
for T3 Code. The process tree is every process that carries the launch's `BENCH_TAG` environment entry,
and all of their descendants.

The token probe masks the pixels that changed in the 800 ms before the first token, which covers a
spinner or a timer drawn in the stream region. A token paint that falls only inside the mask is not
detected. Its notes report the masked share of the region, the tokens without a later paint, and the
tokens that shared one paint with another token.

The scroll probe scrolls up. When the first wheel click changes nothing it scrolls down.

## Corpus

`corpus.py` generates three projects of ten threads from seed 20260928. Every thread holds 40 messages
except `gamma-07`, titled "long thread", which holds 10,000. Both apps list threads newest first:
`gamma-09` and `gamma-08`, the switch threads, are rows one and two, and the long thread is row three.

## Layout

`layout-<app>.json` holds window coordinates on the 1600x1000 output: the full window size, the pointer
parking point, the sidebar reference region, the row centers, the composer click point and region, and
the transcript, stream and scroll regions. `palette_chord` lists the keysyms that open the command palette,
modifiers first, and `palette` is the region the open palette card is drawn in; `palette_open` checks the
card the driver socket reports lies inside it. `setup_clicks` run once in the warm-up launch;
`launch_clicks` run after every ready launch. Derive the coordinates from `--survey` screenshots. The
first survey screenshot can show the window before it reaches its tiled size.

## Scope

- Every time ends when the app hands a frame to Xwayland. Compositor latency and scanout are not
  measured; both apps share them.
- Cold launch is a cold process on a warm page cache, with the shader and font caches the warm-up
  launch filled.
- T3 Code runs with `responseStreamingMode` set to `token`; its default, `paragraph`, holds text until a
  paragraph ends. Provider update checks are off. T3 Code receives tokens through `codex`; veyyon
  receives them through its bun host. Both paths are part of `token_to_paint_ms`.
- A change the app draws for another reason after a token's send time counts as that token's paint.
  Samples below the app's pipeline floor come from such changes.
- Keystroke latency spreads over one refresh interval, because each app presents at the next frame. The
  median of 20 samples varies by about 2 ms between runs; 80 samples bring that to about 1 ms.
- RSS sums count shared pages once per process. PSS sums do not.
- Not measured: real model output, network latency, input from a physical device, Wayland-native
  clients (both apps run under Xwayland), multiple outputs and fractional scale.
