# TUI core renderer: the append-only contract

What you are dealing with before you touch the rendering engine. This is the
companion to [`tui-runtime-internals.md`](./tui-runtime-internals.md): that doc
maps the *flow* (input → component tree → render); this doc explains the
**render contract, why it is shaped this way, and the invariants you must not
violate**. Scope is the core engine only:

- [`packages/tui/src/tui.ts`](../../packages/tui/src/tui.ts): frame pipeline, commit ledger, window math, emitters, cursor placement.
- [`packages/tui/src/terminal.ts`](../../packages/tui/src/terminal.ts): `ProcessTerminal`, capability probes, private-CSI reassembly.
- [`packages/tui/src/terminal-capabilities.ts`](../../packages/tui/src/terminal-capabilities.ts): `TERMINAL` profile, sync-output / DECCARA / image detection.
- [`packages/tui/src/stdin-buffer.ts`](../../packages/tui/src/stdin-buffer.ts): escape-sequence reassembly.
- [`packages/tui/src/utils.ts`](../../packages/tui/src/utils.ts): width/slice/wrap (the width model).
- [`packages/tui/src/kitty-graphics.ts`](../../packages/tui/src/kitty-graphics.ts) + [`components/image.ts`](../../packages/tui/src/components/image.ts): inline images.
- [`packages/tui/src/deccara.ts`](../../packages/tui/src/deccara.ts): rectangular-fill optimizer.

Application-layer renderers (transcript, tool calls, session tree, editor,
widgets) are **out of scope**, they live in `packages/coding-agent`. The one
app-layer file that is load-bearing for this contract is
[`transcript-container.ts`](../../packages/coding-agent/src/modes/components/transcript-container.ts),
which implements the commit-boundary seam described below.

---

## 1. The one thing to understand first

> **The renderer cannot observe the terminal's scroll position** (ConPTY's
> probe lies; POSIX has no API at all). The previous engine tried to *guess*
> when it was safe to rewrite native scrollback, and every policy choice over
> that unobservable variable traded one failure family for another (yank ↔
> flash ↔ corruption ↔ invisible-until-resize: see the git history of this
> file for the full war journal). The current engine removes the guess
> entirely: **native scrollback is append-only.**

We keep the transcript on the **normal screen** (native scrollback, native
selection, transcript persists after exit). The engine maintains one ledger:

- **`committedRows` (C)**: frame rows `[0, C)` have been physically scrolled
  into terminal history. They are **immutable**: the engine never rewrites
  them, and components must never change them.
- **`windowTopRow` (W)**: the frame row mapped to grid row 0. The visible
  window is frame rows `[W, W + height)`, repainted in place with relative
  cursor moves.
- **live-region boundary**: reported by the component tree per frame
  (`NativeScrollbackLiveRegion.getNativeScrollbackLiveRegionStart()`), a single
  frame-row index. Rows above the boundary are declared **FINAL**, byte-stable
  at the current width for the component's lifetime, and commit as exact,
  **audited** content. Rows at/after the boundary repaint in place inside the
  window; when they scroll above the window top they *still commit* (the tape
  records what was on screen) but as **frozen visual snapshots** that are
  audit-exempt while their source stays live, later drift of the source never
  re-anchors or recommits them mid-run.

Per ordinary frame: `W = max(C, L − height)` and the only bytes that ever touch
history are the **chunk** `frame[C, C')` written at the scrollback seam. The
engine also tracks **`#committedPrefixAuditRows` (A ≤ C)**, rows in `[0, A)`
are HARD-VERIFIED exact-final bytes; rows in `[A, C)` are the frozen snapshots.
When the boundary later rises past a frozen snapshot (the block finalized), it
is strict-scanned exactly once: unchanged rows join the verified zone; a
divergence re-anchors so the final content lands in history correctly, via an
erase-and-replay rebuild where enabled, else by recommitting below the stale
snapshot (duplication, never loss). Scrollback therefore equals `frame[0..C)`,
every row exactly once, in order, with its content at commit time. There is
nothing to guess, nothing to defer, and nothing to reconcile: the scroll
position is irrelevant because ordinary updates never rewrite anything a
scrolled reader could be looking at.

### What this costs (the accepted tradeoffs)

- A block that has scrolled past the window top cannot reflow in place. A
  still-live block's scrolled-off rows commit as frozen snapshots, so a late
  layout change of an already-committed row is a frozen stale row in history
  (repaired by the one-time strict scan at finalization, rebuild or
  duplication, never loss), not a dropped row.
- A component tree that reports **no seam** gets shell semantics: whatever
  scrolls off is final. Shrinking such a frame into its committed prefix
  re-anchors the window and leaves the stale copy in history (§3).
- Inside multiplexers, a resize leaves the pane history wrapped at the old
  width (same as any shell output).

---

## 2. The frame pipeline (what you are editing)

`#doRender` per frame:

0. **Two branches return early, before anything is composed.** Alt-screen
   residency is resolved first: a fullscreen overlay BORROWS the buffer
   (`#renderAltFrame`, full mouse-tracking set) and the `alt-arrows` transport
   RESIDES on it (§11a). Then the non-multiplexer resize fast path
   (`#renderResizeViewport`) paints the viewport only while a drag is in
   flight; it is state-isolated and consumes no commit, window, or
   forced-render flag, so the settle's authoritative full paint reconciles as
   if those frames never ran.
1. Compose the frame (`render(width)`), collecting `liveRegionStart` from the
   root children (absolute row indices; the topmost reporter wins).
2. **Audit the committed prefix** (`findCommittedPrefixResync`, skipped on
   geometry frames and on `clearScrollback` frames). Components must never
   re-layout declared-final rows, but real flows violate it (a TTSR rewind
   truncating a streamed block, an image-cap demotion shrinking a committed
   image) and the violation must not become content loss. The verified zone's
   check samples the prefix *tail* (up to 8 non-blank rows in the last 24
   verified rows, SGR-stripped): an in-place edit or restyle disturbs only the
   touched rows (≤1 mismatch ⇒ aligned ⇒ ignored, stale styling in history is
   the accepted artifact), while any insertion/deletion shifts every row below
   it including the tail (⇒ re-anchor at the first changed row). Frozen
   snapshots past the verified zone are exempt while live and hard-scanned in
   full, once, when the boundary rises past them. A re-anchor repairs history
   by **erase-and-replay rebuild** (`divergenceRebuild`, on by default,
   `tui.scrollbackRebuild`, non-multiplexer) so history holds the content
   exactly once, else by recommitting from the changed row, **duplication,
   never loss**.
3. Classify: **fullPaint** (first paint, `clearScrollback` session replace, a
   geometry change on a terminal that does not repaint resizes in place, or
   the divergence rebuild) or **update**. `resizeRepaintsInPlace()` is what
   excuses a terminal from the geometry rebuild: multiplexer panes, and
   terminals that re-report their size on alt-screen toggles (Warp, or
   `VEYYON_TUI_RESIZE_IN_PLACE=1`).
4. Window math as in §1. Two special rules:
   - **Commits freeze** (`C' = C`) while an overlay is visible, and on a
     geometry frame: composited rows must never enter history, and a resizing
     multiplexer pane keeps its own old-wrap history (the audit prefix
     re-slices at the new width so the accepted wrap drift is not read as a
     violation). The hidden gap backfills via the chunk on a later frame.
   - **Tail re-anchor**, on either of two triggers: the frame shrank into the
     committed prefix (`L ≤ C`), or the live tail below the boundary no longer
     fills the viewport while a cursor marker sits in it. Both re-anchor
     `W = max(0, L − height)` and reset `C = W` (the audit mark re-bases to
     `min(C, B)` after the emit), keeping the stale history above, with no
     gesture and no erase.
5. Cursor markers were stripped at compose time into `#frameCursorMarkers`
   (they never reach the terminal, the prefix ledger, or the audit); pick the
   bottom-most marker at or below the window top, prepare lines (width fitting,
   `#prepareFrame`), slice the window (or, while a frozen scroll-isolation view
   is up, assemble it from the scroll snapshot above the live footer, §11),
   then composite overlays **into the window slice only** (screen
   coordinates, an overlay never touches the frame or the ledger).
6. Emit:

| Emitter | Bytes | When |
|---|---|---|
| `#emitFullPaint` | with `clearScrollback`, home + ED3, then `frame[0, C')` + window rows; otherwise kitty's ED22 (where supported) + ED2 + home ahead of the same replay | gestures, plus the default-on divergence rebuild |
| `#emitUpdate` scroll-append | `\r\n` + new bottom rows + changed-row range | the rows leaving the screen are exactly the chunk, the previous window's top rows still hold that content, and nothing forced a rewrite |
| `#emitUpdate` in-window diff | relative move + changed-row range rewrite | nothing commits: cursor-only when nothing changed, and a top-clamped whole-window rewrite when the window slid without committing, an overlay is up, a frozen view repaints, or an in-place resize forced it |
| `#emitUpdate` seam rewrite | chunk rows + full window rewrite | a commit advance the scroll-append shape cannot carry: the hidden-gap backfill after an overlay closes, a chunk that is not exactly the scroll distance, a previous window whose top rows no longer match, or a forced rewrite |
| `#emitAltFrame` | per-row viewport rewrite on the alternate screen | a fullscreen overlay's borrow, and every frame of the `alt-arrows` transport; never ED3, append-tail, or any native-scrollback byte |

**ED3 (`CSI 3 J`) is emitted in exactly one place**, `#emitFullPaint` with
`clearScrollback: true`, reached by user gestures: session
replace/branch/resume (`requestRender(true, { clearScrollback: true })`),
a resize that takes the geometry rebuild, `resetDisplay()` (the
`app.display.reset` binding, Ctrl+L by default); plus, when the scrollback
rebuild is enabled (`tui.scrollbackRebuild`, on by default), the
`divergenceRebuild` repair path on non-multiplexer terminals (committed
history diverged from the frame, erase and replay so history holds the
content exactly once instead of a duplicated block). It clears native
history without `ED2` first; the replay overwrites every row from home so
terminals without synchronized output do not expose a blank viewport. A gesture
pins the user to the tail, so the history snap is acceptable; multiplexers never
get ED3 (it is a no-op there and a replay would duplicate pane history). A full
paint that does NOT clear scrollback takes the other branch and blanks the
viewport with ED2, preceded by kitty's ED22 where the terminal supports it.

The ordinary update path never emits ED2/ED3 or an absolute cursor home,
several terminal families snap a scrolled reader to the bottom on those.

### The commit-boundary seam (the load-bearing app contract)

`NativeScrollbackLiveRegion` (tui.ts) is how a component keeps mutable rows out
of the audited history. The interface is a **single method**:

- `getNativeScrollbackLiveRegionStart()`: first row that may still mutate
  (everything below it, including root chrome rendered after it, stays in the
  window). Rows above it are declared FINAL and commit as exact, audited
  content. When several root children report a seam in one frame, the topmost
  boundary wins.

There is no component-reported deeper boundary: the engine itself guarantees
no loss, because live rows that scroll above the window top commit as frozen,
audit-exempt visual snapshots, then get their one-time strict scan when the
boundary rises past them (§1). Adjacent engine hooks components may implement:

- `NativeScrollbackCommittedRows.setNativeScrollbackCommittedRows(rows)`: the
  engine pushes each child's committed-row count down after commits, letting
  the child drop or seal content it no longer needs to re-render.
- `NativeScrollbackReplay.prepareNativeScrollbackReplay()`: a component that
  discards rows after they enter scrollback rehydrates its complete frame here
  before a destructive full replay.
- the **render-stability report**: a component that mutates its returned
  render array in place reports how many leading rows are byte-identical since
  the last read, letting the engine skip marker extraction, line preparation,
  and the committed-prefix audit for that prefix. Reading consumes the report
  (the baseline re-bases), so out-of-band `render()` calls can only lower it.

`TranscriptContainer` implements the seam for the coding agent. The live region
is anchored at the first still-mutating block
(`isTranscriptBlockFinalized?.() === false`), extended past that block's own
declared-settled prefix: `getTranscriptBlockSettledRows()` lets a live block
publish leading rows whose bytes provably cannot change yet, so a long
streaming reply's scrolled-off head reaches history mid-stream instead of
waiting for the block to finalize. Displaceable snapshot blocks (todo/poll
cards, `isDisplaceableBlock`) are sealed in place once their rows have entered
the tape, because an unfinalized block would otherwise pin the seam open for
the rest of the turn.

The freeze is not a per-terminal optimization, but it is not unconditional
either: a finalized block replays its previous rows without calling `render()`
only while they sit **wholly inside** the committed prefix at the same width,
generation and content version, and only when the bytes were themselves
produced by a finalized render. A finalized block that is not yet fully
committed keeps rendering normally, so late results, post-finalize re-layouts
and expand toggles stay visible; a post-finalize mutation bumps
`getTranscriptBlockVersion()` precisely so the render happens and the audit can
see it.

---

## 3. Invariants: MUST / NEVER

1. **NEVER add a new `CSI 3 J` (ED3) callsite.** ED3 flows only through
   `#emitFullPaint({ clearScrollback: true })`, gestures and the default-on
   divergence rebuild, never inside multiplexers.
2. **NEVER rewrite a committed row from the update path.** No `#emitUpdate`
   shape may touch frame rows `< C`, and `W ≥ C` always (re-showing a
   committed row on the grid duplicates it for a scrolling reader, the
   historical corruption family). The tail re-anchor is the one place the
   window drops below the old boundary, and it lowers `C` to the new `W` first
   rather than painting under it. The gesture full paint replays `[0, C')`
   from home by design, and is not covered by this rule. When a *component*
   violates immutability, the audit (§2) degrades to a rebuild or to
   duplication, never silently skip rows, never erase history.
3. **Commits are exactly the chunk.** Any byte shape that scrolls the screen
   must scroll *only* rows accounted for by `C' − C`, that is what makes
   scrollback provably `frame[0..C)`.
4. **NEVER probe the viewport position or fork on platform in the update
   path.** win32 behaves like POSIX. The probe APIs are gone; do not
   reintroduce them. The only platform forks left are ConPTY-scoped and sit
   outside the update byte shape: `#truncateLargeConptyFrame` bounds an
   oversized full-paint replay, and `#armPostFullPaintSettle` delays the frames
   just after one.
5. **Mutable content stays below the commit boundary.** App-layer renderers
   must finalize-before-commit; the engine trusts B when it decides what to
   commit and only clamps it into the frame. Content is verified after the
   fact, not at commit time: the next ordinary frame's committed-prefix audit
   hard-scans the newly-final span and samples the verified zone, and a
   divergence repairs rather than drops.
6. **Park the hardware cursor at real content bottom**, not the padded window
   bottom, or height shrinks scroll live rows into history and duplicate them
   per resize step.
7. **Cursor writes live inside the synchronized-output frame**, before ESU:
   never as a second frame after it.
8. **NEVER throw in the render hot path.** Clamp over-wide lines
   (`truncateToWidth`); a width mismatch is cosmetic, not fatal.
9. **No destructive clear and no history rewrap on resize where the terminal
   repaints in place** (`resizeRepaintsInPlace()`: multiplexer panes, and
   terminals that re-report size on alt-screen toggles): repaint the window in
   place; committed history keeps its old wrap.
10. **Any change to the ledger math, the emitters, or the seam must be
    validated by the stress harness (§6)** across its full scenario matrix,
    not by a single-terminal smoke test.

---

## 4. Terminal capability detection

`TERMINAL` (`terminal-capabilities.ts`) is resolved once at import from
`TERMINAL_ID` plus environment sniffing; detection helpers are pure over
`(env, platform)` and unit-testable.

- `shouldEnableSynchronizedOutputByDefault(env, id)` → DEC 2026 default.
  Precedence: user opt-out (`VEYYON_NO_SYNC_OUTPUT`/`VEYYON_TUI_SYNC_OUTPUT=0`) → user
  force-on (`VEYYON_FORCE_SYNC_OUTPUT=1`/`VEYYON_TUI_SYNC_OUTPUT=1`) → `TERM_FEATURES`
  advertises `Sy` → `WT_SESSION` → off inside a risky multiplexer → known
  direct terminals → off for everything else. The multiplexer test sits
  *ahead* of the terminal list on purpose: an inner terminal id leaking through
  tmux/screen/zellij does not turn sync output on. Reconciled at runtime by the
  DECRQM mode-2026 report, in both directions; a user override still wins.
- `detectRectangularSgrSupport(id, env)` → DECCARA fills: kitty only, off in
  multiplexers and under `VEYYON_NO_DECCARA`. `TERMINAL.deccara` additionally
  forces off inside the bun test runtime, and the emitters gate fills on
  synchronized output being live.
- `supportsScreenToScrollback` → kitty's ED22, emitted by every full paint that
  does NOT clear scrollback (the first paint, and any non-clearing gesture
  paint), immediately before the ED2 that blanks the viewport, so the screen it
  replaces is pushed into history rather than discarded.

The old ED3-risk classifier (`eagerEraseScrollbackRisk`, `VEYYON_TUI_ED3_SAFE`,
`submitPinsViewportToTail`) is gone: behavior no longer depends on which
terminal is rendering, so there is no risk class to detect. Env sniffing now
only selects *optimizations* (sync output, DECCARA, images), where a miss is
cosmetic, not corrupting.

---

## 5. Width model

`visibleWidth` / `truncateToWidth` / `sliceByColumn` / `wrapTextWithAnsi`
(`utils.ts`) all agree on **one UAX#11 width model**. Slicing, truncation,
wrapping, and segment extraction run on the native engine
(`@veyyon/natives`, Rust `unicode-width`); `visibleWidth` measures with
`Bun.stringWidth` **pinned to that same model** (`STRING_WIDTH_OPTS`:
`countAnsiEscapeCodes: false`, `ambiguousIsNarrow: true`), a JSC builtin that
shares the native width tables without the per-call N-API box the native
scanner traps on under Bun 1.3.x. The two must never disagree; mixing unpinned
width models in measure-vs-slice produced crashes.

- Fast path: printable ASCII is one cell per code unit.
- Anything past the ASCII prefix measures through `Bun.stringWidth` (CSI/OSC
  stripped to zero); tabs are added back at the fixed `DEFAULT_TAB_WIDTH` columns.
- OSC 66 sized spans are added back as `scale × (explicit w ?? payload width)`:
  `Bun.stringWidth` would otherwise strip the whole span to zero.
- Three mark classes are corrected because `Bun.stringWidth` charges cells for
  them and the native does not: five enclosing marks (U+0488, U+0489,
  U+A670..U+A672), a U+20E3 that is not completing a keycap sequence, and a
  U+FE0F with no visible base in front of it. A keycap is specifically
  base + U+FE0F + U+20E3, so `9` + U+20E3 is one cell, not two. The marks are
  removed from the text before it is measured rather than subtracted from the
  number afterwards, because the number can come from a string the marks were
  already stripped out of.
- Hangul Compatibility Jamo (U+3131..U+318E) is corrected the other way: its
  drawn width is decided by the client terminal, not by UAX#11.
  `Bun.stringWidth` charges every code point in the block 2 cells (including
  the U+3164 filler that `unicode-width` calls zero). `ProcessTerminal.start()`
  resolves the effective width from the terminal identity
  (`resolveHangulCompatibilityJamoWidthFromTerminalIdentity`: Ghostty is 2,
  everything else keeps the platform default, which is narrow on darwin and
  UAX#11 elsewhere) and pushes it into the native engine and this side through
  the single setter `setHangulCompatibilityJamoWidth`, so measure and cut move
  together. `correctHangulCompatibilityJamoWidth` then re-scores each jamo the
  same way the Rust side does, and never widens the filler past the narrow
  correction.
- `Bun.stringWidth` recognises only CSI and OSC, so three more escape families
  are stripped before measuring: two-byte Fe/Fs sequences (`ESC m`), nF
  character-set designators (`ESC ( B`), and the string sequences DCS, SOS, PM
  and APC with their payloads. Each drew nothing and was charged for its bytes.
  An **unterminated** introducer (`ESC [3`) stays at zero here and the native
  counts its bytes; that gap is the native's to close.
- An escape sequence is a **grapheme cluster break** in the native engine, and
  `Bun.stringWidth` is not: it deletes the escape and measures the two sides as
  one cluster, so `"9\x1b[0m️⃣"` is one cell natively and two to Bun.
  Mark-bearing text is therefore measured one escape-separated run at a time and
  the widths summed. Text with no such mark keeps the single whole-string call.
  An OSC sequence is stripped before that split ever runs, so it leaves a
  zero-width `ESC \` behind rather than being deleted: without the marker the
  strip joins the text around it and the join can invent a cluster the terminal
  never drew.
- A tab is charged to the text that draws it. Tabs inside an OSC sequence draw
  nothing, and a tab inside an OSC 66 text-sizing payload scales with its span
  like every other cell in it.
- OSC 66 metadata (`s=` scale, `w=` declared width) is a run of ASCII digits or
  it is not a number, which is the rule the native uses. `Number.parseInt` would
  accept `s=2x`, `w=+5` and `w= 5`, and reading those as numbers makes this side
  measure WIDER than the cut, which is the direction that overflows a line.
  `packages/tui/test/visible-width-osc66-spans.test.ts` pins every span shape
  against the native binding directly, including the malformed spans (an escape
  in the payload, or no terminator) where the two still differ and the native is
  the one to change.

These corrections exist for the same reason: `truncateToWidth` cuts on the native
engine and `visibleWidth` measures, so a disagreement means a span cut to fit `W`
re-measures wider than `W` and the caller that sized a viewport by the cut writes
past the last column. `packages/tui/test/visible-width-enclosing-marks.test.ts`
pins each mark correction and each deliberate non-correction.

**Rule:** any new measuring code routes through these helpers, and the hot
path clamps instead of throwing. Known residual: combining-heavy scripts
(Arabic harakat) survive painting verbatim, but ghostty-web's cell readback can
migrate non-spacing marks across cells, the stress harness compares those rows
with marks stripped (`sameLinesAllowingMarkDrift`).

---

## 6. The fidelity gate (use it)

`packages/tui/test/render-stress-harness.ts` drives the renderer's **real
emitted ANSI** into a ghostty-web `VirtualTerminal` across randomized op
sequences and parameterized terminal shapes, and validates the contract with a
**shadow commit ledger**: `#shadowTape` materializes what native scrollback
must contain, row by row, from observed frames (a `render` wrap) and observed
bytes (a `write` wrap). The commit *counter* is read straight from the engine
(`tui.committedRows`); the harness used to re-derive the window classification
and every re-derivation drifted a frame off the engine on some seed. Reading
the engine's claim is not trusting it, because the oracles check that claim
against the terminal: tape growth against ghostty's physical scroll count, and
the tape's bytes against the actual scrollback buffer.

Per op it asserts:

- the whole tape (scrollback + grid) equals `shadowTape + window slice`, row
  for row, including across resizes;
- scrolled readers stay pinned and visible history rows are never rewritten;
- multiplexer pane history grows by exactly the committed chunk;
- sync-output/autowrap bracket discipline, cursor parking, background columns,
  duplicate accounting.

`render-stress.test.ts` spawns each scenario in its own `bun` subprocess and is
**skipped when `CI` is set** (`SKIP_IN_CI`), so CI is not the thing that runs
it: you are. Run it locally, plus `render-regressions.test.ts`,
`streaming-scrollback-defer.test.ts`, and the `issue-*-repro.test.ts` files,
before changing ledger math, emitters, or the seam. A change that passes one
terminal and one seed is not verified.

---

## 7. Capability probes & stdin reassembly

`ProcessTerminal` fuses capability queries with a bare DA1 (`CSI c`) sentinel so
a non-answering terminal is detected when DA1 returns first. Replies can arrive
**split across a stdin flush**, so:

- `#privateCsiResponseBuffer` accumulates `\x1b[?…` partials while a sentinel is
  outstanding, rejoins on the terminator byte, then runs the handlers on the
  **complete** reply. A new `\x1b` mid-reassembly or >256 bytes abandons the
  partial so real keys still reach input.
- `#da1SentinelOwners` is a **typed FIFO** discriminated by `kind`
  (`keyboard`, `osc11`, `privateMode`, `osc99Probe`) so a keyboard DA1 cannot be
  mistaken for an OSC 11 background query, a DECRQM report, or the OSC 99
  notification-capability probe.
- DECRQM probes drive runtime feature gating: 2026 (synchronized output) gates
  the begin/end markers, 2048 (in-band resize) is enabled only once the terminal
  confirms it, 2031 (appearance change) drives mid-session theme tracking, and
  xterm 1010/1011 are probed so scroll-to-bottom-on-output can be turned off
  while veyyon owns the TTY.

**Rule:** any new probe must own a typed sentinel and survive a split reply
(feed the reply byte-by-byte in a test and assert nothing leaks to input).

---

## 8. Inline images & memory

Kitty images are **transmit-once, place-many**; the placeholder encoding lives
in `kitty-graphics.ts` and the delete escape in `terminal-capabilities.ts`
(`encodeKittyDeleteImage`). `ImageBudget` (`components/image.ts`) keeps only the
most-recent N images live; when the cap is exceeded the demoted image's pixels
are deleted by id (`a=d,d=I`) and its visible rows re-render as the text
fallback through the ordinary window diff, **no destructive replay**. A demoted
placement already committed to history simply loses its pixels (committed rows
are immutable), and the text fallback is **height-preserving** once a graphic
has rendered (reserved rows + fallback line), so demotion never shrinks the
block and never shifts committed content below it.

**Rule:** never re-emit full base64 per frame. Kitty Unicode placeholders are
default-on only for kitty/ghostty (`VEYYON_NO_KITTY_PLACEHOLDERS` /
`VEYYON_KITTY_PLACEHOLDERS`).

---

## 9. Escape hatches (env vars)

| Var | Effect |
|---|---|
| `VEYYON_NO_SYNC_OUTPUT=1` | Disable DEC 2026 BSU/ESU wrappers (autowrap discipline stays on). |
| `VEYYON_TUI_SYNC_OUTPUT=0\|1` / `VEYYON_FORCE_SYNC_OUTPUT=1` | Force sync output off / on. |
| `VEYYON_NO_DECCARA` | Disable Kitty DECCARA rectangular-fill optimization. |
| `VEYYON_FORCE_IMAGE_PROTOCOL=kitty\|iterm2\|sixel\|off` | Override image protocol detection. |
| `VEYYON_NO_KITTY_PLACEHOLDERS=1` / `VEYYON_KITTY_PLACEHOLDERS=1` | Force Kitty Unicode placeholders off / on. |
| `VEYYON_HARDWARE_CURSOR=1` | Show the real hardware cursor instead of a rendered one. |
| `VEYYON_NOTIFICATIONS=off\|0\|false` | Suppress terminal notifications. |
| `VEYYON_DEBUG_REDRAW=1` | Log the chosen render intent + ledger state per frame to the debug log. |
| `VEYYON_TUI_RESIZE_IN_PLACE=1\|0` | Force resize to repaint in place (no alt-screen borrow, no ED3 rewrap) on / off. Default-on for terminals that re-report size on alt-screen toggles (Warp). |

Removed with the old engine: `VEYYON_TUI_ED3_SAFE` (no ED3-risk lever exists),
`VEYYON_CLEAR_ON_SHRINK` (shrinks always clear exactly), `VEYYON_TUI_DEBUG` (per-render
dump superseded by `VEYYON_DEBUG_REDRAW` ledger logging and the stress harness
replay/reduce tooling).

---

## 10. Before you touch the render core: checklist

- [ ] Are you about to emit `CSI 3 J` anywhere other than
      `#emitFullPaint({ clearScrollback: true })`, reached from a gesture or the
      divergence rebuild? **Stop.**
- [ ] Could any code path rewrite, or re-show on the grid, a frame row below
      `committedRows`? **Stop.**
- [ ] Does your byte shape scroll rows that are not the commit chunk? That
      breaks `scrollback == frame[0..C)`.
- [ ] Are you adding a viewport probe, a platform fork, or a terminal-brand
      branch to the update path? The contract exists so none are needed.
- [ ] New mutable UI above the editor? It must report (or live inside) the
      live-region seam, or it will freeze at first commit.
- [ ] Did you run the stress harness and the repro suite across the full
      scenario matrix, not just one terminal and one seed?
- [ ] New probe? Typed sentinel owner + split-reply test.
- [ ] New width path? Routed through the shared native engine, clamped (never
      thrown) in the hot path.

## 11. Scroll isolation (virtual scroll over the append-only engine)

Native scrollback scrolling moves the whole window, composer included, so
reading history used to scroll the prompt off screen. Scroll isolation
(`TUI.setScrollIsolation`, surfaced as `tui.scrollIsolation`, default OFF)
changes the model to the opencode/grok-build one: the wheel scrolls the
transcript region while the pinned footer stays live at the viewport
bottom.

- **Pinned footer**: the host declares the last N root children as the
  footer (`setPinnedFooterChildCount`; the coding-agent passes the composer
  zone count returned by `mountComposerZone`). The engine derives the
  footer's row span from the compose segment ledger after every frame, so a
  zone height change never needs a host-side sync and the zone is never
  re-rendered for measurement (render side effects stay single-counted).
- **The scroll tape**: the composed frame is NOT the scroll-back source. A
  virtualized root (the coding agent's `TranscriptContainer`) drops rows from
  its render output once the engine reports them committed, which holds the
  frame near the viewport height however long the session runs. Every prepared
  row the engine lets scroll off is therefore recorded on `#scrollTape`
  (`scrollTapeRows`, bounded by `setScrollTapeCap`, default 20k rows), the
  engine's own mirror of terminal scrollback. The **scroll space** is the tape
  followed by the frame's uncommitted rows; the frame's row 0 sits at
  `tape.length − committedRows`, because those rows are on both.
- **Frozen view**: wheel-up anchors `#virtualScrollTop` in scroll-space rows.
  On the first frozen frame the engine snapshots the whole scroll space, so
  nothing under the reader can move: a quiet frame still compacts, and a
  live-frame-sourced view would slide by the dropped row count on every
  repaint. The transcript region reads the snapshot, the footer always reads
  the live frame, so the composer keeps typing and spinning while history holds
  still. Commits freeze (`chunkTo = committedRows`) because a chunk's scroll
  would tear the view; the held rows backfill exactly once through the ordinary
  seam rewrite on resume.
- **Position**: while frozen, the engine composites a one-column track into the
  right edge of the transcript region (dim groove, bright thumb, through the
  same cell-accurate compositor overlays use). It lives in the region that
  moved, which is what keeps the pinned footer byte-identical between the
  frozen and following states — the host's composer must never become a scroll
  readout (the selection notice below is where that pressure shows up).
- **Resume conditions**: wheel-down to the live tail, `scrollToLiveTail()`
  (the host calls it on submit), a left click anywhere in the pinned footer,
  any resize or full paint, and visible overlays (overlays own the window while
  shown). A rebuild that erases scrollback (`tui.scrollbackRebuild`, on by
  default) resets the tape with it: the tape mirrors the terminal and must
  never show rows the terminal no longer holds.
- **Input**: the engine captures SGR mouse reports with 1000h+1006h (button
  + extended coordinates), never 1003h, so idle pointer motion does not
  flood the input queue. Non-wheel reports are swallowed while isolation is
  active so clicks never leak raw SGR bytes into the focused component. The
  tracking set is re-armed after alt-screen exits and torn down on stop.
- **Capture gate**: tracking arms while anything sits above the window — the
  frame overflows the viewport, **or** the tape is non-empty. Gating on frame
  overflow alone (`d79cb7ee`, which traded it for drag-select on short screens)
  is what broke the model in practice: with a virtualized transcript the frame
  trims back to about the viewport on every quiet frame, so the gate closed,
  the wheel went to the terminal, and the composer scrolled off screen. A fresh
  session with no history still releases the mouse, so drag-select works until
  the first row scrolls off.
- **Tradeoff**: with the mouse captured, plain drag-select becomes
  Shift+drag (the standard convention in mouse-capturing TUIs). The setting
  documents this and can be switched off to return to native scrollback, which
  is why it now defaults OFF: the capture gate below made capture the normal
  state, and taking drag-select away from every operator by default is not a
  trade the product gets to make silently.
  The capture is permanent for as long as the setting is on. A time-boxed grab
  was tried (`#MOUSE_GRAB_IDLE_MS`, released after 3s of quiet) and reverted:
  releasing on a timer unpinned the composer at unpredictable moments and made
  whether a drag selected anything depend on how recently the operator had
  typed, which is a worse surface than a hold that is simply always on and
  documented. Do not reintroduce it without solving the unpinning.
  Documenting it is not enough on its own: after the capture gate above started
  arming on history rather than frame height, capture became the normal state
  and a drag that used to select text silently selected nothing.
  Tracking mode is 1000h — press and release,
  no motion reports — so the engine pairs a left press with its release and calls
  `onSelectionAttempt` when they land in different cells outside the footer. The
  engine keeps no "already told them" state; the coding agent owns the wording
  and the once-per-run policy in `modes/utils/selection-notice.ts`, and a tip
  gated on `tui.scrollIsolation` says the same thing before you hit it.

### 11a. The `alt-arrows` transport (selection and a pinned composer, both)

The tradeoff above is real on the normal screen and not on the alternate one.
xterm's Alternate Scroll Mode (`DECSET 1007`) has the terminal translate wheel
ticks into cursor-up/down **keys** while the alt buffer is displayed, so the
engine can scroll its own viewport with no mouse reporting at all. No grab means
plain drag-select keeps working, which is the property the mouse transport cannot
have. `TUI.setScrollTransport("alt-arrows")` selects it;
`VEYYON_TUI_SCROLL_TRANSPORT=alt-arrows` is the env door until it has a settings
entry.

- **Residency, not preference.** The mode is only honored while the alt buffer is
  up, so the transcript lives there. Alt-screen residency now has two reasons: a
  fullscreen overlay BORROWS the buffer (paints only the modal, grabs the full
  tracking set for hit-testing), while this transport RESIDES (paints the ordinary
  window, enables no tracking). A reason change while resident flips only the
  tracking set, because an overlay closing used to write `1049l` unconditionally
  and would drop the transcript back to the normal screen with 1007 still set.
- **The paint** is a full viewport rewrite of the window the frozen-region
  assembly already builds, so history-above-pinned-footer needs no second layout.
  The commit ledger still advances, but it means something different here: rows
  above the window top move onto the scroll tape and are reported committed, which
  is what lets the virtualized container drop them. The tape is the ONLY copy on
  this surface, not a mirror, so the prefix audit is skipped — nothing outside the
  process can hold us to bytes we already painted.
- **Which arrows are the wheel.** A synthesized tick is byte-identical to a typed
  arrow, so only the bare legacy forms (`CSI A`/`CSI B` and their `SS3`
  application-cursor twins) are read as scroll. Under the kitty keyboard protocol
  at a level that reports event types, a real keypress arrives as CSI-u with
  parameters and never matches, so the composer keeps its arrows. Without that
  protocol the two cannot be told apart and arrows scroll: the documented
  fallback, whose cost is that Up/Down stop moving the caret between lines of a
  multi-line draft. Nothing else is lost, because arrows drive no prompt-history
  walk in this host. A gesture the view cannot honor is not consumed, so a typed
  arrow still reaches the focused component instead of vanishing.
- **Exit replays the transcript** onto the normal screen (tape plus the live tail
  of the last resident paint), so terminal scrollback, the terminal's own find and
  tmux copy-mode can see the conversation afterwards. It is one-shot, since
  `stop()` is reachable from several teardown paths and a duplicated conversation
  in scrollback is what this must not look like. A crash cannot run it: the alt
  buffer restores whatever preceded launch and the transcript is then only in the
  session file.
- **Still open.** No settings entry yet (adding one regenerates
  `docs/settings-reference.md`, which currently carries unrelated pending schema
  changes), and the engine does not yet push a kitty level that guarantees event
  reporting, so terminals that support the protocol still take the fallback until
  it does. `test/scroll-transport-alt-arrows.test.ts` covers the transport,
  residency, classification, exit replay and the env door; it states the transport
  explicitly for the same reason the suites above state `setScrollbackRebuild`.

Regression coverage lives in two suites, and the split matters:
`test/scroll-isolation.test.ts` drives a transcript that returns its whole
history every frame, and `test/scroll-isolation-history.test.ts` drives one that
drops committed rows the way the real container does. Only the second one can
see this class of bug. Both state `setScrollbackRebuild(false)` explicitly, because
the rebuild is on by default and these suites assert the append-below history it
would otherwise erase. A third suite,
`packages/coding-agent/test/modes/components/transcript-scrollback-pinned-composer.test.ts`,
mounts the real container and the real shortcut bar together, so the host side of
the contract is proven too.

The track's dim groove is asserted two ways, because either alone can pass on a
broken render: the emitted bytes (`\x1b[0;2m│\x1b[22;0m`, and no dim on the
thumb) and the attributes the terminal presents, through
`VirtualTerminal#getViewportRowFaintColumns`. A byte assertion alone would still
pass if a later reset in the same row cancelled the dim.

*Verified against `19234e94d39e` on 2026-08-07.*
