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

`passed` remains true when nothing failed, so it still hides a blind oracle. The suites read the three arrays instead. `packages/coding-agent/test/an-oracle-either-judges-a-state-or-declares-it-out-of-scope.test.ts` asserts the three sets partition every guarantee in every state, that every guarantee is inspected somewhere in its matrix, that the set of ever-blind guarantees is exactly the three a state in its matrix can fail to supply a subject for, and that no skip hides a failure the check would have reported. A blind verdict is explained rather than tolerated: a `REASONS` table maps each ever-blind guarantee to the geometry that accounts for it, read from the segment ledger rather than from the screen mapping under test.

`packages/coding-agent/test/composer-defect-oracle-mutation.test.ts` proves each guarantee can fail, through the evaluator rather than by calling a check directly, since an `appliesTo` that rejects its own defect's state reads as a pass. `DEFECTS` is a `Record` over the guarantee union, so an oracle with no way to fail does not compile, and the set of guarantees carrying a single crafted defect is pinned empty: a check states several ways to fail, and one craft exercises one of them. Each case also pins a phrase of the failure message, which is how a craft that fires on the wrong branch is caught. The one that mattered: a row of forty-one wide glyphs is forty-one characters and eighty-two columns, and a check counting characters passes it.

## Sweep

`packages/coding-agent/test/composer-defect-sweep.test.ts` mounts the cross product of 15 mode variants, 5 widths, 5 heights, 3 transcript depths and 7 text variants: 7875 states. Each state mounts through the real `mountComposerZone`, settles through `settleFrames`, and is judged against every oracle in the registry. The mode axis is the shared `ACCENT_VARIANTS`, described under Modes below. The sweep drives the whole space in one pass and then makes four separate claims about it, so a failure in one does not mask another: no oracle failed, every guarantee was inspected somewhere, the ever-blind set is exactly the three guarantees a state in this space can fail to supply, and every guarantee is accounted for in every state.

Three guarantees reach a blind state in that space, pinned by exact equality. The two bleed oracles read the rows carrying a transcript marker, and a state with a depth of zero paints none. The padding oracle reads the screen rows its `CardPadRow` segments land on, and a four-row terminal paints only the footer's tail, leaving the input's breathing rows off screen.

The sweep settles one frame per state, so a defect that appears only in the transition between two frames is out of its reach. `packages/coding-agent/test/a-repaint-never-leaves-a-second-composer-behind.test.ts` covers two transitions: a sequence of terminal geometries, which forces a full repaint of the composer zone, and appending to the transcript, which grows the frame under a pinned footer and takes the incremental paint path. It re-reads the grid after every step and counts hairline rows, prompt rows and paints of the newest appended line. The transcript double returns a fresh array per render, because a component that hands the engine its own mutable buffer rewrites the rows the engine cached as the previous frame, and the diff then skips a repaint it needed. Randomized operation sequences and failure reduction stay in `packages/tui/test/render-stress-harness.ts`.

A frame row becomes a screen row through `screenRowForSegment`. The pinned footer is painted at the bottom of the screen whatever the transcript is doing, so a footer segment is located from the footer's own top row; content above it scrolls, so a content segment is located from the frozen slice's top row while the view is scrolled back and from the live window's top row otherwise. The mapping was `segment.startIndex - windowTopRow`, which is only the live-tail content mapping, and applying it to a footer segment while the view was frozen was wrong in two directions. A frame overflowing the viewport by a few rows mapped a padding row onto a footer row, so the padding oracle read the capability line and failed a correctly painted state; the sweep steered around that by deriving `scrollOffset` as `transcriptCount > height ? 2 : 0`. A frame overflowing by more than a screen mapped the padding row past the end of the viewport, where the bounds check dropped it, so every deeply scrolled-back state had no padding coverage at all. `packages/coding-agent/test/a-frozen-view-maps-every-segment-to-the-row-it-paints-on.test.ts` sweeps both bands across three heights, six transcript depths, four scroll offsets and both isolation settings, and separates the two claims into their own tests so a mapping that breaks both is observed breaking both.

## Transitions

`packages/coding-agent/test/every-oracle-holds-across-a-transition-not-just-a-mount.test.ts` drives `Op` sequences from `test/helpers/renderer-differential.ts` and judges every guarantee after each step, over the cross product of geometries, row flavours, timings, scroll isolation and accent states. The sequence appends, edits the composer, freezes the view, resizes while frozen, returns to the tail, shrinks, and opens and closes an overlay. A frame with an overlay over the composer is out of the composer oracles' scope, because the modal composites over the rows they judge; those steps are counted and pinned rather than evaluated. The overlay's own frame is judged by the overlay registry below, and its restoration on close by `an-overlay-that-comes-and-goes-leaves-the-frame-as-it-was.test.ts`.

`captureComposerFrameState` in the runner is the one reader of a painted frame. A caller that drives operations after the mount calls `RunnerResult.recapture()`, which re-reads the grid, rebuilds the ledger and re-judges. The transition suite once carried its own copy of that extraction, indexing `tui.children` by position and hardcoding the eleven names, which made it judge a model of the composer that would diverge from the runner's on the first change to either. Geometry and wheel notches live on `RunnerResult.captureContext`, so a resize or a scroll updates the context that the next capture reads.

## Modes

The mode axis lives in `packages/coding-agent/test/helpers/renderer-differential.ts` and nowhere else. `ACCENT_CANON` is a `Required<ComposerAccentState>`, `ACCENT_FLAGS` filters it to the boolean fields, `THINKING_LEVELS` reads the enum, and `ACCENT_VARIANTS` derives one named variant per flag, one per thinking level, one session accent and the default: fifteen. `MODE_STATES`, which the meta-suite and the transition suite cycle, is those variants' states. The sweep derived its own fifteen from a private copy of that machinery while the helper exported a hand-written six, so two suites swept different mode spaces and neither could tell.

`AccentVariantName` names the variants as a union, including the template literal `` `thinking-${ThinkingLevel}` ``, so a table keyed by it is total: a new accent flag or a new thinking level does not compile until it has a row.

A defect sweep cannot see a mode that stopped painting, because a frame showing the default prompt is a well-formed frame. `packages/coding-agent/test/every-accent-mode-paints-the-prompt-it-declares.test.ts` mounts every variant and pins the prompt cell each one paints: the glyph, the packed foreground, and the faint, background, underline and italic bits. Six channels rather than colour alone, because a focused subagent faints the gutter instead of recolouring it, and a signature reading colour alone filed that mode as painting nothing until the faint bit was added.

Nine thinking levels share one prompt cell, so the suite records the set that renders as the default by exact equality instead of failing on it: those knobs tint the hidden border and the status line, which the harness replaces with a test component. Every variant outside that set has to paint a cell no other variant paints, which is what fails when two modes converge on one glyph. Under this harness only the prompt cell carries a mode, and the mode flags paint their glyph in the terminal's default foreground while the default prompt and a session accent carry a colour.

## Overlay oracles

`packages/coding-agent/src/modes/components/overlay-defect-oracle.ts` is a second registry, over `OverlayOracleGuarantee`, with the same three-outcome contract. It exists because the composer oracles declare an open overlay out of scope and nothing else judged the modal: one suite proves an overlay that comes and goes leaves the frame as it was, which says nothing about the frame while it is open.

Six guarantees: the block's rows paint contiguously, in order, at one column; every rendered line reaches the screen unless it was clipped at a viewport edge or covered by a card higher in the stack; the base frame survives outside the columns the cards claim; the painted block stays inside the viewport; a card that emits `CURSOR_MARKER` gets the caret at that cell; and where two cards claim the same cells, the screen shows the upper one.

The block is located from the overlay's own rendered lines rather than from the engine's layout arithmetic, which is private and which an oracle that recomputed would agree with when it was wrong. Two details of that locator are load-bearing. Each line is searched from the row after the previous match, because `indexOf` alone collapses a card whose lines repeat onto one row and reports a body painted on a single line as correct. And the base-preservation span is the union of the rectangles the cards claim, not of the rows they were located on: a row covered by a higher card is located nowhere and still owns its columns, so a span built from located rows reads the lower card's own text as base damage.

`packages/coding-agent/test/an-overlay-is-painted-where-its-own-lines-say-it-is.test.ts` drives forty-two arms of real `showOverlay` calls: nine anchors across three geometries, a card taller than the terminal clipped from either end, a margin with an offset, an offset large enough to need the clamp, two stacked cards, two half-overlapping cards, a card that asks for the caret, and a card hidden before the capture. `packages/coding-agent/test/every-overlay-oracle-can-fail-on-a-frame-that-earns-it.test.ts` is the crafted-defect suite, built the same way as the composer one.

A uniform shift of the whole block is the one thing the oracles cannot see, since every invariant they read moves with it. The sweep closes that with anchor-edge claims: with no margin and no offset, a left-anchored card starts in column zero, a right-anchored one ends at the terminal width, a top-anchored one starts in row zero and a bottom-anchored one ends on the last row. Shifting the compositor by one column or one row leaves every oracle green and turns those claims red, which is the record of why they are stated separately.

## Committed cases

A case is written to `packages/coding-agent/test/corpus/renderer-defect-oracle/<id>.json`, where the id is a SHA-256 of the family, the normalized state, the oracle and the kind, truncated to 16 hex characters. The directory is tracked, and `packages/coding-agent/test/a-committed-case-still-reproduces-what-it-recorded.test.ts` replays every file in it. It was gitignored, and nothing read a case back: 4720 files from defects since fixed had accumulated on one machine, reproducing nothing for anybody else. The sweep records one case per failing oracle rather than one per state, because a single defect fails thousands of the swept states and a corpus of thousands of copies of it is a dump.

One corpus holds both registries. `family` is `composer` or `overlay`; `CORPUS_FAMILIES` declares the axis and `CORPUS_FAMILY_GUARANTEES` maps each family to the guarantee list that owns its oracles. A composer case records a mount, an overlay case records the same mount plus the modals shown over it in `state.overlays`, and `replayCorpusFile` dispatches on the family so a case is replayed by the runner that recorded it. The replay suite requires at least one case per family, so adding a registry without a reproduction for it turns red. A second store per registry is how two copies of the round trip drift.

A case records what the oracle did with the state, in `kind`. `failed` is a wrong answer. `blind` is no answer: the oracle applied and read nothing, which is the shape both defects found in this module had, and which a corpus that could only record a failure could not hold. `status` is `recorded` for an open defect, `resolved` for a fixed one the case now guards, or `exempted` with a reason. The replay suite maps each status and kind pair to the verdict it claims through a `Record` over both unions, so a new status or kind does not compile until somebody states what a replay of it has to show. A `resolved` case is the strict one: the oracle has to be in `inspected`, so a fix that consists of the oracle quietly ceasing to apply does not pass for one.

`loadCorpusCase` validates rather than trusts. A stale `schemaVersion`, an unknown status or kind, an exemption with no reason, an unknown `family`, an oracle that is not a guarantee of its family's registry, an overlay case with no overlays, an overlay that records the `visible` option a file cannot hold, or a state edited without recomputing the id is rejected with the corrective action, because a case replayed under the wrong shape reports success for a scenario nobody recorded. Re-promoting a case that is already on disk keeps its status, its reason and the timestamp it was first seen, so running the sweep again does not rewrite a committed file.

Each case records `family`, `template`, `seed`, `state`, `oracle`, `kind`, `message` and `observedGrid`. `runnerOptionsToCorpusState` and `corpusStateToRunnerOptions` in `packages/coding-agent/test/helpers/renderer-defect-corpus.ts` are the one implementation of that round trip, with `overlaySpecsToCorpus` and `corpusStateToOverlaySpecs` extending it to the overlay axis; a second divergent copy lived in the runner and flattened an explicit transcript array to a row count, which wrote cases that replay as a different scenario. `CORPUS_EXCLUDED_OPTION_KEYS` names the only key that cannot survive serialisation, `customParts`, whose values are live component factories, and `CORPUS_EXCLUDED_OVERLAY_OPTION_KEYS` names its overlay counterpart, `visible`, which the runner controls through `hideBeforeCapture`. `every-composer-oracle-inspects-real-frame-data.test.ts` pins the dropped set by exact equality, so an option the sweep varies and the mapping omits fails the suite.

`replayCorpusCase` mounts a case state and re-evaluates every oracle. `packages/coding-agent/test/a-failing-state-replays-into-the-same-verdict.test.ts` proves the replay is faithful over a matrix of option combinations by comparing the verdict, the failure list, the geometry and the viewport rows against the original mount, and does it for a state that genuinely fails an oracle rather than only for clean ones.

## Exclusions

The oracles measure character grid cell placement, line boundaries, and the style attributes of the cells a row paints. They do not evaluate a colour against a theme token, image protocol placement, or terminal emulator implementations outside Ghostty WASM. A colour value is judged only where a mode's prompt cell is pinned, in the modes suite above.
