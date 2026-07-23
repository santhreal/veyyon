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

1. Compose the frame (`render(width)`), collecting `liveRegionStart` from the
   root children (absolute row indices; the topmost reporter wins).
2. **Audit the committed prefix** (`findCommittedPrefixResync`, skipped on
   geometry frames). Components must never re-layout declared-final rows, but
   real flows violate it (a TTSR rewind truncating a streamed block, an
   image-cap demotion shrinking a committed image) and the violation must not
   become content loss. The verified zone's check samples the prefix *tail*
   (up to 8 non-blank rows in the last 24 verified rows, SGR-stripped): an
   in-place edit or restyle disturbs only the touched rows (≤1 mismatch ⇒
   aligned ⇒ ignored, stale styling in history is the accepted artifact),
   while any insertion/deletion shifts every row below it including the tail
   (⇒ re-anchor at the first changed row). Frozen snapshots past the verified
   zone are exempt while live and hard-scanned in full, once, when the
   boundary rises past them. A re-anchor repairs history by **erase-and-replay
   rebuild** (`divergenceRebuild`, opt-in `VEYYON_TUI_SCROLLBACK_REBUILD`,
   non-multiplexer) so history holds the content exactly once, else by
   recommitting from the changed row, **duplication, never loss**.
3. Classify: **fullPaint** (first paint, `clearScrollback` session replace, or
   geometry change outside a multiplexer, all user gestures) or **update**.
4. Window math as in §1. Two special rules:
   - **Overlays freeze commits** (`C' = C`): composited rows must never enter
     history; the hidden gap backfills via the chunk after the overlay closes.
   - **Shrink into the committed prefix** (`L ≤ C`): re-anchor
     `W = max(0, L − height)`, reset `C = min(B, W)`, keep the stale history
     above (no gesture, no erase).
5. Extract the cursor marker (strip-first: markers never reach the terminal,
   the prefix ledger, or the audit), prepare lines (width fitting), slice the
   window, composite overlays **into the window slice only** (screen
   coordinates, an overlay never touches the frame or the ledger).
6. Emit:

| Emitter | Bytes | When |
|---|---|---|
| `#emitFullPaint` | home + `frame[0, C')` + window rows; with `clearScrollback`, ED3 clears history without an ED2 viewport blank | gestures, plus the opt-in divergence rebuild |
| `#emitUpdate` scroll-append | `\r\n` + new bottom rows + changed-row range | the rows leaving the screen are exactly the chunk, content untouched since painted |
| `#emitUpdate` in-window diff | relative move + changed-row range rewrite | nothing scrolls, nothing commits (cursor-only when nothing changed) |
| `#emitUpdate` seam rewrite | chunk rows + full window rewrite | commit advance, window re-anchor, hidden-gap backfill, mux resize |

**ED3 (`CSI 3 J`) is emitted in exactly one place**, `#emitFullPaint` with
`clearScrollback: true`, reached by user gestures: session
replace/branch/resume (`requestRender(true, { clearScrollback: true })`),
resize outside a multiplexer, `resetDisplay()` (Ctrl+L); plus, when the
opt-in scrollback rebuild is enabled (`VEYYON_TUI_SCROLLBACK_REBUILD`), the
`divergenceRebuild` repair path on non-multiplexer terminals (committed
history diverged from the frame, erase and replay so history holds the
content exactly once instead of a duplicated block). It clears native
history without `ED2` first; the replay overwrites every row from home so
terminals without synchronized output do not expose a blank viewport. A gesture
pins the user to the tail, so the history snap is acceptable; multiplexers never
get ED3 (it is a no-op there and a replay would duplicate pane history).

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

`TranscriptContainer` implements the seam for the coding agent: finalized
blocks freeze (their render is snapshotted, so their content can never drift
after the engine may have committed it), the first still-mutating block
(`isTranscriptBlockFinalized?.() === false`) anchors the live region, and
displaceable snapshot blocks (todo/poll cards, `isDisplaceableBlock`) are
sealed in place once their rows have entered the tape.

Freezing is unconditional, it is the engine's required guarantee, not a
per-terminal optimization.

---

## 3. Invariants: MUST / NEVER

1. **NEVER add a new `CSI 3 J` (ED3) callsite.** ED3 flows only through
   `#emitFullPaint({ clearScrollback: true })`, gestures and the opt-in
   divergence rebuild, never inside multiplexers.
2. **NEVER rewrite a committed row.** No emitter may touch frame rows `< C`,
   and `W ≥ C` always (re-showing a committed row on the grid duplicates it
   for a scrolling reader, the historical corruption family). When a
   *component* violates immutability, the audit (§2) degrades to duplication,
   never silently skip rows, never erase history.
3. **Commits are exactly the chunk.** Any byte shape that scrolls the screen
   must scroll *only* rows accounted for by `C' − C`, that is what makes
   scrollback provably `frame[0..C)`.
4. **NEVER probe the viewport position or fork on platform in the update
   path.** win32 behaves like POSIX. The probe APIs are gone; do not
   reintroduce them.
5. **Mutable content stays below the commit boundary.** App-layer renderers
   must finalize-before-commit; the engine trusts B and clamps, it does not
   verify content.
6. **Park the hardware cursor at real content bottom**, not the padded window
   bottom, or height shrinks scroll live rows into history and duplicate them
   per resize step.
7. **Cursor writes live inside the synchronized-output frame**, before ESU:
   never as a second frame after it.
8. **NEVER throw in the render hot path.** Clamp over-wide lines
   (`truncateToWidth`); a width mismatch is cosmetic, not fatal.
9. **Multiplexers get no destructive clear and no history rewrap on resize**:
   repaint the window in place; pane history keeps its old wrap.
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
  advertises `Sy` → `WT_SESSION` → known direct terminals → off for risky
  multiplexers and unknowns. Reconciled at runtime by the DECRQM mode-2026
  report; a user override still wins.
- `detectRectangularSgrSupport(id, env)` → DECCARA fills: kitty only, off in
  multiplexers and under `VEYYON_NO_DECCARA`.
- `supportsScreenToScrollback` → kitty's ED22 (used once, on the initial
  paint, to preserve the pre-existing shell screen).

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
**shadow commit ledger**: an independent reimplementation of §1's math, fed
only by observed frames (a `render` wrap) and observed bytes (a `write` wrap).
Per op it asserts:

- the whole tape (scrollback + grid) equals `shadowTape + window slice`, row
  for row, including across resizes;
- scrolled readers stay pinned and visible history rows are never rewritten;
- multiplexer pane history grows by exactly the committed chunk;
- sync-output/autowrap bracket discipline, cursor parking, background columns,
  duplicate accounting.

Run it, plus `render-regressions.test.ts`,
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
- `#da1SentinelOwners` is a **typed FIFO** discriminated by `kind` so a
  keyboard DA1 cannot be mistaken for an OSC 11 / DECRQM / graphics-probe
  sentinel.
- DECRQM probes (2026/2048/2031) drive runtime feature gating.

**Rule:** any new probe must own a typed sentinel and survive a split reply
(feed the reply byte-by-byte in a test and assert nothing leaks to input).

---

## 8. Inline images & memory

Kitty images are **transmit-once, place-many** (`kitty-graphics.ts`).
`ImageBudget` keeps only the most-recent N images live; when the cap is
exceeded the demoted image's pixels are deleted by id (`a=d,d=I`) and its
visible rows re-render as the text fallback through the ordinary window diff,
**no destructive replay**. A demoted placement already committed to history
simply loses its pixels (committed rows are immutable), and the text fallback
is **height-preserving** once a graphic has rendered (reserved rows + fallback
line), so demotion never shrinks the block and never shifts committed content
below it.

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
| `VEYYON_TUI_SCROLLBACK_REBUILD=1\|true` | Opt into the `divergenceRebuild` repair: when committed history diverges from the frame on a non-multiplexer terminal, erase and replay history (ED3 full paint) so content lands exactly once, instead of recommitting below the stale copy. |

Removed with the old engine: `VEYYON_TUI_ED3_SAFE` (no ED3-risk lever exists),
`VEYYON_CLEAR_ON_SHRINK` (shrinks always clear exactly), `VEYYON_TUI_DEBUG` (per-render
dump superseded by `VEYYON_DEBUG_REDRAW` ledger logging and the stress harness
replay/reduce tooling).

---

## 10. Before you touch the render core: checklist

- [ ] Are you about to emit `CSI 3 J` anywhere other than the gesture-driven
      `clearScrollback` full paint? **Stop.**
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

*Verified against `d3e3db30` on 2026-07-23.*
