# Renderer defect oracle

`packages/tui/test/render-stress-harness.ts` executes randomized operation sequences against a TUI instance over a Ghostty WASM VirtualTerminal, evaluates fidelity assertions against a commit ledger, and uses `packages/tui/test/render-stress-reducer.ts` to reduce failing operation logs.

In `packages/tui/test/render-stress.test.ts`, the full render-stress sweep is disabled during CI:

```ts
const SKIP_IN_CI = Boolean(Bun.env.CI);
```

Subprocess pool execution with Ghostty WASM compilation exceeds pull-request time limits.

The render-stress harness evaluates synthetic root components against viewport and scrollback row ledgers. It contains no assertions for pinned footer components (`pinnedFooter`, `composer`, `PinnedFooter`).

## Composer-zone oracles

`mountComposerZone` in `packages/coding-agent/src/modes/components/composer/composer-chrome.ts` mounts the production pinned footer components: `statusContainer`, `statusLine`, `hookWidgetsAbove`, `hairline`, `editorContainer`, `capabilityLine`, `shortcuts`, `hookWidgetsBelow`, and the bottom margin spacer.

Composer defect oracles evaluate the rendered terminal grid:

- One composer prompt row exists in the viewport when visible, and zero when scrolled off.
- No grid row contains both transcript text and chrome tokens.
- Pinned footer rows occupy the bottom physical rows of the viewport when total frame rows equal or exceed viewport height.
- No row of the footer appears above the footer boundary.
- Transcript output rows do not appear below the last footer row or inside the footer region.
- Mouse click events dispatch to the component rendered at the target row.
- The terminal cursor remains within editor boundaries when focused.
- Visible character width on each row does not exceed terminal width.
- Vertical padding rows contain no background styling or text characters.
- Hairline rendering occupies one boundary row.
- Pinned footer row count matches the segment ledger row count sum.
- Virtual scroll isolation retains live footer lines at the bottom of the viewport.

Nine oracles evaluate the terminal grid produced by the emitter. Three of them (padding transparency, hairline placement, and footer height against the segment ledger) read a segment ledger that `packages/coding-agent/test/helpers/composer-oracle-runner.ts` rebuilds by re-rendering a hardcoded list of the components `mountComposerZone` is expected to mount. Those three judge a model of the composer rather than the composer, and the footer-height oracle compares a sum against the value that is defined as that sum. `packages/coding-agent/test/every-composer-oracle-inspects-real-frame-data.test.ts` cross-checks the rebuilt total against `TUI.composedFrameRows`, so the model cannot drift from the composed frame unnoticed.

## Sweep

`packages/coding-agent/test/composer-defect-sweep.test.ts` mounts the cross product of 8 mode variants, 5 widths, 5 heights, 3 transcript depths and 7 text variants: 4200 states. Each state mounts through the real `mountComposerZone`, settles through `settleFrames`, and is judged against all 12 oracles. A state whose oracles go red fails the sweep.

The sweep settles one frame per state, so a defect that appears only in the transition between two frames is out of its reach. `packages/coding-agent/test/a-repaint-never-leaves-a-second-composer-behind.test.ts` covers two transitions: a sequence of terminal geometries, which forces a full repaint of the composer zone, and appending to the transcript, which grows the frame under a pinned footer and takes the incremental paint path. It re-reads the grid after every step and counts hairline rows, prompt rows and paints of the newest appended line. The transcript double returns a fresh array per render, because a component that hands the engine its own mutable buffer rewrites the rows the engine cached as the previous frame, and the diff then skips a repaint it needed. Randomized operation sequences and failure reduction stay in `packages/tui/test/render-stress-harness.ts`.

`scrollOffset` is derived as `transcriptCount > height ? 2 : 0`, so a scrolled-back state whose transcript is shorter than the viewport is never swept. Screen rows are located as `segment.startIndex - windowTopRow`, and that subtraction does not hold in that state: the padding oracle reports the capability line as a padding row.

## Local case files

A failing state is written to `packages/coding-agent/test/corpus/renderer-defect-oracle/<id>.json`, where the id is the SHA-256 hash of the normalized state and failing invariant name, truncated to 16 hex characters. The directory is gitignored, because a case file belongs to the run that wrote it.

Each case records `template`, `seed`, `state`, `failingOracle`, `errorMessage` and `observedGrid`. `corpusStateToRunnerOptions` turns `state` back into the mount that produced it. `statusMessage` and `customParts` do not survive that round trip, and `every-composer-oracle-inspects-real-frame-data.test.ts` pins the dropped set by exact equality, so an option the sweep varies and the mapping omits fails the suite instead of writing cases that replay as a different scenario.

Nothing replays the directory. A case that survives a run is a defect to fix or an oracle to correct, and the sweep already covers every state a replay would cover.

## Exclusions

The oracles measure character grid cell placement and line boundaries. They do not evaluate color values, styling attributes, image protocol placement, or terminal emulator implementations outside Ghostty WASM.
