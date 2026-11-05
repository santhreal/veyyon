# TUI runtime internals

This document maps the non-theme runtime path from terminal input to rendered output in interactive mode. It focuses on behavior in `hosts/terminal/engine` and its integration from `packages/coding-agent` controllers.

> **Editing the rendering engine itself?** Read
> [`tui-core-renderer.md`](./tui-core-renderer.md) first: it documents the
> failure modes (yank / corruption / flash / width crashes) and the invariants
> the render planner, native-scrollback bookkeeping, and capability detection
> must not violate.

## Runtime layers and ownership

- **`hosts/terminal/engine` engine**: terminal lifecycle, stdin normalization, focus routing, render scheduling, differential painting, overlay composition, hardware cursor placement.
- **`packages/coding-agent` interactive mode**: builds component tree, binds editor callbacks and keymaps, reacts to agent/session events, and translates domain state (streaming, tool execution, retries, plan mode) into UI components.

Boundary rule: the TUI engine is message-agnostic. It only knows `Component.render(width)`, `handleInput(data)`, focus, and overlays. Agent semantics stay in interactive controllers.

## Implementation files

- [`packages/coding-agent/src/modes/terminal/interactive-mode.ts`](../../packages/coding-agent/src/modes/terminal/interactive-mode.ts)
- [`packages/coding-agent/src/modes/terminal/controllers/event-controller.ts`](../../packages/coding-agent/src/modes/terminal/controllers/event-controller.ts)
- [`packages/coding-agent/src/modes/terminal/controllers/input-controller.ts`](../../packages/coding-agent/src/modes/terminal/controllers/input-controller.ts)
- [`packages/coding-agent/src/modes/terminal/components/composer/custom-editor.ts`](../../packages/coding-agent/src/modes/terminal/components/composer/custom-editor.ts)
- [`hosts/terminal/engine/src/tui.ts`](../../hosts/terminal/engine/src/tui.ts)
- [`hosts/terminal/engine/src/terminal.ts`](../../hosts/terminal/engine/src/terminal.ts)
- [`hosts/terminal/engine/src/components/editor-component.ts`](../../hosts/terminal/engine/src/components/editor-component.ts)
- [`hosts/terminal/engine/src/stdin-buffer.ts`](../../hosts/terminal/engine/src/stdin-buffer.ts)
- [`hosts/terminal/engine/src/components/loader.ts`](../../hosts/terminal/engine/src/components/loader.ts)

## Boot and component tree assembly

`InteractiveMode` adopts the pre-painted `FirstFrame` (reusing `ui`, `hero`, `editor`, `editorContainer`, and `keybindings`) when available, or constructs `TUI(new ProcessTerminal(), settings.get("showHardwareCursor"))` and applies `tui.maxInlineImages` and Kitty text-sizing settings. It then creates persistent containers:

- `chatContainer` (a `TranscriptContainer`)
- `pendingMessagesContainer`
- `todoContainer`
- `agentContainer`
- `btwContainer`
- `omfgContainer`
- `errorBannerContainer`
- `modelCycleContainer` (ctrl+p model-role cycle chip track)
- a bottom-anchor fill (sinks the status + composer block to the viewport bottom on the home screen)

The composer zone below it mounts through `mountComposerZone()` (`components/composer/composer-chrome.ts`) in one fixed order:

- `statusContainer` (transient loaders; sits below the sticky todo/agent HUDs, above the editor)
- `statusLine` (hook statuses only; its quiet segments render in the footline below the composer)
- `hookWidgetContainerAbove`
- the composer hairline
- a `CardPadRow`, `editorContainer` (holds `CustomEditor`), and a second `CardPadRow`
- the quiet footline (`QuietZoneLine` over `StatusLineComponent.renderQuietLine()`: location and capability segments) and the composer shortcuts
- `hookWidgetContainerBelow`
- a bottom margin spacer

(All live containers except `chatContainer` and the plain hook/editor `Container`s are `AnchoredLiveContainer`s.) `init()` mounts any config warnings, then the top anchor fill and the hero (skipped under `startup.quiet`), then the transcript and live containers in the order above, pins the composer zone as the scroll-isolation footer, focuses the editor, and registers key handlers via `InputController`. When no `FirstFrame` painted, it then drops queued tty input, gates input until the first check phase, and starts the TUI; with one, `first-frame.ts` already started it. It then starts the presentation driver, re-syncs the anchor, pushes terminal title state, updates the editor border, and requests an ordinary render: the handover is a diff against the rows already on screen, not a forced repaint.
A forced render (`requestRender(true)`) queues a viewport repaint or explicit session replacement; it does **not** throw away previous-line history by default.

### Presentation access

`InteractiveMode.presentation` implements `PresentationContext` on the existing TUI,
editor, transcript builder and status component. Transcript patches retain fields
omitted from the patch. Removing a block already committed to native scrollback has
no effect.

`clearTranscript()` and `setTranscriptBlocks()` dispose removed components without
clearing completed-call history. A session-history rebuild resets that history.
A read group detached by a reset is not reused.

An explicit tool display replaces the card's local producer subscription. Expansion
and sealing retain that display. A subsequent raw tool update initializes a producer
for expanded output.

Standalone drivers render individual read cards through `ChatTranscriptBuilder`
with `groupReadEntries: false`; adopted interactive surfaces render grouped reads.

An adopted `TerminalPresentationDriver` attaches input notifications with `start()`
and detaches them with `stop()`; the interactive mode starts and stops the engine.
Stopping a standalone driver releases its card animation clocks even when the
engine is not running.
Standalone drivers start and stop their own engine. Adopted drivers leave interrupt,
exit and scroll gestures to the interactive controller, except cancellation of a
driver-created dialog.

Input notifications use a subscription snapshot in registration order. A subscriber
exception is logged without interrupting delivery to the remaining subscribers;
subscription changes take effect on the next event.

`setEditorComponent()` synchronizes the presentation callbacks after replacing the
editor. Engine and editor access uses the current host objects. `setStatusLine()`
updates the displayed snapshot without replacing the local status capabilities or
activity clock. `StatusLineComponent.setSource()` resumes reads from the selected
source.

## Terminal lifecycle and stdin normalization

`ProcessTerminal.start()`:

1. Enables raw mode and bracketed paste.
2. Enables window focus reporting (DECSET 1004) and resets the focus state to `unknown`.
3. Attaches resize handler and refreshes dimensions.
4. Enables Windows VT input mode when running on win32.
5. Creates a `StdinBuffer` (50ms flush timeout) to split partial escape chunks into complete sequences.
6. Queries Kitty keyboard protocol support (`CSI ? u` plus a DA1 sentinel), then enables protocol flags if supported; otherwise enables the modifyOtherKeys fallback after 150ms. A `start()` over a running terminal replaces the pending fallback timer.
7. Queries OSC 11 background color and subscribes to Mode 2031 appearance notifications for dark/light theme detection.
8. Queries OSC 99 notification capabilities.
9. Probes the DEC private modes in `STARTUP_PRIVATE_MODE_PROBES` via DECRQM: 2026 (synchronized output), 2048 (in-band resize), 2031, 5522 (enhanced paste), and the xterm scroll-to-bottom modes 1010/1011. (Earlier builds also polled OSC 11 every 30s for terminals without Mode 2031, but each poll wiped the user's active text selection on several terminals, issue #3297, so mid-session theme tracking now relies on Mode 2031 push notifications only, with a scoped fallback on native Windows Terminal after DECRQM confirms 2031 unsupported.)

`StdinBuffer` behavior:

- Buffers fragmented escape sequences (CSI/OSC/DCS/APC/SS3).
- Emits `data` only when a sequence is complete or timeout-flushed. An unambiguous partial (the head of an SGR mouse report) is held past the timeout for at most `PARTIAL_HOLD_MAX_MS` (150ms), and an expired held partial is delivered on its own when a fresh escape starts.
- Detects bracketed paste and emits a `paste` event with raw pasted text.

This prevents partial escape chunks from being misinterpreted as normal keypresses.

## Input routing and focus model

Input path:

`stdin -> ProcessTerminal -> StdinBuffer -> TUI.#handleInput -> focusedComponent.handleInput`

Routing details:

1. TUI runs registered input listeners first (`addInputListener`), allowing consume/transform behavior, then consumes terminal cell-size replies.
2. A key press (not an SGR pointer report, not a key release) tells the frame pacer to skip the cadence for its frames; see the render loop below.
3. Scroll isolation consumes SGR mouse reports while wheel tracking is on, and the alt-screen transcript consumes legacy arrow keys it can scroll by.
4. TUI handles global debug shortcut (`shift+ctrl+d`) before component dispatch.
5. If focused component belongs to an overlay that is no longer interactive (hidden, invisible, or playing out its close), TUI hands focus back the same way a close does.
6. Key release events are filtered unless focused component sets `wantsKeyRelease = true`.
7. After dispatch, TUI schedules render.

`setFocus()` also toggles `Focusable.focused`, which controls whether components emit `CURSOR_MARKER` for hardware cursor placement.

## Key handling split: editor vs controller

`CustomEditor` intercepts app-level shortcuts first through `#ACTION_DISPATCH`, a precedence-ordered table of configurable keybinding actions (`app.interrupt`, `app.clear`, `app.exit`, `app.suspend`, image and raw-text paste, external editor, model selection and cycling, thinking toggle and cycle, history search, tool expansion, dequeue, copy prompt, retry, bash backgrounding), plus extension custom keys, and delegates the rest to base `Editor` behavior (text editing, history, autocomplete, cursor movement). `app.interrupt` yields to an open autocomplete popup, so the first Esc closes the popup.

`InputController.setupKeyHandlers()` then binds editor callbacks to mode actions:

- cancellation / mode exits on `Escape`
- shutdown on double `Ctrl+C` or empty-editor `Ctrl+D`
- suspend/resume on `Ctrl+Z`
- slash-command and selector hotkeys
- follow-up/dequeue toggles and expansion toggles

This keeps key parsing/editor mechanics in `hosts/terminal/engine` and mode semantics in coding-agent controllers.

## Render loop and the append-only contract

`TUI.requestRender()` coalesces render requests and rate-limits ordinary frames:

- forced renders (`requestRender(true, ...)`) schedule an immediate frame and force a full window rewrite; with `clearScrollback`, they trigger a destructive full paint (ED3 outside multiplexers); `resetDisplay()` invalidates all components and forces a full replay, which explicit expansion uses to surface updated layout across history
- ordinary renders schedule through `#scheduleRender()` and respect the 30fps cadence (`MIN_RENDER_INTERVAL_MS` in `core/frame-pacing.ts`), except the frames a key press asks for
- repeated requests while a render is pending collapse into the same scheduled frame
- the cadence is adaptive, not fixed. `#scheduleRender()` waits for `FramePacer.delay()` (`core/frame-pacing.ts`), the largest of three delays: the 30fps cadence, twice a decayed estimate of frame cost, and any input grace window still open. The second one exists because the plain cadence collapses to zero as soon as a frame takes longer than the interval, which busy-loops the CPU through a run of slow frames; it is capped at `MAX_ADAPTIVE_RENDER_MS` (200ms, about 5fps), below which the UI reads as dead and no further saving is worth it. The estimate weighs the newest frame at `FRAME_COST_SMOOTHING`, so a loop that paints slowly on every frame is held near a 50% duty cycle while one expensive paint among cheap ones barely moves the floor.
- a key press exempts the next two frames from the cadence (`KEY_PRESS_FRAMES`, through `FramePacer.keyPressed()`): the frame its handler requests and the one an awaiting handler requests a few milliseconds later (a dashboard reading its rows, a session list read from disk), which the cadence held up to an interval behind the first. `#dispatchInput` also reschedules a frame that was waiting out the cadence when the key arrived, after the handler runs so a grace window the press opened still applies. Pointer reports (`\x1b[<`) and key releases keep the cadence: wheel and hover arrive at the rate the cadence caps. The cost floor and the input grace apply to every frame.
- a handler that arms a double-press window calls `TUI.holdFrameForInput()`, which opens a one-frame grace window (`INPUT_RENDER_GRACE_MS`, through `FramePacer.holdForInput()`) before the next ordinary repaint, so the second press drains from stdin before a slow repaint can outlast the window. The arming sites are Ctrl+C's first press (`InputController.handleCtrlC`) and the Esc that arms draft discard or `doubleEscapeAction` (`ComposerEscape`). The engine sniffs no key: an Esc or Ctrl+C that arms nothing (closing a selector, interrupting a turn) paints on the next frame like any other key.
- `requestComponentRender(component)` requests on behalf of a single self-contained change (spinner frame, blink): when every request in the coalesced frame is component-scoped and the frame is quiet (no resize, overlays, inline images, forced repaint, or root-list change), compose re-renders only the root subtrees containing the requesting components and reuses every other root child's previous rows and seam report; any unsafe condition or concurrent full request downgrades to a full compose
- `markLayoutSized(component)` exempts a root child from that reuse. Its height is a function of its siblings' heights, so the `onBeforeCompose` pass at the top of the frame resizes it while nothing has requested it; reusing its previous rows composes the frame at the height the previous frame's content called for. The home anchor's two fills are registered this way, which is what keeps a streamed chunk — a component-scoped frame — from composing one row past the viewport per row of the answer.
- `onBeforeCompose` runs before the compose loop and is where a layout-sized child's height is decided, so it measures the children the frame is about to render. That measurement is a read and nothing more: a root child the engine drives with the native-scrollback protocol (`TranscriptContainer`) hands its committed prefix to the terminal inside `render()` and reports the rows it dropped, and the engine authorizes one such drop per frame — count fed, child rendered, report read back, count republished after the emit. A sizing pass that called `render()` would spend that authorization, and the compose render would drop a second prefix against the same count, leaving the frame shorter than the screenful a shrink is repaired from. `HomeAnchorLayout` measures such a child through `renderViewportTail`, which is state-isolated by contract and bounded by the rows the viewport has left.
- `reusedRows(child)` answers, inside `onBeforeCompose` only, with the rows the frame about to compose keeps for a root child it reuses without rendering, and `undefined` for a child it renders. It resolves the same component-scoped roots the compose resolves and drops that answer on any render request made during the pass. `HomeAnchorLayout` reads every reused root child's height there, so a streamed chunk's sizing pass renders the transcript tail and no other root child.

`#doRender()` pipeline:

1. Render root component tree, collecting the commit-boundary seam (`NativeScrollbackLiveRegion`) from the children.
2. Advance the append-only ledger: `windowTop = max(committedRows, frame.length - height)`, commit chunk = settled rows crossing the window top (never past the seam).
3. Extract and strip `CURSOR_MARKER`, normalize lines, slice the visible window, composite overlays into the window slice (screen coordinates; overlays freeze commits).
4. Emit one of: gesture-driven full paint (initial / session replace / resize), scroll-append (chunk rows only), in-window row diff, or seam rewrite (chunk + full window). While the transcript is resident on the alternate screen (the alt-arrows transport), every frame is instead a full viewport rewrite and the commit planner does not run.

Native scrollback always equals the committed frame prefix, rows enter history exactly once, in order, when the seam says they are final. Divergence repair rebuilds scrollback only when authorized by a segment at the resync row declaring `NativeScrollbackLiveRegion` or `NativeScrollbackReplay` (plain components preserve committed history); there are no viewport probes and no deferred reconciliation; see [`tui-core-renderer.md`](./tui-core-renderer.md).

Render writes use synchronized output mode (`CSI ? 2026 h/l`) when enabled; capability detection, DECRQM, or `VEYYON_NO_SYNC_OUTPUT` can disable the wrappers while leaving autowrap discipline on.

## Render safety constraints

Critical safety checks in `TUI`:

- Non-image rendered lines are expected to fit terminal width; the differential path truncates overwide lines as a last-resort guard and can write debug diagnostics when redraw debugging is enabled.
- Overlay compositing includes defensive truncation and post-composite width guarding.
- Width changes force repaint/rebuild planning because wrapping semantics change.
- Cursor position is clamped before movement.

These constraints are runtime guards plus component conventions; renderers should still return width-safe lines rather than rely on truncation.

The deeper reasons these guards exist, why the renderer cannot observe scroll
position, why ED3 (`CSI 3 J`) is confined to one path, and why the hot path
clamps instead of throwing, are documented in
[`tui-core-renderer.md`](./tui-core-renderer.md).

## Resize handling

Resize events are event-driven from `ProcessTerminal` to `TUI.requestRender()`.

Effects:

- A resize is an explicit user gesture: outside multiplexers the engine erases and replays (`ED3` + full paint) so history rewraps at the new geometry; the commit ledger restarts from the replayed frame.
- Inside terminal multiplexers, resize repaints the visible window in place after a 50ms settle debounce (`MULTIPLEXER_RESIZE_DEBOUNCE_MS` in `core/frame-pacing.ts`, issue #2088); pane history keeps its old wrap, like any shell output, because pane scrollback cannot be erased safely. The host gets SIGWINCH before the multiplexer has finished repainting the pane, so a forced render on each one races the catch-up paint and the user sees a flash.
- Outside a multiplexer a drag is not repainted authoritatively while it is moving. The full replay is O(history) twice over (markdown re-lexes every block at each distinct width, then the whole transcript goes back through native scrollback), and at drag rates it is recomputed dozens of times a second and thrown away. During the drag the engine composes and paints ONLY the viewport (`#renderResizeViewport`), a throwaway frame that never touches the commit ledger, and the authoritative replay fires once the drag has been quiet for `RESIZE_VIEWPORT_SETTLE_MS` (120ms).
- Terminals that re-report their size when the alternate screen buffer is toggled (Warp reports a height one row different for the alt buffer) take the in-place path too. The non-multiplexer fast path borrows the alternate screen for drag frames, so on these terminals each alt enter/leave emits a fresh resize event, which re-enters the fast path: a self-sustaining loop that floods ED3 full repaints with stable geometry. `resizeRepaintsInPlace()` (covering multiplexers and these terminals; overridable via `VEYYON_TUI_RESIZE_IN_PLACE`) routes them through the in-place repaint, which never touches the alt buffer.
- Overlay visibility can depend on terminal dimensions (`OverlayOptions.visible`); focus is corrected when overlays become non-visible after resize.

## Streaming and incremental UI updates

`EventController` subscribes to `AgentSessionEvent` and updates UI incrementally. Tool-call cards, turn recovery (retry and auto-compaction loaders), speech, IRC cards, idle follow-ups and displaceable blocks are its collaborators (`ToolCallCards`, `TurnRecovery`, and siblings under `modes/terminal/controllers/`).

- `agent_start`: marks the working user message, opens the turn's tool cards, stops a leftover retry loader, cancels idle follow-ups and the composer prediction, and ensures the working loader in `statusContainer`.
- `message_start` assistant: creates `streamingComponent` and mounts it.
- `message_update`: updates streaming assistant content; creates/updates tool execution components as tool calls appear.
- `tool_execution_update/end`: `ToolCallCards` updates tool result components and completion state.
- `message_end`: finalizes assistant stream, handles aborted/error annotations, marks pending tool args complete on normal stop.
- `agent_end`: ignored while the session is already streaming a newer turn. Otherwise stops loaders, clears transient stream state, flushes deferred model switch, closes the turn's cards, schedules idle follow-ups and the composer's ghost-text prediction, and issues completion notification if backgrounded.

Read-tool grouping is intentionally stateful (`ToolCallCards.#lastReadGroup`) to coalesce consecutive read tool calls into one visual block until a non-read break occurs.

## Status and loader orchestration

Status lane ownership:

- `statusContainer` holds transient loaders (`loadingAnimation`, `autoCompactionLoader`, `retryLoader`); `TurnRecovery` mounts and stops the last two.
- `statusLine` renders hook statuses as its own row. Its quiet segments (`path`, `git`, `model`, `mode`, `context_pct`, `usage` and the rest of `StatusLineSegmentId`) render through `renderQuietLine()` in the footline below the composer, read on each render; with `statusLine.enabled` off the footline shows only the focus badge.

Loader behavior:

- `Loader` advances its spinner every `SPINNER_ADVANCE_MS` (200ms; animated message colorizers redraw at ~30fps) and requests a direct row rewrite (`requestDirectWrite`, which downgrades to a component-scoped `requestComponentRender` whenever the frame is not a safe single-component change) only when the spinner frame or the message changed, or on every tick while the colorizer animates, so idle spinner ticks repaint without re-walking the transcript. When every spinner frame is one unbreakable word of the same width (`layoutFrameFor`), the message is wrapped against one representative frame, so a tick that only advances the spinner re-wraps nothing.
- Escape cancels an in-progress auto-compaction, handoff generation, or auto-retry of the view session: `ComposerEscape.handleEscape()` (`controllers/composer-escape.ts`) dispatches on live session state (`isCompacting`/`isGeneratingHandoff`/`isRetrying`) and calls the matching abort method, rather than swapping the handler. While an agent view is focused, Esc returns to the main view instead.
- On end/cancel paths, controllers stop/clear the loader components.

## Mode transitions and backgrounding

### Bash/Python input modes

Input text prefixes toggle editor border mode flags:

- `!` -> bash mode
- `$` or `$$` followed by whitespace or end of input -> python mode (`$$` excludes the run from context). `${`, prose such as `$HOME`, and a pasted shell prompt stay text.

Escape exits inactive mode by clearing editor text and restoring border color; when execution is active, escape aborts the running task instead.

### Plan mode

`PlanModeController` (`controllers/plan-mode-controller.ts`) holds plan mode state, the plan-review overlay, and approval into an execution turn; `InteractiveMode` exposes `planModeEnabled`, `planModePaused` and `planModePlanFilePath` as accessors over it and delegates its plan methods there. Enter/exit appends a session mode entry and updates status/UI state; a model switch requested while streaming is deferred until the turn ends.

### Suspend/resume (`Ctrl+Z`)

`InputController.handleCtrlZ()`:

1. No-op with a status message on Windows (`process.kill` throws on job-control signals there).
2. Registers one-shot `SIGCONT` handler to restart TUI and force render.
3. Stops TUI before suspend.
4. Sends `SIGSTOP` (not `SIGTSTP`) to the foreground process group (`process.kill(0, "SIGSTOP")`): brush-core's tokio SIGTSTP listener permanently swallows SIGTSTP after the first bash tool call (issue #3461), and pgid 0 keeps launcher shims / pipeline peers consistent with the shell's job-control view. If the signal is refused, the handler is detached and the TUI restarted so the user is not stranded.

## Cancellation paths

Primary cancellation inputs:

`ComposerEscape.handleEscape()` stops the topmost running activity and nothing beneath it, in this order: a side-channel panel (`/btw`, `/omfg`), the view session's maintenance, speech playback, loop mode, a focused agent view, a collab guest's host turn, then foreground work, then the draft.

- `Escape` during active stream loader: cancels a pending submission, else restores queued messages to editor and aborts the agent.
- `Escape` during bash/python execution: aborts running command (`abortBash`/`abortEval`).
- `Escape` during auto-compaction, handoff generation, or auto-retry: calls the matching abort method (`abortCompaction`/`abortHandoff`/`abortRetry`).
- `Escape` twice within 500ms on an idle composer: discards the draft, or runs `doubleEscapeAction` when the composer is empty.
- `Ctrl+C` single press: clear editor; double press within 500ms: shutdown. A `Ctrl+C` while shutdown is already running exits the process.

Cancellation is state-conditional; same key can mean abort, mode-exit, selector trigger, or no-op depending on runtime state.

## Event-driven vs throttled behavior

Event-driven updates:

- Agent session events (`EventController`)
- Key input callbacks (`InputController`)
- terminal resize callback
- terminal appearance and background-color callbacks, theme changes, and the status line's git-state watcher (`StatusLineComponent.watchGitState`) in `InteractiveMode`
- Editor autocomplete (inside `Editor`): every edit runs `#updateAutocomplete()` with no timer, and a request id drops a provider answer that a later edit superseded

Throttled/debounced paths:

- TUI rendering coalesces requests into one scheduled frame paced by `FramePacer` (`requestRender` coalescing).
- Loader animation is interval-driven (200ms spinner advance; ~30fps when the message colorizer is animated), each changed frame requesting a direct row rewrite (`requestDirectWrite`, falling back to a component-scoped render when the frame is unsafe).

The runtime therefore mixes event-driven state transitions with bounded render cadence to keep interactivity responsive without repaint storms.

*Verified against `454ff6aec890de9fcb236f4563e12db6f873d25c` on 2026-11-04.*
