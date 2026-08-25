# Testing and verification

Product behavior is covered by tests that assert concrete outcomes, not only non-empty results.

## Examples of what tests check

- **Hashline edit path**: round-trip: generated patches apply to the intended content; mismatches fail with the expected error surface.
- **Tool-call repair**: unit and conformance cases in `packages/coding-agent/test/repair/schema-repair.test.ts` (clean / repaired / unrepairable, alias ambiguity, strict `additionalProperties`).
- **Tool-output bounds**: truncation limits behave as configured and remain visible to the model.
- **Architecture gates**: layering, import cycles, and module-reach checks in `packages/coding-agent/test/architecture/`.

## Recording terminal proofs

The capture configuration below is the only source of visual proof.
Record interactive proofs on the repository's private display. Do not record a
logged-in desktop, and do not use a terminal multiplexer capture as visual
evidence. There are no other capture paths and no fallbacks.

### Which artifact proves which change

The artifact class follows the change class, and a mismatch is a failed proof.

```text
static surface changed     two PNG frames, before and after
animation or timing changed  two animated clips, before and after
setting added or changed   two PNG frames, off and on
```

A still never proves an animation: a frame cannot show a cadence, a transition, or a
spinner. An animated clip never substitutes for a frame pair either, because a reader
comparing two clips cannot hold both states side by side. The recorder publishes
animation as WebP at 33 ms per frame; a GIF is the same clip in an older container and
proves the same thing. Both arms of a pair are the same class, produced by one driver
run, and attached to the pull request body.

The recorder refuses to publish a clip whose cadence is not the one it captured. Three
criteria come from `--expect-ms`:

```text
typical frame     capture interval +/-1 ms (33/34 ms at 30 fps)
moving average    at least 80% of the capture rate, held stills set aside
cadence share     at least 85% of moving frames at the capture interval
```

The typical frame catches a resample, where every frame was rewritten. The moving
average catches a clip whose wall clock is mostly slower than its most common frame.
The cadence share catches frequent short holds that an acceptable average can hide.
Byte-identical frames from normal terminal input and model output are coalesced by the
WebP encoder, so the average allows 20% while the share limits how often that occurs.
A hold at or past ten intervals is a still screen, is reported, and does not count.
Measure a published file with:

```sh
python3 proof/webp-cadence.py assets/demo-hd.webp --expect-ms 33
```

### Real interactive sessions

The HD recorder starts Xvfb and kitty inside the recorder container. It drives the shipped CLI with real keyboard and pointer events and records the private display at 30 frames per second.

30 is the rate the pipeline delivers whole. Measured at 2560x1440 with the hero's chrome and a payload repainting every cell as fast as the terminal accepts it, a 30 fps capture returns 240 unique frames of 240 grabbed. Capturing at 60 adds no motion the session had: it doubles the encoder's cores and the file, and writes a 60 fps header over slower content, which is how a stuttering take once read as smooth to `ffprobe`.

A take is judged on whether the picture moved, never on the rate the container declares. `proof/motion-gate.sh` counts unique frames with mpdecimate and fails a take below `SCENE_MOTION_FLOOR`; both session scripts run it before the take is published.

The landing-page terminal uses:

```text
terminal       kitty
font           JetBrains Mono 15
canvas         2560x1440 at 30 fps
window inset   128 px
background     #171b22
foreground     #d3dae6
publish        Lanczos downsample to 1920x1080
```

### Where the settings live, and where the chrome is drawn

`proof/docker/scene-config.sh` is the single definition of every `SCENE_*` knob. The two session scripts and the two host recorders source it; none of them restates a default. Override a knob by exporting it, never by editing one of those four files, because a default written down twice is two defaults and the one a run gets depends on which file it entered through.

The chrome — rounded corners, the shadow, the translucent window over the backdrop — is drawn after the take by `proof/compose-chrome.sh`, not by a compositor during it. The backdrop does not move, so blending it under the window every frame recomputes one static picture thousands of times, and it cost the capture: with picom's blur on, `ffmpeg` could grab only 69 of 360 frames, and opacity alone still cost a third. `xwallpaper` puts the backdrop in the capture for free as a root pixmap; the pass replaces the square-cornered inset with the same pixels rounded, blended and shadowed.

`SCENE_CHROME=live` runs a compositor during the capture instead, for comparison. It is not the default and a take recorded that way is slower.

The pass is cosmetic. It cannot recover a frame the capture never drew, so a take that stuttered while it was recorded still stutters after it, and the motion gate runs on the composited file that ships.

Preview a scene without replacing tracked proof assets:

```sh
PUBLISH=0 DEMO_SERVER=x11 \
  PROOF_LLM_BASE_URL=http://<host>:11434/v1 \
  bash scripts/demos/record-hd-demo.sh demo-hd
```

The recorder keeps rehearsal output in the temporary directory it prints. Inspect the video and named frames there. Set `PUBLISH=1` only for a complete take whose frame guards all passed.

The scene's task prompt is static at `proof/prompts/demo-hd.md`. The scene stores the secret, submits that prompt once, and sends no phase-by-phase operator prompts; every later turn is the model's own. A take is published only when every named frame guard passed, so a scene whose model does not reach a guarded surface produces a rehearsal and nothing else.

Record on the machine that serves the weights. The endpoint must be a loopback address, or the
recorder will not start; `ALLOW_REMOTE_MODEL=1` records against another host and reports it. A
session driven across a network pauses for reasons the recording cannot separate from the product.

Before anything is recorded the driver checks three things and exits on any of them:

```sh
bun scripts/verify-scene.ts demo-hd   # the same check, run on its own
bun scripts/verify-scene.ts --all
```

Every string the scene waits for must be produced by the submitted prompt, the product's own
source, the sandbox seed, or a line the scene types. A guard nothing produces does not fail fast:
it waits out its timeout, marks the shot missed, and the publish step leaves the previous take's
frame under that name. A needle that comes from somewhere else is declared in the scene:

```sh
# needle-source: WARP CORE -- printed by the compiled binary's banner
```

The driver also requires the model row to exist on that server, and writes `<scene>-model.txt`
beside the frames recording the row, the endpoint, the host and the display server the take was
recorded on.

Every binary the run will use is resolved before the first frame: `docker`, `bun` for the scene
check, and `ffmpeg` and `python3` for the publish chain. ImageMagick answers to `magick` on 7 and
`convert` on 6, and either is accepted. Bun is looked for at `~/.bun/bin/bun` when it is not on
`PATH`, because a recording is driven over ssh and a non-login shell there does not carry the
installer's entry. A publish tool first called after the recording is a take lost to a `PATH`
difference, which is why a rehearsal needs only `docker`.

The container is built by one script and tagged from one declaration:

```sh
bash proof/docker/build-recorder.sh
```

The tag contains the bun version in the root `package.json` `packageManager` field,
because the image contains a bun and the product will not start on a runtime older
than the one it is built for. A bump therefore makes a stale image a missing image,
which docker reports before a display server starts. Recording with an image built
on an older bun ends the take from inside the container after the whole rig is up.

The recorder reaches a model served on the host through the docker host gateway; the
loopback address the driver requires is rewritten for the container by
`proof/docker/host-endpoint.sh`, so no scene needs to name a network address.

The archived take remains at capture speed. The landing-page cut keeps the plan, the worker setup, verification and signing at 1×. Visible implementation between the worker launch and the verified build plays at 1.25×. Named marks in the take select those boundaries; untouched screens are shortened to four seconds rather than accelerated.

### Settings differentials

A settings change proves with two frames of the settings screen recorded from the
same scene, one with the setting at its default and one with the operator's value.
`SCENE_SETTINGS` appends config-file lines to the seeded home before the session
starts, so each arm is seeded rather than toggled by a keybinding that may not land:

```sh
OUT_DIR=proof/captures/x11/off \
  proof/docker/record-x11.sh proof/scenes/settings-pointer.sh

OUT_DIR=proof/captures/x11/on SCENE_SETTINGS='argot.enabled: true' \
  proof/docker/record-x11.sh proof/scenes/settings-pointer.sh
```

Both arms run the same scene at the same window size, so the only difference between
them is the setting. A pair whose two frames are byte-identical, or whose "on" arm
does not show the value in effect, is a failed proof.

### Before-and-after pairs for a UI change

A change to a visible surface proves with two frames of the same scene, one on the
tree without the change and one on the tree with it.

```sh
proof/docker/record-x11.sh proof/scenes/<name>.sh        # the after arm
proof/docker/record-x11-before.sh proof/scenes/<name>.sh # the before arm
```

The after arm writes to `proof/captures/x11/`. The before arm writes to
`proof/captures/x11/before/`, holding every source file the change touched at the
content of the base commit for the length of the run, restoring from an in-memory
copy and proving the restore by sha256. No git mutation command runs and the working
tree ends byte-identical. Once the change is on `main`, reproducing the before arm
means pointing that hold at the commit before it.

Both arms record the same scene at the same width and are sampled at the same second
of the same script, so the only difference between them is the change. Attach the
labeled Before and After pair to the pull request body. It is never committed: not to
`assets/`, not to a README, not to a handbook page, not to the website.

A pair whose two arms differ for an unrelated reason is a failed proof. An arm that
does not show the surface at all is a failed proof: a lane block is not evidence
about lanes in a frame where no agent is running.

### Zooming into a detail

A 2560-wide capture published at 1920 loses a small detail to the downsample. A row
whose subject is one block of text names the mark to hold on, and the stage eases into
the region and back out:

```sh
python3 proof/zoom.py take.mp4 zoomed.mp4 --marks take-marks.tsv --mark todo-board
python3 proof/zoom.py --self-check
```

The region is measured, not typed in: the stage diffs the frames around the moment and
holds the bounding box of what changed there, padded and clamped inside the frame at
the source aspect ratio. A moment with nothing moving in it produces no file.

The hero take drives the same stage from a cue file the scene writes next to its
marks (`zoom-in FRAME [x,y,w,h]`, `pan FRAME x,y,w,h`, `zoom-out FRAME`). The hold between those cues
is at least two seconds of real time, with no time compression on that span, so
the stored secret is readable. Magnification is relative to the published wide
shot and is at least 2x: `proof/glyph-height.py` measures `capture_width /
crop_width` on the hold. A missing rect on `zoom-in` means "measure it".

The zoom ceiling still defaults to the capture width over the published width so a
1.33x hold is a crop. The hero's 2x secret hold is a tighter crop scaled back to
1920x1080 — a camera move of the one capture path, not a second recorder. The
stage runs on the take, before the cut, and keeps every frame and the recorded
rate, so the cadence gate still measures the capture's own cadence. A scene asks
for one by writing the cue file, or by setting `ZOOM_ARGS` in
`scripts/demos/record-hd-demo.sh`.

`--self-check` records a synthetic clip whose moving region is known and asserts the
measured rect, the frame count, the rate and the held magnification. Run it on a
recorder host before a take depends on the stage.

### Off-screen component renders are a debugging aid, not a proof

Rasterizing a component's ANSI answers one narrow question quickly and without a
display: whether a fill, colour or spacing reads correctly on a grey and a black
ground.

```sh
env -u NO_COLOR FORCE_COLOR=3 bun scripts/demos/render-<surface>.ts [args] |
  bun scripts/demos/render-proof.ts --out /tmp/<surface> --width 100 --scale 2
```

`render-proof.ts` writes `<surface>-grey.png` with background `#1e2127` and
`<surface>-black.png` with background `#000000`. Inspect both. A background fill
can disappear on black while remaining visible as a slab on grey.

The output draws a fixture written by hand, at a chosen width, through a constructed
call, so it cannot show that the surface is reachable, that the state is real, or
that the block is positioned, sized and clipped the way a session draws it. It does
not satisfy an evidence requirement. Write the file to a temporary path.

`scripts/an-off-screen-raster-never-enters-assets.test.ts` pins the raster set under
`assets/` by exact equality, so the list only shrinks, and fails on a demo driver
that writes a render into `assets/`. Drivers write outside the tracked tree.

## Related

- [The repair cascade](../repair/cascade.md)
- [The hashline edit engine](../edit/engine.md)
