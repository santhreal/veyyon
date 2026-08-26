# Renderer defect oracle

`packages/tui/test/render-stress-harness.ts` executes randomized operation sequences against a TUI instance over a Ghostty WASM VirtualTerminal, evaluates fidelity assertions against a commit ledger, and uses `packages/tui/test/render-stress-reducer.ts` to reduce failing operation logs.

In `packages/tui/test/render-stress.test.ts`, the full render-stress sweep is disabled during CI:

```ts
const SKIP_IN_CI = Boolean(Bun.env.CI);
```

Subprocess pool execution with Ghostty WASM compilation exceeds pull-request time limits.

The render-stress harness evaluates synthetic root components against viewport and scrollback row ledgers. It contains no assertions for pinned footer components (`pinnedFooter`, `composer`, `PinnedFooter`).

## Composer-zone oracles

`mountComposerZone` in `packages/coding-agent/src/modes/components/composer-chrome.ts` mounts the production pinned footer components: `statusContainer`, `statusLine`, `hookWidgetsAbove`, `hairline`, `editorContainer`, `capabilityLine`, `shortcuts`, `hookWidgetsBelow`, and the bottom margin spacer.

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
- No cell beyond a row's painted text carries a background, foreground or underline.

The last one is what an escape sequence the renderer never closed looks like after a terminal has parsed it. The sequence is gone by then, consumed into cell attributes, so nothing in the row's text reveals it; what remains is style on cells the row never wrote to, and on the rows after it. The effect is a stripe of background across the blank side of a row, or a coloured shell prompt once the process exits.

Style reaches the oracles through `ComposerOracleFrameState.styledColumns`, which lists the columns of each screen row whose cell carries a non-default background, foreground or underline, read from the emulator's cell grid. `rawViewportLines` is named for a byte stream it does not hold under this harness: the Ghostty-backed test terminal reconstructs each row from its cells, so those rows are the same text as `viewportLines` and contain no escape sequence at all. The padding oracle's background clause read them for an SGR fill and therefore judged a property no mount could express, which is the blind-oracle class one layer down from the subject check: the rows were there, and the attribute was not. It now reads both, and `every-composer-oracle-inspects-real-frame-data.test.ts` pins that a real mount carries styled cells and carries no escape sequence, so a style readback that breaks again is named instead of passing on absence.

Most of these oracles evaluate the terminal grid produced by the emitter. Three of them (padding transparency, hairline placement, and footer height against the segment ledger) read a segment ledger that `packages/coding-agent/test/helpers/composer-oracle-runner.ts` builds by walking the tui's own root children and re-rendering each one to count its rows. The membership and order are the mount's, not a second copy of them: an earlier version restated `mountComposerZone`'s eleven `addChild` calls and stood in fresh `CardPadRow` and `Spacer` instances for the ones the mount had created, so a change to the zone's composition left those three oracles judging a frame that was never painted. A fabricated fallback ledger sat under it for the case of an empty walk, which cannot happen and would have handed every segment-reading oracle eight invented rows. `packages/coding-agent/test/every-composer-oracle-inspects-real-frame-data.test.ts` cross-checks the ledger total against `TUI.composedFrameRows`, so the ledger cannot drift from the composed frame unnoticed.

## Registry

`COMPOSER_ORACLES` in `packages/coding-agent/src/modes/components/composer-defect-oracle.ts` is a `Record` keyed by `ComposerOracleGuarantee`. A guarantee id without an entry and an entry without an id are both compile errors. Before it, the module carried three hand-maintained parallel lists with nothing linking them: the id tuple, the array of check functions inside the evaluator, and the `Guarantee N` numbering in the doc comments.

Each entry declares `appliesTo`, which decides whether the guarantee is meaningful for a state, and `subject`, which states what the check will read. `evaluateAllComposerOracles` sorts every guarantee into one of three outcomes per state:

- `skipped`: `appliesTo` rejected the state. These predicates are the guards that used to sit at the top of each check body as an early `return null`, indistinguishable from a pass.
- `blind`: the guarantee applies and the subject is empty, so the check would read nothing. Two defects in this module were exactly this. The padding oracle mapped a footer segment through the content formula and landed past the bottom of the viewport, so its range guard dropped every row it meant to judge; the bleed oracle looked for a transcript marker that five of the six row flavours never carry. Neither failed anything.
- `inspected`: the check read a non-empty subject and returned a verdict.

`passed` remains true when nothing failed, so it still hides a blind oracle. The suites read the three arrays instead. `packages/coding-agent/test/an-oracle-either-judges-a-state-or-declares-it-out-of-scope.test.ts` asserts the three sets partition every guarantee in every state, that every guarantee is inspected somewhere in its matrix, that the set of ever-blind guarantees is exactly the two bleed oracles a transcript-less state cannot supply, and that no skip hides a failure the check would have reported.

## Sweep

`packages/coding-agent/test/composer-defect-sweep.test.ts` mounts the cross product of 15 mode variants, 5 widths, 5 heights, 3 transcript depths and 7 text variants: 7875 states. Each state mounts through the real `mountComposerZone`, settles through `settleFrames`, and is judged against all 12 oracles. The mode axis is derived: `ACCENT_CANON` is a `Required<ComposerAccentState>`, so a field added to the accent state without a value there does not compile, and one variant is generated per boolean flag, one per `ThinkingLevel` member, plus a session accent and the default. The sweep drives the whole space in one pass and then makes four separate claims about it, so a failure in one does not mask another: no oracle failed, every guarantee was inspected somewhere, the ever-blind set is exactly the three guarantees a state in this space can fail to supply, and every guarantee is accounted for in every state.

Three guarantees reach a blind state in that space, pinned by exact equality. The two bleed oracles read the rows carrying a transcript marker, and a state with a depth of zero paints none. The padding oracle reads the screen rows its `CardPadRow` segments land on, and a four-row terminal paints only the footer's tail, leaving the input's breathing rows off screen.

The sweep settles one frame per state, so a defect that appears only in the transition between two frames is out of its reach. `packages/coding-agent/test/a-repaint-never-leaves-a-second-composer-behind.test.ts` covers two transitions: a sequence of terminal geometries, which forces a full repaint of the composer zone, and appending to the transcript, which grows the frame under a pinned footer and takes the incremental paint path. It re-reads the grid after every step and counts hairline rows, prompt rows and paints of the newest appended line. The transcript double returns a fresh array per render, because a component that hands the engine its own mutable buffer rewrites the rows the engine cached as the previous frame, and the diff then skips a repaint it needed. Randomized operation sequences and failure reduction stay in `packages/tui/test/render-stress-harness.ts`.

A frame row becomes a screen row through `screenRowForSegment`. The pinned footer is painted at the bottom of the screen whatever the transcript is doing, so a footer segment is located from the footer's own top row; content above it scrolls, so a content segment is located from the frozen slice's top row while the view is scrolled back and from the live window's top row otherwise. The mapping was `segment.startIndex - windowTopRow`, which is only the live-tail content mapping, and applying it to a footer segment while the view was frozen was wrong in two directions. A frame overflowing the viewport by a few rows mapped a padding row onto a footer row, so the padding oracle read the capability line and failed a correctly painted state; the sweep steered around that by deriving `scrollOffset` as `transcriptCount > height ? 2 : 0`. A frame overflowing by more than a screen mapped the padding row past the end of the viewport, where the bounds check dropped it, so every deeply scrolled-back state had no padding coverage at all. `packages/coding-agent/test/a-frozen-view-maps-every-segment-to-the-row-it-paints-on.test.ts` sweeps both bands across three heights, six transcript depths, four scroll offsets and both isolation settings, and separates the two claims into their own tests so a mapping that breaks both is observed breaking both.

## Transitions

`packages/coding-agent/test/every-oracle-holds-across-a-transition-not-just-a-mount.test.ts` drives `Op` sequences from `test/helpers/renderer-differential.ts` and judges every guarantee after each step, over the cross product of geometries, row flavours, timings, scroll isolation and accent states. The sequence appends, edits the composer, freezes the view, resizes while frozen, returns to the tail, shrinks, and opens and closes an overlay. A frame with an overlay over the composer is out of the oracles' scope, because the modal composites over the rows they judge; those steps are counted and pinned rather than evaluated, and the overlay's own frame is covered by `an-overlay-that-comes-and-goes-leaves-the-frame-as-it-was.test.ts`.

`captureComposerFrameState` in the runner is the one reader of a painted frame. A caller that drives operations after the mount calls `RunnerResult.recapture()`, which re-reads the grid, rebuilds the ledger and re-judges. The transition suite once carried its own copy of that extraction, indexing `tui.children` by position and hardcoding the eleven names, which made it judge a model of the composer that would diverge from the runner's on the first change to either. Geometry and wheel notches live on `RunnerResult.captureContext`, so a resize or a scroll updates the context that the next capture reads.

## Committed cases

A case is written to `packages/coding-agent/test/corpus/renderer-defect-oracle/<id>.json`, where the id is a SHA-256 of the normalized state, the oracle and the kind, truncated to 16 hex characters. The directory is tracked, and `packages/coding-agent/test/a-committed-case-still-reproduces-what-it-recorded.test.ts` replays every file in it. It was gitignored, and nothing read a case back: 4720 files from defects since fixed had accumulated on one machine, reproducing nothing for anybody else. The sweep records one case per failing oracle rather than one per state, because a single defect fails thousands of the swept states and a corpus of thousands of copies of it is a dump.

A case records what the oracle did with the state, in `kind`. `failed` is a wrong answer. `blind` is no answer: the oracle applied and read nothing, which is the shape both defects found in this module had, and which a corpus that could only record a failure could not hold. `status` is `recorded` for an open defect, `resolved` for a fixed one the case now guards, or `exempted` with a reason. The replay suite maps each status and kind pair to the verdict it claims through a `Record` over both unions, so a new status or kind does not compile until somebody states what a replay of it has to show. A `resolved` case is the strict one: the oracle has to be in `inspected`, so a fix that consists of the oracle quietly ceasing to apply does not pass for one.

`loadCorpusCase` validates rather than trusts. A stale `schemaVersion`, an unknown status or kind, an exemption with no reason, an oracle no longer in `COMPOSER_ORACLE_GUARANTEES`, or a state edited without recomputing the id is rejected with the corrective action, because a case replayed under the wrong shape reports success for a scenario nobody recorded. Re-promoting a case that is already on disk keeps its status, its reason and the timestamp it was first seen, so running the sweep again does not rewrite a committed file.

Each case records `template`, `seed`, `state`, `oracle`, `kind`, `message` and `observedGrid`. `runnerOptionsToCorpusState` and `corpusStateToRunnerOptions` in `packages/coding-agent/test/helpers/renderer-defect-corpus.ts` are the one implementation of that round trip; a second divergent copy lived in the runner and flattened an explicit transcript array to a row count, which wrote cases that replay as a different scenario. `CORPUS_EXCLUDED_OPTION_KEYS` names the only key that cannot survive serialisation, `customParts`, whose values are live component factories. `every-composer-oracle-inspects-real-frame-data.test.ts` pins the dropped set by exact equality, so an option the sweep varies and the mapping omits fails the suite.

`replayCorpusCase` mounts a case state and re-evaluates every oracle. `packages/coding-agent/test/a-failing-state-replays-into-the-same-verdict.test.ts` proves the replay is faithful over a matrix of option combinations by comparing the verdict, the failure list, the geometry and the viewport rows against the original mount, and does it for a state that genuinely fails an oracle rather than only for clean ones.

## Exclusions

The oracles measure character grid cell placement and line boundaries. They do not evaluate color values, styling attributes, image protocol placement, or terminal emulator implementations outside Ghostty WASM.
