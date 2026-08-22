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

### Real interactive sessions

The HD recorder starts Xvfb, picom, and kitty inside the recorder container. It drives the shipped CLI with real keyboard and pointer events and records the private display at 30 frames per second.

The landing-page terminal uses:

```text
terminal       kitty
font           JetBrains Mono 21
canvas         2560x1440 at 30 fps
window inset   128 px
background     #171b22
foreground     #d3dae6
publish        Lanczos downsample to 1920x1080
```

Preview a scene without replacing tracked proof assets:

```sh
PUBLISH=0 DEMO_SERVER=x11 \
  PROOF_LLM_BASE_URL=http://<host>:11434/v1 \
  bash scripts/demos/record-hd-demo.sh demo-hd
```

The recorder keeps rehearsal output in the temporary directory it prints. Inspect the video and named frames there. Set `PUBLISH=1` only for a complete take whose frame guards all passed.

The scene's task prompt is static at `proof/prompts/demo-hd.md`. The scene stores the secret, submits that prompt once, and sends no phase-by-phase operator prompts; every later turn is the model's own. A take is published only when every named frame guard passed, so a scene whose model does not reach a guarded surface produces a rehearsal and nothing else.

Record on the machine that serves the weights. The endpoint must be a loopback address, or the
recorder refuses to start; `ALLOW_REMOTE_MODEL=1` records against another host and says so. A
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
beside the frames naming the row, the endpoint, the host and the display server the take was
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

The tag carries the bun version in the root `package.json` `packageManager` field,
because the image carries a bun and the product refuses to start on a runtime older
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
