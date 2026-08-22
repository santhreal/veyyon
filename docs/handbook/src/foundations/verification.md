# Testing and verification

Product behavior is covered by tests that assert concrete outcomes, not only non-empty results.

## Examples of what tests check

- **Hashline edit path**: round-trip: generated patches apply to the intended content; mismatches fail with the expected error surface.
- **Tool-call repair**: unit and conformance cases in `packages/coding-agent/test/repair/schema-repair.test.ts` (clean / repaired / unrepairable, alias ambiguity, strict `additionalProperties`).
- **Tool-output bounds**: truncation limits behave as configured and remain visible to the model.
- **Architecture gates**: layering, import cycles, and module-reach checks in `packages/coding-agent/test/architecture/`.

## Recording terminal proofs

This section is the capture configuration. It is the only source of visual proof.
Record interactive proofs on the repository's private display. Do not record a
logged-in desktop, and do not use a terminal multiplexer capture as visual
evidence. There are no other capture paths and no fallbacks.

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

The archived take remains at capture speed. The landing-page cut keeps the plan, the worker setup, verification and signing at 1×. Visible implementation between the worker launch and the verified build plays at 1.25×. Named marks in the take select those boundaries; untouched screens are shortened to four seconds rather than accelerated.

### VHS settings captures

Use the same baseline for settings differentials:

```tape
Set Shell bash
Set FontSize 22
Set Width 1400
Set Height 720
Set Padding 30
Set Margin 40
Set MarginFill "#000000"
Set BorderRadius 0
Set Framerate 30
Set TypingSpeed 55ms
Set CursorBlink false
Set Theme { "name": "veyyon", "black": "#000000", "background": "#000000", "foreground": "#C6CBD4", "cursor": "#F0862E" }
```

Drive both states from one script. Seed each setting explicitly before capture. Restore the default after the pair is written.

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
that writes a render into `assets/`. Drivers write outside the tracked tree;
`scripts/demos/record-argot-settings.sh` is the shape a settings differential takes.

## Related

- [The repair cascade](../repair/cascade.md)
- [The hashline edit engine](../edit/engine.md)
