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

The hero task prompt is static at `proof/prompts/demo-hd.md`. The scene sets the secret and submits that prompt once. The model creates its own persistent goal before planning, and goal continuation carries later model turns. The scene does not send phase-by-phase operator prompts.

The archived take remains at capture speed. The landing-page cut keeps goal, todo, worker setup, verification, signing, goal completion, and presentation at 1×. Visible implementation between the worker launch and verified build plays at 1.25×. Named marks in the take select those boundaries; untouched screens are shortened to four seconds rather than accelerated.

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

The output is not a proof and does not satisfy any evidence requirement. It draws a
fixture written by hand, at a chosen width, through a constructed call. It cannot
show that the surface is reachable, that the state is real, or that the block is
positioned, sized and clipped the way a session draws it. Write the file to a
temporary path. A rasterized image never enters `assets/`, a README, or a handbook
page as before-and-after evidence.

Seventeen raster pairs are already committed under `assets/`. They were produced
under an earlier rule that sanctioned them, they are not evidence, and no handbook
page or README cites them; `proof/pics.html` enumerates the directory from disk and
still lists them. Each is replaced by a real capture of its screen when that feature
is next touched. `scripts/an-off-screen-raster-never-enters-assets.test.ts` pins the
set by exact equality and fails on any addition, so the list only shrinks, and it
fails as well on a demo driver that writes a render into `assets/`. Drivers write to
a temporary directory; `scripts/demos/record-argot-settings.sh` is the shape a real
settings differential takes.

## Related

- [The repair cascade](../repair/cascade.md)
- [The hashline edit engine](../edit/engine.md)
