/**
 * Minimal TUI implementation with differential rendering.
 *
 * Append-only render contract: rows committed to native scrollback are
 * immutable — the tape is the terminal's visual record. Whatever scrolls
 * above the window enters history exactly once, in order: as exact-final
 * bytes when the component seam (`NativeScrollbackLiveRegion`) declared them
 * final, else as a frozen snapshot of what was on screen. When recorded
 * history diverges from the frame (a finalized block replacing its
 * scrolled-off live render), the engine erases and replays (ED3, `CSI 3 J`)
 * so history holds the content exactly once — the same replay used for
 * gestures (session replace, resize, resetDisplay). Multiplexer panes, where
 * ED3 is unsafe, instead re-anchor and recommit below the stale fragment —
 * duplication, never loss. The engine never probes or guesses the terminal's
 * scroll position, and the hot path clamps over-wide lines instead of
 * throwing. See `docs/internal/tui-core-renderer.md`.
 */
import * as fs from "node:fs";
import { performance } from "node:perf_hooks";
import { planDeccaraFills } from "@veyyon/utils/deccara";
import { getDebugLogPath } from "@veyyon/utils/dirs";
import { $flag } from "@veyyon/utils/env";
import { isKeyRelease, matchesKey } from "@veyyon/utils/keys";
import * as logger from "@veyyon/utils/logger";
import { popLoopPhase, pushLoopPhase } from "@veyyon/utils/loop-phase";
import { LoopWatchdog } from "@veyyon/utils/loop-watchdog";
import { clampLow } from "@veyyon/utils/math";
import { parseSgrMouse } from "@veyyon/utils/mouse";
import { errorMessage } from "@veyyon/utils/type-guards";
import { visibleWidth } from "@veyyon/utils/width";
import { isConPTYHosted, setAltScreenActive, type Terminal } from "../terminal";
import {
	encodeKittyDeleteImage,
	ImageProtocol,
	setCellDimensions,
	shouldEnableSynchronizedOutputByDefault,
	synchronizedOutputUserOverride,
	TERMINAL,
} from "../terminal-capabilities";
import {
	asViewportTailProvider,
	type Component,
	CURSOR_MARKER,
	canPrepareNativeScrollbackReplay,
	type FrameSegment,
	getNativeScrollbackLiveRegionStart,
	getRenderStablePrefixRows,
	isFocusable,
	isOverlayFocusTarget,
	type NativeScrollbackCommittedRows,
	prepareNativeScrollbackReplay,
	type RenderRequestOptions,
	setNativeScrollbackCommittedRows,
	setNativeScrollbackRetainRows,
	takeNativeScrollbackDroppedRows,
	type ViewportTailProvider,
} from "./component-types";
import { Container } from "./container";
import { HardwareCursorTracker, type HardwareCursorUpdate } from "./cursor";
import { DEFAULT_MAX_INLINE_IMAGES, ImageBudget } from "./image-budget";
import { footerWantsPointer, pinnedFooterScreenBounds, routeFooterMouse } from "./mouse-routing";
import {
	canAnimateOverlayExit,
	drawScrollTrack,
	type OverlayHandle,
	type OverlayOptions,
	OverlayStack,
} from "./overlay";
import {
	extractCursorMarkers,
	findCommittedPrefixResync,
	LINE_TERMINATOR,
	lineRewriteSequence,
	PreparedFrameCache,
	prepareLine,
	prepareLinesArray,
	rowsEquivalent,
	subtreeContains,
	terminalLine,
	truncateLargeConptyFrame,
} from "./renderer";
import {
	ALT_SCROLL_OFF,
	ALT_SCROLL_ON,
	CURSOR_KEY_SCROLL_ROWS,
	LEGACY_CURSOR_SCROLL,
	ScrollTape,
	type ScrollTransport,
	WheelAccelerator,
} from "./scroll";
import {
	ALT_SCREEN_ENTER,
	ALT_SCREEN_EXIT,
	CURSOR_BEGIN,
	CURSOR_BEGIN_NO_SYNC,
	CURSOR_END,
	CURSOR_END_NO_SYNC,
	type InputListener,
	isMultiplexerSession,
	MOUSE_TRACKING_OFF,
	MOUSE_TRACKING_ON,
	MOUSE_WHEEL_TRACKING_OFF,
	MOUSE_WHEEL_TRACKING_ON,
	PAINT_BEGIN,
	PAINT_BEGIN_NO_SYNC,
	PAINT_END,
	PAINT_END_NO_SYNC,
	resizeRepaintsInPlace,
	SixelProbe,
	type StartListener,
} from "./terminal-session";

export interface RenderTimer {
	cancel(): void;
}

export interface RenderScheduler {
	now(): number;
	scheduleImmediate(callback: () => void): void;
	scheduleRender(callback: () => void, delayMs: number): RenderTimer;
}

export interface TUIOptions {
	renderScheduler?: RenderScheduler;
}

export interface TUIStartOptions {
	/** Clear saved native scrollback before the first paint. */
	clearScrollback?: boolean;
}

const DEFAULT_RENDER_SCHEDULER: RenderScheduler = {
	now: () => performance.now(),
	scheduleImmediate: callback => {
		setImmediate(callback);
	},
	scheduleRender: (callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		return {
			cancel: () => {
				clearTimeout(timer);
			},
		};
	},
};

/**
 * Render intent. `#doRender` classifies each frame, and the matching `#emit*`
 * method owns the bytes written and the state update.
 *
 * - `fullPaint`: gesture-driven replay — initial paint, session replacement,
 *   resize, resetDisplay. Rewrites the frame from home; destructive replaces
 *   clear native scrollback via ED3 without first blanking the viewport. The
 *   only ED3 callsite in the engine.
 * - `update`: ordinary frame. Commits the newly settled chunk at the
 *   scrollback seam (if any) and repaints the window with relative moves.
 */
type RenderIntent =
	| { kind: "fullPaint"; clearScrollback: boolean }
	| { kind: "update"; chunkTo: number; windowTop: number };
/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export class TUI extends Container {
	terminal: Terminal;
	#previousFrameLength = 0;
	#previousWidth = 0;
	#previousHeight = 0;
	#focusedComponent: Component | null = null;
	#inputListeners = new Set<InputListener>();
	#startListeners = new Set<StartListener>();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	onDebug?: () => void;

	/**
	 * Called when the operator tries to select text with the mouse while the
	 * engine holds it: a left press and a release in a DIFFERENT cell, outside
	 * the pinned footer. Holding the mouse is what lets the wheel scroll the
	 * transcript, and it also takes plain drag-select away from the terminal —
	 * so the gesture arrives here instead of highlighting anything, and the
	 * operator gets no feedback at all unless the host says something (reported
	 * 2026-07-24 as "I can't copy and paste from the terminal"). Hosts use this
	 * to name the alternatives once; the engine only reports the attempt and
	 * keeps no "already told them" state of its own.
	 */
	onSelectionAttempt?: () => void;
	/** Cell of the left press being tracked for {@link onSelectionAttempt}. */
	#pressCell: { row: number; col: number } | null = null;
	#renderRequested = false;
	#renderTimer: RenderTimer | undefined;
	#renderScheduler: RenderScheduler;
	#lastRenderAt = 0;
	/**
	 * Decayed estimate of what a frame costs, in milliseconds. `#scheduleRender`
	 * derives the adaptive floor from it to hold the render loop near a 50%
	 * duty cycle: without one the throttle collapses to zero as soon as
	 * `elapsed >= MIN_RENDER_INTERVAL_MS`, and a run of slow frames (large
	 * transcript diffs, huge assistant text wrap, component-tree walks) turns
	 * the loop into a busy loop at 40-50% CPU (see #4145).
	 *
	 * A duty cycle is a property of a window, not of one frame, and reading the
	 * previous frame alone conflated two different situations. A loop that
	 * paints slowly on every frame converges here and is held to half the CPU,
	 * which is what #4145 asked for. A single expensive paint among cheap ones
	 * moves the estimate by a fraction of itself, so the frame after it still
	 * arrives at the cadence: a scrolled viewport leaves the diff nothing to
	 * reuse and costs a full paint, and putting a 66ms floor under the cheap
	 * diff that followed it is how a session that painted on time 68% of the
	 * time published at 14.2 fps against a 30 fps capture.
	 */
	#frameCostEstimateMs = 0;
	/**
	 * Weight of the newest frame in `#frameCostEstimateMs`. At 0.3 a sustained
	 * change in frame cost is ~90% absorbed within seven frames, so the loop
	 * reaches its duty-cycle floor inside a quarter second of going slow, while
	 * an isolated spike lifts the floor by under a third of itself.
	 */
	static readonly #FRAME_COST_SMOOTHING = 0.3;
	static readonly #MIN_RENDER_INTERVAL_MS = 1000 / 30;
	static readonly #INPUT_RENDER_GRACE_MS = TUI.#MIN_RENDER_INTERVAL_MS;
	/**
	 * Cap on the adaptive floor derived from `#frameCostEstimateMs`. Bounds the
	 * UI responsiveness at ~5 fps under sustained heavy renders — anything
	 * slower feels dead to the user and no longer justifies further CPU savings.
	 */
	static readonly #MAX_ADAPTIVE_RENDER_MS = 200;
	#inputRenderGraceUntilMs = 0;
	// Pane-reflow settle window for tmux/screen/zellij. The host process gets
	// SIGWINCH (and `process.stdout` already reports the new geometry) before
	// the multiplexer finishes repainting the pane at the new size, and
	// drag-resize/pane-close animations fire several events in flight. A forced
	// render on each SIGWINCH races those mid-reflow paints — the multiplexer's
	// catch-up paint then partially overwrites the TUI output, which the user
	// sees as a viewport flash or blank screen before the next throttled frame
	// arrives (issue #2088). Coalescing every SIGWINCH inside this window into
	// a single forced render lets the multiplexer settle first.
	static readonly #MULTIPLEXER_RESIZE_DEBOUNCE_MS = 50;
	// Resize viewport fast path (non-multiplexer). A drag emits a SIGWINCH burst,
	// and outside a multiplexer the host gets each new geometry atomically. The
	// authoritative resize paint erases and replays the entire transcript so it
	// rewraps at the new width — O(history) compose (markdown re-lexes every
	// block, the per-width cache missing on every distinct drag width) plus an
	// O(history) write that pushes all of it back through native scrollback. At
	// drag rates that whole-history pass is recomputed dozens of times a second
	// and discarded the instant the next event lands. While the drag is in
	// flight the engine instead composes and paints ONLY the viewport (see
	// `#renderResizeViewport`): a state-isolated, throwaway frame that never
	// touches the commit ledger. The authoritative full replay fires once, after
	// the drag has been quiet for this long. Multiplexer sessions keep their own
	// debounce (`#armMultiplexerResizeTimer`, see #2088) and never take this path.
	static readonly #RESIZE_VIEWPORT_SETTLE_MS = 120;
	// Ghostty can drop Kitty graphics commands sent during its first post-startup
	// settle window, leaving only Unicode placeholder cells. Hold the first image
	// paint until that window has passed; later images render normally.
	static readonly #GHOSTTY_INITIAL_IMAGE_DELAY_MS = 100;
	// Post-paint settle window for ConPTY hosts. The `sessionReplace` /
	// `historyRebuild` / `overlayRebuild` intents drive `#emitFullPaint` over
	// a transcript that overflows the viewport, scroll-pushing everything past
	// the last `height` rows into native scrollback. Windows Terminal's
	// viewport-follow logic gets lossy during that burst: spinner/blink-driven
	// `requestRender(false)` calls firing inside the window each produce another
	// diff write, and the WT host processes them faster than its viewport
	// tracker can keep up — the visible tail ends up parked a few rows above
	// the actual last row until any focus event (Alt+Tab) forces a host repaint.
	// Coalescing every non-forced render inside this window into a single
	// trailing render lets the host fully settle the big paint before any
	// follow-up writes touch the buffer. The first-ever `initial` paint is
	// deliberately exempt: nothing has been on screen yet, so no drift can
	// have accumulated, and tests that start the TUI over an over-tall
	// component depend on the next paint firing without delay. Only armed on
	// ConPTY hosts (`isConPTYHosted()`); other terminals do not exhibit the
	// drift and would just see an unnecessary post-paint latency. See #2095.
	static readonly #CONPTY_POST_FULL_PAINT_SETTLE_MS = 150;
	#postFullPaintSettleUntilMs = 0;
	#postFullPaintSettleTimer: RenderTimer | undefined;
	#sixelProbe = new SixelProbe({
		write: data => {
			this.terminal.write(data);
		},
		addInputListener: listener => this.addInputListener(listener),
		onSixelDiscovered: () => {
			this.#queryCellSize();
			this.invalidate();
			this.requestRender(true);
		},
	});
	#synchronizedOutputEnabled = shouldEnableSynchronizedOutputByDefault();
	#paintBeginSequence = this.#synchronizedOutputEnabled ? PAINT_BEGIN : PAINT_BEGIN_NO_SYNC;
	#paintEndSequence = this.#synchronizedOutputEnabled ? PAINT_END : PAINT_END_NO_SYNC;
	#cursor = new HardwareCursorTracker(
		$flag("VEYYON_HARDWARE_CURSOR"),
		this.#synchronizedOutputEnabled ? CURSOR_BEGIN : CURSOR_BEGIN_NO_SYNC,
		this.#synchronizedOutputEnabled ? CURSOR_END : CURSOR_END_NO_SYNC,
	);
	// Rows of the current frame physically committed to the terminal tape
	// (native scrollback or scrolled past the window top). Immutable by
	// contract: the engine never rewrites them. Rows below
	// #committedPrefixAuditRows entered as exact-final bytes (the component
	// seam declared them); rows at/after it are frozen visual snapshots that
	// scrolled off the window top while still live.
	#committedRows = 0;
	// Raw rows mirroring [0, #committedRows) — the engine's claim of what it
	// committed. The audited prefix [0, #committedPrefixAuditRows) is checked
	// each ordinary frame against the current render to detect components
	// re-laying-out declared-final content (see #auditCommittedPrefix). Holds
	// references to component-cached strings, so the audit is a pointer walk
	// in the common case.
	#committedPrefix: string[] = [];
	// Rows the current compose's children dropped out of the front of their own
	// output (see NativeScrollbackCompaction). Consumed once per frame, right
	// after compose, to slide the commit coordinates onto the new frame.
	#frameDroppedRows = 0;
	// Frame row the drop happened at, in the PREVIOUS frame's coordinates: the
	// topmost dropping child's start. Undefined when nothing dropped.
	#frameDroppedAt: number | undefined;
	// Guards the one-shot rehydrating re-render a destructive rebuild takes when
	// a virtualized root has dropped the history that rebuild is about to erase.
	#rehydratingDivergence = false;
	// The history the frozen transcript view reads; see `core/scroll.ts`.
	#scrollTape = new ScrollTape();
	// Immutable scroll space the frozen view reads: the tape followed by the
	// composed frame's uncommitted rows, snapshotted when the view freezes.
	// Built once per gesture so nothing under the frozen region can move it —
	// a virtualized root drops rows on quiet frames, which would otherwise
	// shift every row of a live-frame-sourced view out from under the reader.
	#scrollSnapshot: string[] | null = null;
	// Rows of the committed prefix that were HARD-VERIFIED as exact-final
	// bytes (committed below the exactness boundary, or frozen snapshots that
	// passed the one-time strict scan when the boundary rose past them). Rows
	// in [#committedPrefixAuditRows, #committedRows) are frozen visual
	// snapshots of still-live content — the terminal's record of what was on
	// screen when it scrolled off — and are audit-exempt while their source
	// remains live, so a collapsing preview never sprays re-anchors mid-run.
	// When the exactness boundary rises past them (the block finalized), they
	// are strict-scanned exactly once: unchanged rows join the verified zone,
	// a divergence re-anchors so the final content recommits below the frozen
	// snapshot (duplication, never loss). Re-based on full paints / shrinks /
	// geometry frames.
	#committedPrefixAuditRows = 0;
	// Frame row currently mapped to screen row 0. Monotonic between full
	// paints, with one exception: the tail re-anchor in #doRender pulls the
	// window back to the frame tail when a collapse would otherwise strand
	// the focused editor above blank rows. Otherwise a shrink never
	// re-exposes scrolled-off rows (they cannot be un-scrolled without
	// rewriting history); live rows repaint at fixed positions.
	#windowTopRow = 0;
	// Scroll isolation. When enabled, wheel events scroll the transcript
	// region while the pinned footer (the composer zone) stays live at the
	// viewport bottom — the opencode/grok-build model, against the engine's
	// native-scrollback default where the whole window scrolls and the
	// composer goes with it. #virtualScrollTop is the row of the SCROLL SPACE
	// (the tape followed by the frame's uncommitted rows, see #scrollTape) at
	// the top of the frozen transcript region; null means following the live
	// tail. Commits freeze while set (a chunk would scroll the terminal and
	// destroy the frozen view); the accumulated rows backfill through the
	// ordinary seam rewrite on resume.
	#scrollIsolation = false;
	// How a scroll gesture REACHES the engine. Both transports drive the same
	// frozen-region viewport; they differ only in what the terminal sends and in
	// what that costs the operator.
	//
	// - "mouse": normal screen, mouse tracking held (1000h+1006h). The wheel
	//   arrives as a mouse report, unambiguous, but the terminal stops selecting
	//   on plain drag, so selection becomes Shift+drag for the session.
	// - "alt-arrows": alternate screen with Alternate Scroll Mode (1007h) and NO
	//   mouse tracking. The terminal translates wheel ticks into cursor-up/down
	//   keys, so the engine scrolls from key input and the terminal keeps native
	//   selection. The transcript lives on the alt buffer, so it is no longer in
	//   the terminal's scrollback and the host is responsible for replaying it on
	//   exit if that history should survive the session.
	//
	// Defaulted from `VEYYON_TUI_SCROLL_TRANSPORT` so the surface is reachable
	// before it has a settings entry. The settings schema is where this belongs and
	// is where it will move; the env read is not a substitute for that, only an
	// earlier door.
	#scrollTransport: ScrollTransport = Bun.env.VEYYON_TUI_SCROLL_TRANSPORT === "alt-arrows" ? "alt-arrows" : "mouse";
	#altScrollActive = false;
	#wheelTrackingActive = false;
	// True while anything sits above the window: the composed frame overflows
	// the viewport, OR rows have already scrolled off onto the tape. Gating on
	// frame overflow ALONE is what broke the pinned composer — a virtualized
	// transcript trims the frame back to about the viewport on every quiet
	// frame, so the gate closed, the mouse was released, and the wheel scrolled
	// the terminal and took the prompt with it. Tracking still releases while
	// the screen has no history at all, so a fresh session keeps full native
	// drag-select. Once there is history this gate opens and the grab is held for
	// as long as it stays open. `tui.scrollIsolation` turns the whole model off
	// for anyone who would rather have native scrollback.
	#frameScrollable = false;
	// Pinned footer = the last #pinnedFooterChildCount root children (the
	// composer zone). The row count is derived from the segment ledger after
	// every compose — never by re-rendering the zone, which would double
	// render side effects (accent-cache call counts, memoized quiet lines).
	#pinnedFooterChildCount = 0;
	#pinnedFooterRows = 0;
	#virtualScrollTop: number | null = null;
	#wheelAccel = new WheelAccelerator();
	// Idle release of the mouse grab.
	//
	// Holding the mouse is what pins the composer, and it is also what takes native
	// drag-select away: on the normal screen the wheel reaches an application ONLY through
	// mouse reporting, and that is the same reporting the terminal would otherwise use to
	// select. There is no mode that reports the wheel without the buttons, so the two cannot
	// both be live. The grab was therefore held from the moment anything scrolled off until
	// the session ended, and selecting became Shift+drag for the rest of the run.
	//
	// The answer is NOT to time-box the grab. That was tried: the grab was held only within
	// three seconds of a keystroke and released on the quiet after it. The quiet is when you
	// READ, and once released the engine cannot see a wheel tick at all, so the wheel fell
	// through to native scrollback and took the pinned composer off the bottom of the screen
	// with it. It also made drag-select depend on how recently you had typed, so the same
	// gesture selected or did not depending on the clock. A pinned composer that unpins itself
	// whenever you stop typing is not the feature, and nondeterministic selection is worse than
	// consistently reaching for Shift.
	//
	// So the grab is held whenever the transcript is scrollable, Shift+drag selects, and
	// `/copy` lifts text out without the mouse at all.
	// Exactly what is painted on the screen rows (post-composite, prepared).
	#previousWindow: string[] = [];
	#nativeScrollbackLiveRegionStart: number | undefined;
	#fullRedrawCount = 0;
	// Caps how many inline images render as live graphics; older ones fall back
	// to text via a purge + full redraw. Cap is configured by the host app.
	#imageBudget = new ImageBudget(DEFAULT_MAX_INLINE_IMAGES, () => this.requestRender());
	#ghosttyInitialImageDelayDone = false;
	#ghosttyInitialImageDelayTimer: RenderTimer | undefined;
	#ghosttyImageReadyAtMs = 0;
	#clearScrollbackOnNextRender = false;
	#forceViewportRepaintOnNextRender = false;
	#hasEverRendered = false;
	// Erase-and-replay history when a block's final form replaces the live
	// preview that already scrolled off.
	//
	// WHAT IT FIXES. Without it the engine recommits the final form BELOW the
	// stale fragment, so the reader sees the same paragraph twice, one after the
	// other. A streaming reply that reflows a block after part of it scrolled
	// past the window top produces that every time, which on a long answer is
	// most of them, and it was the most-reported rendering defect in the
	// product.
	//
	// The `divergenceRebuild` condition this gates already refuses every case
	// where erasing is unsafe: the first paint, an explicit replace, any
	// geometry frame, and any multiplexer pane, where ED3 would eat the pane's
	// own history and the repair-below fallback is kept on purpose. What is left
	// is a direct terminal whose scrollback the engine itself wrote and can
	// rewrite, so there is nothing left to opt out of.
	#scrollbackRebuildEnabled = true;
	// Set by the terminal resize callback; consumed by the next render. A resize
	// event invalidates the committed screen even when the dimensions net out
	// unchanged by render time (e.g. a 6→4→6 round trip coalesced into one frame
	// budget): the terminal reflowed its buffer on each event, moving rows
	// between the viewport and scrollback, so the previous frame no longer
	// describes the screen. Tracking only the dimension delta misses this.
	#resizeEventPending = false;
	// Active multiplexer SIGWINCH debounce. Reset on each event so the timer
	// only fires once the pane stops resizing. Forced renders (resetDisplay,
	// finishSixelProbe, …) issued during the settle window route through the
	// same timer; their `clearScrollback` intent is OR'd into the deferred
	// flag below so the settled paint still honours every caller's request.
	#multiplexerResizeTimer: RenderTimer | undefined;
	#deferredForcedClearScrollback = false;
	// True from the first SIGWINCH of a non-multiplexer drag until the settle
	// timer fires. While set, every `#doRender` short-circuits to the viewport
	// fast path (`#renderResizeViewport`) instead of an authoritative full
	// paint, and no commit/window/diff state is advanced.
	#resizeViewportActive = false;
	// Quiet-window timer that ends the drag: its callback clears the flag and
	// drives the one authoritative full paint. Reset on every resize event so it
	// only fires once the drag stops. Cancelled on stop().
	#resizeViewportSettleTimer: RenderTimer | undefined;
	// Count of transient viewport-only resize paints emitted. Distinct from
	// `#fullRedrawCount`: these never enter native scrollback and exist only for
	// the lifetime of the drag. Exposed for tests/diagnostics.
	#resizeViewportPaintCount = 0;
	// During a live resize drag the terminal's normal buffer may reflow full-width
	// rows before our repaint lands. Borrow the alternate screen for throwaway
	// resize frames so width changes truncate the transient viewport instead of
	// pushing wrapped fragments into native scrollback.
	#resizeAltActive = false;
	#stopped = false;
	// Always-on event-loop lag probe. The high default threshold keeps it quiet;
	// it only logs `ui.loop-blocked` (with the current loop phase) when a frame
	// budget is genuinely starved. Armed in start(), disarmed in stop().
	#watchdog: LoopWatchdog;

	// Live tail of the last resident alt paint: the composed rows that had not
	// moved onto the scroll tape yet. Together with the tape this is the whole
	// transcript that surface holds, which is what the exit replay writes.
	#altTailRows: string[] = [];
	// Set once a resident paint has happened, so exit knows there is a transcript
	// the terminal has never seen. Cleared by the replay itself, so a second stop()
	// cannot write the conversation twice.
	#altTranscriptReplayPending = false;
	// Transient alternate-screen state for a fullscreen overlay. While active, the
	// engine paints only the modal on the alt buffer and leaves every
	// normal-screen accounting field (#previousFrameLength, #viewportTopRow, …)
	// untouched, so exiting reconciles cleanly against the terminal-restored
	// normal screen. #altPreviousLines is the last alt frame, for repaint-skip.
	#altActive = false;
	#altPreviousLines: string[] = [];
	// Caret placed by the last alt-buffer paint, or undefined when that paint
	// left it hidden. Part of the repaint-skip test: identical rows with a moved
	// caret still needs a paint, or the composer's cursor lags the text.
	#altPreviousCursor: { row: number; col: number } | undefined;
	// True while the alt buffer is up because a fullscreen OVERLAY asked for it,
	// as opposed to the transcript residing there for the "alt-arrows" transport.
	// The two want different tracking, and residency has to survive an overlay
	// opening and closing over it.
	#altOverlayBorrow = false;
	#altEnterWidth = 0;
	#altEnterHeight = 0;

	// Persistent composed frame. The render override splices only rows at/after
	// the stable prefix each frame; cursor markers are stripped at ingestion so
	// the frame never carries them. Returned to render() callers — treated as
	// immutable by them per the Component render contract.
	#composedFrame: string[] = [];
	// Per-root-child segment ledger backing the stable-prefix computation.
	#frameSegments: FrameSegment[] = [];
	#composeWidth = -1;
	// Cursor markers stripped at ingestion, ascending by frame row.
	#frameCursorMarkers: { row: number; col: number }[] = [];
	// Leading rows of #composedFrame byte-identical to the previous compose.
	#renderStablePrefixRows = 0;

	// Component-scoped render accumulation. Targets are the components handed
	// to requestComponentRender() since the last frame; the flag stays true
	// only while EVERY pending request is component-scoped. Both are consumed
	// once per frame by #doRender.
	#componentRenderTargets = new Set<Component>();
	#pendingRenderComponentsOnly = false;
	// Root children that must re-render during the current compose; null for a
	// full compose. Non-null only for the duration of a component-scoped
	// render() call inside #doRender (the scratch set below, reused per frame).
	#partialComposeRoots: Set<Component> | null = null;
	#partialComposeRootsScratch = new Set<Component>();
	// Target component -> containing root child, so animation-rate requests do
	// not re-walk a huge transcript subtree every frame.
	#componentRootCache = new WeakMap<Component, Component>();

	// Row-aligned prepared frame carried between paints; see `core/renderer.ts`.
	#prepared = new PreparedFrameCache();

	// Modal components painted on top of the frame. The stack owns its own visibility rules; see
	// `core/overlay.ts`.
	#overlays: OverlayStack;

	constructor(terminal: Terminal, showHardwareCursor?: boolean, options?: TUIOptions) {
		super();
		this.terminal = terminal;
		this.#overlays = new OverlayStack(terminal);
		this.#renderScheduler = options?.renderScheduler ?? DEFAULT_RENDER_SCHEDULER;
		if (showHardwareCursor !== undefined) this.#cursor.setShow(showHardwareCursor);
		this.#watchdog = new LoopWatchdog();
	}

	override render(width: number): readonly string[] {
		width = Math.max(1, width);
		this.#nativeScrollbackLiveRegionStart = undefined;
		this.#frameDroppedRows = 0;
		this.#frameDroppedAt = undefined;
		const children = this.children;
		const previousSegments = this.#frameSegments;
		const segments: FrameSegment[] = new Array(children.length);
		// A width change re-renders every child; nothing carries over.
		let chainStable = this.#composeWidth === width;
		this.#composeWidth = width;
		let offset = 0;
		let stableRows = 0;
		const partialRoots = this.#partialComposeRoots;
		for (let index = 0; index < children.length; index++) {
			const child = children[index]!;
			const previous = previousSegments[index];
			// Component-scoped frame: a root child outside every requested
			// subtree provably did not change (content mutations route through
			// a render request, which would have made this frame a full one) —
			// reuse its previous rows and seam report without calling render().
			const reuse =
				partialRoots !== null && previous !== undefined && previous.component === child && !partialRoots.has(child);
			let childLines: readonly string[];
			let liveLocalStart: number | undefined;
			let reported: number | undefined;
			if (reuse) {
				childLines = previous.lines;
				liveLocalStart = previous.liveLocalStart;
			} else {
				// Feed the engine's committed-row claim (from the previous frame's
				// emit) before rendering so the child can skip re-deriving blocks
				// that already live in immutable native scrollback. Reused segments
				// skip this: they never call render(), so the signal is moot. The
				// claim is in the previous frame's coordinates and never exceeds
				// the rows the child actually contributed there — history that
				// advanced into LATER root children must not read as this child's
				// own future rows being pre-committed.
				const prevRows = previous !== undefined && previous.component === child ? previous.rowCount : 0;
				const prevStart = previous !== undefined && previous.component === child ? previous.start : offset;
				setNativeScrollbackCommittedRows(child, Math.min(prevRows, Math.max(0, this.#committedRows - prevStart)));
				// A viewport's worth of committed history stays in the frame so a
				// shrink can re-show it instead of painting blank rows (see
				// NativeScrollbackCompaction.setNativeScrollbackRetainRows).
				setNativeScrollbackRetainRows(child, this.terminal.rows);
				childLines = child.render(width);
				// A virtualized child drops rows DURING this render, so the report
				// is read straight after it. Only rows the engine itself reported
				// committed can be dropped, so the total is an offset into the
				// committed prefix and never past it.
				const childDropped = takeNativeScrollbackDroppedRows(child);
				if (childDropped > 0) {
					this.#frameDroppedRows += childDropped;
					// Previous-frame coordinates: the prefix being spliced is the one
					// the last emit built, so the offset must be the child's start
					// THERE, not in the frame being composed now.
					this.#frameDroppedAt = Math.min(this.#frameDroppedAt ?? prevStart, prevStart);
				}
				const liveRegionStart = getNativeScrollbackLiveRegionStart(child);
				if (liveRegionStart !== undefined) {
					liveLocalStart = Number.isFinite(liveRegionStart)
						? clampLow(Math.trunc(liveRegionStart), 0, childLines.length)
						: childLines.length;
				}
				// Consume the stability report unconditionally for implementers:
				// reading re-bases the component's baseline to the state this
				// compose is about to ingest (used or not, the current rows are
				// what ends up in the composed frame). Reused segments are
				// deliberately NOT read — their baseline must stay anchored to
				// the last render the engine actually observed.
				reported = getRenderStablePrefixRows(child);
			}
			// Topmost seam wins. Commits are prefix-only: the first child that
			// reports a live region already bounds everything below it, so a
			// lower sibling's seam (e.g. a status loader under a streaming
			// transcript) must never overwrite it — moving the boundary down
			// would commit the earlier child's still-mutable rows as stale
			// history.
			if (liveLocalStart !== undefined && this.#nativeScrollbackLiveRegionStart === undefined) {
				this.#nativeScrollbackLiveRegionStart = offset + liveLocalStart;
			}
			if (chainStable) {
				if (previous !== undefined && previous.component === child && previous.start === offset) {
					let stableCount = 0;
					if (reported !== undefined) {
						// In-place mutator: its report overrides reference equality.
						// Rows beyond the previous row count cannot be "unchanged".
						stableCount = Number.isFinite(reported)
							? Math.max(0, Math.min(childLines.length, previous.rowCount, Math.trunc(reported)))
							: 0;
					} else if (previous.lines === childLines) {
						stableCount = childLines.length;
					}
					stableRows += stableCount;
					// The chain survives only a fully stable segment: identical rows
					// AND identical row count (a grown/shrunk segment shifts every
					// row below it).
					if (stableCount < childLines.length || previous.rowCount !== childLines.length) chainStable = false;
				} else {
					chainStable = false;
				}
			}
			segments[index] = {
				component: child,
				lines: childLines,
				start: offset,
				rowCount: childLines.length,
				liveLocalStart,
			};
			offset += childLines.length;
		}
		this.#frameSegments = segments;
		// Scroll isolation's pinned footer rows come from the segment ledger:
		// the frame span of the last #pinnedFooterChildCount root children.
		if (this.#pinnedFooterChildCount > 0 && segments.length >= this.#pinnedFooterChildCount) {
			this.#pinnedFooterRows = offset - segments[segments.length - this.#pinnedFooterChildCount]!.start;
		} else {
			this.#pinnedFooterRows = 0;
		}

		const frame = this.#composedFrame;
		// Defensive clamp: stable rows can never exceed what the previous
		// compose actually materialized (only reachable if a child render threw
		// mid-compose on the previous frame).
		if (stableRows > frame.length) stableRows = frame.length;
		if (stableRows !== offset || frame.length !== offset) {
			// Re-ingest every row at/after the stable prefix: truncate, strip
			// cursor markers, record their positions.
			frame.length = stableRows;
			this.#pruneFrameCursorMarkers(stableRows);
			for (const segment of segments) {
				const lines = segment.lines;
				const from = segment.start >= stableRows ? 0 : stableRows - segment.start;
				for (let i = from; i < lines.length; i++) this.#ingestFrameRow(lines[i]!);
			}
		}
		this.#renderStablePrefixRows = stableRows;
		this.#prepared.lowerValidRows(stableRows);
		return frame;
	}

	/** Drop cached cursor markers at/after `fromRow` (those rows re-ingest). */
	#pruneFrameCursorMarkers(fromRow: number): void {
		const markers = this.#frameCursorMarkers;
		let keep = markers.length;
		while (keep > 0 && markers[keep - 1]!.row >= fromRow) keep--;
		markers.length = keep;
	}

	/**
	 * Append one row to the composed frame, stripping CURSOR_MARKER occurrences
	 * (internal sentinels that must never reach the terminal, the committed
	 * prefix, or the resync audit) and recording the first marker's position.
	 */
	#ingestFrameRow(line: string): void {
		let markerIndex = line.indexOf(CURSOR_MARKER);
		if (markerIndex === -1) {
			this.#composedFrame.push(line);
			return;
		}
		this.#frameCursorMarkers.push({
			row: this.#composedFrame.length,
			col: visibleWidth(line.slice(0, markerIndex)),
		});
		let stripped = line;
		while (markerIndex !== -1) {
			stripped = stripped.slice(0, markerIndex) + stripped.slice(markerIndex + CURSOR_MARKER.length);
			markerIndex = stripped.indexOf(CURSOR_MARKER, markerIndex);
		}
		this.#composedFrame.push(stripped);
	}

	#syncTerminalCursorMode(component: Component | null): void {
		if (isFocusable(component)) {
			component.setUseTerminalCursor?.(this.#cursor.show);
		}
	}

	get fullRedraws(): number {
		return this.#fullRedrawCount;
	}

	/**
	 * True while a frame is owed: requested, throttled, or waiting out one of the
	 * quiet windows, and not yet painted. Read-only diagnostic surface like
	 * {@link committedRows}.
	 *
	 * It exists because tests cannot otherwise tell "the engine is idle" from
	 * "the engine has not started yet". Their settle helpers sampled counters
	 * (`committedRows`, `scrollTapeRows`, …) and returned as soon as two samples
	 * matched, which is also exactly what an engine that has not run yet looks
	 * like: nothing has changed BECAUSE nothing has happened. Under a loaded
	 * sweep the throttled frame then landed after the assertion, and the test
	 * failed with a stale frame — `overlay-scroll` read `"status-before"` after
	 * setting the text to `"status-after"`, and the pinned-composer suite
	 * snapshotted a view that three later wheel events then moved. Both were
	 * green alone and only failed in a 378,000-test run, which is the worst kind
	 * of flake: it reads exactly like a regression.
	 *
	 * All four sources of an owed frame count. `#renderRequested` is the request
	 * itself; `#renderTimer` is the throttled/adaptive schedule; the ConPTY
	 * post-full-paint settle and the multiplexer resize settle both hold a frame
	 * back deliberately and then paint it.
	 */
	get renderPending(): boolean {
		return (
			this.#renderRequested ||
			this.#renderTimer !== undefined ||
			this.#postFullPaintSettleTimer !== undefined ||
			this.#multiplexerResizeTimer !== undefined
		);
	}

	/**
	 * Rows of the composed frame the engine has committed to native scrollback
	 * (`frame[0..committedRows)` is the engine's claim of what terminal history
	 * holds). Read-only diagnostic surface: the render-stress harness reads
	 * this claim and verifies it against the terminal's actual scroll behavior
	 * and buffer bytes, so drift between this counter and physical scrollback
	 * is a test failure, never silently re-derived.
	 */
	get committedRows(): number {
		return this.#committedRows;
	}

	/**
	 * Rows on the scroll tape — the engine's mirror of terminal scrollback,
	 * which is what scroll isolation scrolls back through. Read-only.
	 */
	get scrollTapeRows(): number {
		return this.#scrollTape.length;
	}

	/**
	 * Cap the scroll tape (rows). Below the current length the oldest rows are
	 * dropped immediately; they stay reachable through the terminal's own
	 * scrollback. Must be at least one screen or scrolling back has nothing to
	 * show, so the floor is enforced rather than silently accepted.
	 */
	setScrollTapeCap(rows: number): void {
		this.#scrollTape.setCap(rows, this.terminal.rows);
	}

	/**
	 * Append the rows this frame let scroll off the window to the tape.
	 * `rows` are PREPARED lines (exactly the bytes painted), so a frozen view
	 * re-shows history byte-for-byte instead of re-deriving it from components
	 * that may have dropped it.
	 */
	#appendScrollTape(rows: readonly string[], from: number, to: number): void {
		this.#scrollTape.append(rows, from, to);
	}

	/**
	 * Rows in the scroll space: the tape, then the part of the composed frame
	 * that is not already on it (excluding the pinned footer). The frame's first
	 * #committedRows rows are the tape's last #committedRows rows (both came
	 * from the same paint), so only the uncommitted remainder above the pinned
	 * footer is new.
	 */
	#scrollSpaceRows(frameRows = this.#previousFrameLength): number {
		const uncommittedEnd = Math.max(this.#committedRows, frameRows - this.#pinnedFooterRows);
		return this.#scrollTape.length + (uncommittedEnd - this.#committedRows);
	}

	/**
	 * Scroll-space row the live tail's view starts at — the bottom-most view,
	 * which is what "following" shows. Derived from the space's own length and
	 * the scrollable transcript region height (viewport height minus pinned
	 * footer rows).
	 */
	#scrollSpaceLiveTop(frameRows = this.#previousFrameLength): number {
		const height = Math.max(1, this.terminal.rows);
		const footerRows = Math.min(this.#pinnedFooterRows, height - 1);
		const regionRows = height - footerRows;
		return Math.max(0, this.#scrollSpaceRows(frameRows) - regionRows);
	}

	/**
	 * Total row count of the last composed frame (all root children). 0 before the
	 * first render. Read-only; lets callers that need to bottom-anchor content
	 * measure the exact composed height without re-rendering.
	 */
	get composedFrameRows(): number {
		return this.#previousFrameLength;
	}

	/**
	 * Invoked at the top of every frame, before any root child renders. A layout
	 * whose own height is a function of its siblings' heights can be sized only
	 * here: {@link composedFrameRows} describes the PREVIOUS frame, so a
	 * measurement taken outside a frame is against the previous frame's
	 * children. Sizing such a layout after the fact instead composes the frame
	 * past the viewport on the turn its content grows, which moves the window to
	 * fit on that frame and back on the next.
	 *
	 * The callback must not render synchronously and must not mount or unmount a
	 * root child; it may only resize what is already mounted.
	 */
	onBeforeCompose?: () => void;

	/**
	 * Invoked after every frame commit, once the freshly composed row count is
	 * readable via {@link composedFrameRows}. Lets a bottom-anchoring owner
	 * correct its fill against the exact frame instead of a stale estimate; the
	 * callback must not render synchronously — schedule via requestRender()
	 * (a corrected fill converges after one follow-up frame).
	 */
	onFrameComposed?: () => void;

	/**
	 * Transient viewport-only paints emitted by the non-multiplexer resize fast
	 * path. These never touch native scrollback or the commit ledger, so they
	 * are counted apart from {@link fullRedraws}.
	 */
	get resizeViewportPaints(): number {
		return this.#resizeViewportPaintCount;
	}

	/** Whether a non-multiplexer resize drag is currently in flight. */
	get resizeViewportActive(): boolean {
		return this.#resizeViewportActive;
	}

	/** Shared budget that caps how many inline images render as live graphics. */
	get imageBudget(): ImageBudget {
		return this.#imageBudget;
	}

	/**
	 * Set how many inline images stay live graphics before older ones fall back
	 * to text (`0` disables the cap). Older images are hidden via a graphics purge
	 * plus a full redraw on the frame after a new image exceeds the cap.
	 */
	setMaxInlineImages(cap: number): void {
		this.#imageBudget.setCap(cap);
	}

	/**
	 * Get whether scrollback divergence rebuild is enabled.
	 */
	getScrollbackRebuild(): boolean {
		return this.#scrollbackRebuildEnabled;
	}

	/**
	 * Enable or disable scrollback divergence rebuild (default off).
	 * When enabled, the engine will erase and replay the terminal's
	 * scrollback (using ED3 / alt buffer / scrollback replay) to avoid
	 * duplicate blocks when a block's final form replaces its live preview.
	 */
	setScrollbackRebuild(enabled: boolean): void {
		this.#scrollbackRebuildEnabled = enabled;
	}

	/**
	 * Enable or disable scroll isolation (default off). While enabled the TUI
	 * captures wheel/button mouse reports: wheel up freezes the transcript
	 * region on an older slice of the scroll space (the tape plus the live
	 * frame, see {@link scrollTapeRows}) and wheel down walks it back, with the
	 * pinned footer (see {@link setPinnedFooterChildCount}) live at the bottom.
	 * A frozen view resumes following on wheel-down to the tail, on
	 * {@link scrollToLiveTail} (the host calls it on submit), on resize/full
	 * paints, and while an overlay is visible. Enabling mid-session writes
	 * the wheel-tracking mode; disabling restores native terminal scrollback.
	 */
	setScrollIsolation(enabled: boolean): void {
		if (this.#scrollIsolation === enabled) return;
		this.#scrollIsolation = enabled;
		this.#resumeLiveTail();
		this.#syncWheelTracking();
		this.#syncAltScroll();
		this.requestRender();
	}

	/**
	 * Choose how scroll gestures reach the engine (default `"mouse"`, or
	 * `"alt-arrows"` when `VEYYON_TUI_SCROLL_TRANSPORT` selects it).
	 *
	 * Switching to `"alt-arrows"` releases any mouse grab and moves the transcript
	 * to the alternate screen with Alternate Scroll Mode set, so the terminal keeps
	 * native selection and sends wheel ticks as cursor keys. The engine classifies
	 * those itself: only bare legacy cursor sequences are read as the wheel, which a
	 * terminal speaking the kitty keyboard protocol at a level that reports event
	 * types never sends for a real keypress.
	 */
	setScrollTransport(transport: ScrollTransport): void {
		if (this.#scrollTransport === transport) return;
		this.#scrollTransport = transport;
		this.#resumeLiveTail();
		this.#syncWheelTracking();
		this.#syncAltScroll();
		// Which behaviour the operator actually got, since it depends on the terminal
		// rather than on the setting alone: without the kitty keyboard protocol a
		// typed arrow is indistinguishable from a wheel tick and scrolls, and that is
		// worth being able to read off a log rather than infer from surprise.
		logger.info("tui scroll transport selected", {
			transport,
			nativeSelectionPreserved: transport === "alt-arrows",
			typedArrowsReachComposer: transport === "mouse" || this.terminal.kittyProtocolActive === true,
			kittyKeyboardProtocol: this.terminal.kittyProtocolActive === true,
		});
		this.requestRender();
	}

	get scrollTransport(): ScrollTransport {
		return this.#scrollTransport;
	}

	/**
	 * Scroll the frozen transcript region by `rows` (negative scrolls back into
	 * history, positive walks toward the live tail), the same movement the wheel
	 * drives under the mouse transport.
	 *
	 * This is the `"alt-arrows"` entry point: the host receives a cursor-key
	 * sequence it has decided came from the wheel rather than the keyboard and
	 * hands the movement here. Returns true when the gesture was consumed, so a
	 * host that guessed wrong can fall back to normal key handling.
	 */
	scrollByRows(rows: number): boolean {
		if (!this.#scrollIsolation || rows === 0) return false;
		if (!this.#frameScrollable) return false;
		return this.#applyScrollDelta(rows);
	}

	/** Drop the frozen view and its snapshot. One owner: a frozen view that
	 * survives its snapshot would read rows from the live frame at scroll-space
	 * indices, which address different content. */
	#resumeLiveTail(): void {
		this.#virtualScrollTop = null;
		this.#scrollSnapshot = null;
	}

	get scrollIsolation(): boolean {
		return this.#scrollIsolation;
	}

	/** Pin the last `count` root children as scroll isolation's live footer
	 * (the composer zone). The engine derives the footer's row count from the
	 * compose segment ledger after every frame, so zone height changes never
	 * need a host-side sync. */
	setPinnedFooterChildCount(count: number): void {
		this.#pinnedFooterChildCount = Math.max(0, count);
	}

	/** True while the transcript region shows a frozen, scrolled-up slice. */
	get virtualScrollActive(): boolean {
		return this.#virtualScrollTop !== null;
	}

	/**
	 * Rows between the frozen view's top and the live tail — how far back the
	 * reader currently is. Read-only diagnostic surface, like {@link committedRows}:
	 * nothing in the host renders it, because a scroll readout in the composer is
	 * exactly what this change removed. Tests and the stress harness assert it.
	 */
	get virtualScrollNewRows(): number {
		if (this.#virtualScrollTop === null) return 0;
		return Math.max(0, this.#scrollSpaceLiveTop() - this.#virtualScrollTop);
	}

	/**
	 * True when the last composed frame had content above the viewport, so a
	 * scroll-back gesture has somewhere to go. A host renders a scroll affordance
	 * from this rather than re-deriving it from row counts it cannot see.
	 */
	get frameScrollable(): boolean {
		return this.#frameScrollable;
	}

	/** Resume following the live tail (host calls this on message submit). */
	scrollToLiveTail(): void {
		if (this.#virtualScrollTop === null) return;
		this.#resumeLiveTail();
		this.requestRender();
	}

	/** Apply or tear down wheel/button mouse tracking for scroll isolation.
	 * Alt-screen overlays own the full tracking set while active, so this is
	 * a no-op then; the alt-exit path re-syncs.
	 *
	 * The `"alt-arrows"` transport never grabs the mouse — that grab is exactly
	 * what it exists to avoid, since it is what takes native drag-select away.
	 * There it gets its gestures from Alternate Scroll Mode instead. A footer
	 * click target does not override that choice: the operator who picked that
	 * transport asked for the terminal to keep the mouse. */
	#syncWheelTracking(): void {
		const want =
			this.#scrollTransport === "mouse" &&
			this.#scrollIsolation &&
			!this.#stopped &&
			this.#hasEverRendered &&
			!this.#altActive &&
			(this.#frameScrollable || footerWantsPointer(this.#frameSegments, this.#pinnedFooterChildCount));
		if (want === this.#wheelTrackingActive) return;
		this.#wheelTrackingActive = want;
		// A press whose release lands after tracking flips would pair a stale cell
		// with an unrelated report, so the gesture never spans a mode change.
		this.#pressCell = null;
		this.terminal.write(want ? MOUSE_WHEEL_TRACKING_ON : MOUSE_WHEEL_TRACKING_OFF);
	}

	/**
	 * Set or clear Alternate Scroll Mode to match the transport.
	 *
	 * The mode only has meaning while the alternate screen is displayed, but it is
	 * a terminal-level flag rather than a per-buffer one, so it is written when the
	 * transport selects it and cleared when the transport leaves or the engine
	 * stops — never left set behind us, or the operator's next full-screen program
	 * inherits a wheel that types arrow keys.
	 */
	#syncAltScroll(): void {
		const want = this.#scrollTransport === "alt-arrows" && this.#scrollIsolation && !this.#stopped;
		if (want === this.#altScrollActive) return;
		this.#altScrollActive = want;
		this.terminal.write(want ? ALT_SCROLL_ON : ALT_SCROLL_OFF);
	}

	getShowHardwareCursor(): boolean {
		return this.#cursor.show;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (!this.#cursor.setShow(enabled)) return;
		this.#syncTerminalCursorMode(this.#focusedComponent);
		if (!enabled) {
			this.terminal.hideCursor();
			this.#cursor.recordHidden();
		}
		this.requestRender();
	}

	/**
	 * Whether DEC 2026 synchronized-output wrappers are currently emitted around
	 * paints. Starts from conservative terminal/env detection and is reconciled at
	 * runtime against the terminal's DECRQM mode-2026 report — enabled on a
	 * positive report, disabled on a negative one.
	 */
	get synchronizedOutput(): boolean {
		return this.#synchronizedOutputEnabled;
	}
	#deccaraFillsEnabled(): boolean {
		// DECCARA fill rectangles arrive after shortened row text; synchronized
		// output hides that intermediate default-background state from users.
		return TERMINAL.deccara && this.#synchronizedOutputEnabled;
	}

	setFocus(component: Component | null): void {
		const topVisibleOverlay = this.#overlays.topmostInteractive();
		if (topVisibleOverlay && !isOverlayFocusTarget(topVisibleOverlay.component, component)) {
			const currentFocus = this.#focusedComponent;
			component = isOverlayFocusTarget(topVisibleOverlay.component, currentFocus)
				? currentFocus
				: topVisibleOverlay.component;
		}

		const previousFocusedComponent = this.#focusedComponent;
		// Clear focused flag on old component
		if (isFocusable(previousFocusedComponent)) {
			previousFocusedComponent.focused = false;
		}

		this.#focusedComponent = component;

		// Set focused flag on new component and keep its software/hardware cursor
		// rendering mode aligned with TUI's single cursor-visibility preference.
		if (isFocusable(component)) {
			component.focused = true;
			this.#syncTerminalCursorMode(component);
		}
	}

	/** Component currently receiving keyboard input, if any. */
	getFocused(): Component | null {
		return this.#focusedComponent;
	}
	/**
	 * Whether the renderer can still reach `component`, either as a descendant
	 * of the root or as an overlay. A component that has been swapped out of
	 * its container is unreachable, and focusing it aims the keyboard at
	 * something nothing paints and nothing can dismiss.
	 */
	#isAttached(component: Component): boolean {
		const seen = new Set<Component>();
		const search = (children: readonly Component[]): boolean => {
			for (const child of children) {
				if (child === component) return true;
				if (seen.has(child)) continue;
				seen.add(child);
				const nested = (child as Partial<Container>).children;
				if (nested && search(nested)) return true;
			}
			return false;
		};
		if (search(this.children)) return true;
		return search(this.#overlays.components());
	}

	/**
	 * Hand focus back after an overlay closes. An overlay captures the focused
	 * component when it opens and restores it when it closes, and in between
	 * that component can be swapped out of its container and disposed: a
	 * dialog occupying the editor slot is replaced by the next dialog or by
	 * the editor itself. Restoring focus to it aims the keyboard at a
	 * component nothing renders, so the surface underneath looks live and
	 * ignores every keystroke, with no error and nothing to dismiss. A
	 * captured component that has left the tree is therefore dropped in favour
	 * of one that is still in it.
	 */
	#restoreFocusAfterOverlay(preFocus: Component | null): void {
		const topVisible = this.#overlays.topmostInteractive();
		if (topVisible) {
			this.setFocus(topVisible.component);
			return;
		}
		if (preFocus && this.#isAttached(preFocus)) {
			this.setFocus(preFocus);
			return;
		}
		this.setFocus(this.#firstAttachedFocusable() ?? null);
	}

	/** Depth-first search for a focusable component still in the root tree. */
	#firstAttachedFocusable(): Component | null {
		const seen = new Set<Component>();
		const search = (children: readonly Component[]): Component | null => {
			for (const child of children) {
				if (seen.has(child)) continue;
				seen.add(child);
				const nested = (child as Partial<Container>).children;
				if (nested) {
					const found = search(nested);
					if (found) return found;
					continue;
				}
				if (isFocusable(child)) return child;
			}
			return null;
		};
		return search(this.children);
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		component.setIgnoreTight?.(true);
		const entry = { component, options, preFocus: this.#focusedComponent, hidden: false, exiting: false };
		this.#overlays.push(entry);
		// Only focus if overlay is actually visible
		if (this.#overlays.isVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.#cursor.recordHidden();
		this.requestRender();

		/** Drop the entry and hand the terminal back. Idempotent: a second call finds no index. */
		const remove = (): void => {
			if (!this.#overlays.remove(entry)) return;
			if (this.#overlays.size === 0) {
				this.terminal.hideCursor();
				this.#cursor.recordHidden();
			}
			this.requestRender();
		};

		// Return handle for controlling this overlay
		return {
			hide: () => {
				if (entry.exiting || !this.#overlays.holds(entry)) return;
				// Non-interactive FIRST, and only then the focus handoff: the handoff looks for the
				// topmost overlay that can still take input, and a card that is still marked live
				// finds ITSELF and hands its own focus straight back, which is a dismissed overlay
				// that never gives the keyboard up.
				entry.exiting = true;
				// Everything after this point is paint. A card being played out must never answer a
				// keystroke; the operator's next one belongs to whatever they returned to.
				if (isOverlayFocusTarget(component, this.#focusedComponent)) {
					this.#restoreFocusAfterOverlay(entry.preFocus);
				}
				if (canAnimateOverlayExit(component) && component.beginOverlayExit(() => this.requestRender(), remove)) {
					this.requestRender();
					return;
				}
				remove();
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// Update focus when hiding/showing
				if (hidden) {
					// If this overlay or one of its owned targets had focus, move focus
					// to the next visible overlay or back to what it captured.
					if (isOverlayFocusTarget(component, this.#focusedComponent)) {
						this.#restoreFocusAfterOverlay(entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (this.#overlays.isVisible(entry)) {
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
		};
	}

	/** Check if there are any overlays that can still take input. */
	hasOverlay(): boolean {
		return this.#overlays.hasInteractive();
	}

	override invalidate(): void {
		super.invalidate();
		this.#overlays.invalidate();
	}

	start(options?: TUIStartOptions): void {
		this.#stopped = false;
		this.#watchdog.start();
		this.#ghosttyInitialImageDelayDone = false;
		this.#ghosttyImageReadyAtMs = this.#renderScheduler.now() + TUI.#GHOSTTY_INITIAL_IMAGE_DELAY_MS;
		// A DECRQM report for mode 2026 is authoritative: enable synchronized
		// output when the terminal reports support (upgrading conservatively
		// defaulted-off hosts like zellij/tmux-master/foot) and disable it when
		// the terminal reports it unsupported. An explicit user opt-out/force
		// (resolved at construction) still wins, so skip the probe in that case.
		this.terminal.onPrivateModeReport?.((mode, supported) => {
			if (mode !== 2026) return;
			if (synchronizedOutputUserOverride() !== null) return;
			this.#setSynchronizedOutput(supported);
		});
		this.terminal.start(
			data => this.#handleInput(data),
			() => {
				// Real terminals deliver SIGWINCH (and the equivalent ConPTY
				// notification) atomically with the new `process.stdout` geometry, so
				// a forced render must fire immediately: it clears and replays at the
				// fresh size before the terminal's reflow settles into a state a
				// throttled frame would race. Multiplexer panes (tmux/screen/zellij)
				// do not give that guarantee. The host receives SIGWINCH while the
				// multiplexer is still mid-reflow — it has not finished repainting
				// the pane buffer at the new size — and a drag-resize or pane-close
				// animation fires several events in flight. Forcing a render on each
				// event races those mid-reflow paints: the multiplexer's catch-up
				// paint then partially overwrites the TUI output, which the user sees
				// as a viewport flash or blank screen before the next throttled
				// frame arrives (issue #2088). `#armMultiplexerResizeTimer` coalesces
				// SIGWINCHes (and any forced repaints arriving during the settle
				// window) into a single render once the pane is quiet —
				// `#resizeEventPending` is set first so the eventual render still
				// classifies as a resize.
				this.#resizeEventPending = true;
				if (!resizeRepaintsInPlace()) {
					// Enter the viewport fast path and (re)arm the settle timer, then
					// request the cheap viewport-only paint. The authoritative full
					// replay fires from the settle timer once the drag goes quiet.
					this.#beginResizeViewport();
					this.#requestResizeViewportPaint();
					return;
				}
				this.#armMultiplexerResizeTimer(false);
			},
		);
		for (const listener of this.#startListeners) {
			try {
				listener();
			} catch (error) {
				// Startup listeners are feature hooks; one broken hook must not
				// prevent rendering — but a swallowed throw hides a dead feature.
				logger.error("TUI start listener threw; its feature did not initialize", {
					error: errorMessage(error),
				});
			}
		}
		this.terminal.hideCursor();
		this.#cursor.recordHidden();
		this.#sixelProbe.start();
		this.#queryCellSize();
		this.requestRender(true, { clearScrollback: options?.clearScrollback === true });
	}

	addStartListener(listener: StartListener): () => void {
		this.#startListeners.add(listener);
		return () => {
			this.#startListeners.delete(listener);
		};
	}

	addInputListener(listener: InputListener): () => void {
		this.#inputListeners.add(listener);
		return () => {
			this.#inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: InputListener): void {
		this.#inputListeners.delete(listener);
	}

	#queryCellSize(): void {
		// Only query if terminal supports images (cell size is only used for image rendering)
		if (!TERMINAL.imageProtocol) {
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		this.terminal.write("\x1b[16t");
	}

	/**
	 * Toggle synchronized-output (DEC 2026) wrappers on paint/cursor writes and
	 * recompute the cached begin/end sequences. Driven by the terminal's DECRQM
	 * mode-2026 report (#1765 covers the static env opt-out).
	 */
	#setSynchronizedOutput(enabled: boolean): void {
		if (this.#synchronizedOutputEnabled === enabled) return;
		this.#synchronizedOutputEnabled = enabled;
		this.#paintBeginSequence = enabled ? PAINT_BEGIN : PAINT_BEGIN_NO_SYNC;
		this.#paintEndSequence = enabled ? PAINT_END : PAINT_END_NO_SYNC;
		this.#cursor.setFraming(enabled ? CURSOR_BEGIN : CURSOR_BEGIN_NO_SYNC, enabled ? CURSOR_END : CURSOR_END_NO_SYNC);
	}

	stop(): void {
		// Leave the alt buffer first so the teardown cursor math below runs against
		// the restored normal screen (which #previousLines still describes).
		if (this.#resizeAltActive) {
			this.terminal.write(this.#leaveResizeAltSequence());
		}
		if (this.#altActive) {
			const enhancementExit = this.#keyboardEnhancementExit();
			this.terminal.write(`${MOUSE_TRACKING_OFF}${enhancementExit}\x1b[?1049l`);
			setAltScreenActive(false);
			this.#altActive = false;
			this.#altPreviousLines = [];
		}
		if (TERMINAL.imageProtocol === ImageProtocol.Kitty) {
			for (const id of this.#imageBudget.takeAllTransmittedIds()) {
				this.terminal.write(encodeKittyDeleteImage(id));
			}
		}
		this.#sixelProbe.cancel();
		this.#stopped = true;
		this.#syncWheelTracking();
		// Alternate Scroll Mode is a terminal flag, not a per-buffer one, so a
		// stopped engine that left it set would hand the operator's next
		// full-screen program a wheel that types arrow keys.
		this.#syncAltScroll();
		this.#watchdog.stop();
		if (this.#renderTimer) {
			this.#renderTimer.cancel();
			this.#renderTimer = undefined;
		}
		// The request itself, not just its timer: a stopped engine owes no frame,
		// and leaving the flag set made `renderPending` report a frame that could
		// never arrive (`#scheduleRender` refuses while stopped). `start()` issues
		// its own full-paint request, so nothing depends on carrying this across.
		this.#renderRequested = false;
		if (this.#ghosttyInitialImageDelayTimer) {
			this.#ghosttyInitialImageDelayTimer.cancel();
			this.#ghosttyInitialImageDelayTimer = undefined;
		}
		if (this.#multiplexerResizeTimer) {
			this.#multiplexerResizeTimer.cancel();
			this.#multiplexerResizeTimer = undefined;
		}
		if (this.#resizeViewportSettleTimer) {
			this.#resizeViewportSettleTimer.cancel();
			this.#resizeViewportSettleTimer = undefined;
		}
		this.#resizeViewportActive = false;
		this.#clearPostFullPaintSettle();
		this.#deferredForcedClearScrollback = false;
		// A resident alt-buffer session holds the transcript nowhere the terminal can
		// see, so leaving the alt screen would take the whole conversation off screen
		// with it: no scrollback to page through, nothing for the terminal's own find
		// to search, nothing for tmux copy-mode. Replay it onto the normal screen on
		// the way out, so the session ends with the terminal holding the transcript
		// exactly as the native-scrollback surface would have left it.
		//
		// This runs before the parent-shell cursor placement below, and it deliberately
		// re-bases that math: the replay scrolls the normal screen, so the frame length
		// the placement reasons about is the replay's own tail, not the pre-exit frame.
		const replayedRows = this.#replayTranscriptToNormalScreen();
		// Place the parent shell on the first line after the rendered content. When
		// that line is still inside the viewport, moving there and writing `\r` is
		// enough; emitting `\r\n` would create an extra blank row. If the content
		// already reaches the viewport bottom, scroll exactly once so the prompt
		// lands directly below the last visible TUI row.
		if (replayedRows === 0 && this.#previousFrameLength > 0) {
			const targetRow = this.#previousFrameLength;
			const viewportBottom = this.#windowTopRow + this.terminal.rows - 1;
			const clampedCursorRow = clampLow(this.#cursor.row, this.#windowTopRow, viewportBottom);
			const moveTargetRow = Math.min(targetRow, viewportBottom);
			const lineDiff = moveTargetRow - clampedCursorRow;
			if (lineDiff > 0) {
				this.terminal.write(`\x1b[${lineDiff}B`);
			} else if (lineDiff < 0) {
				this.terminal.write(`\x1b[${-lineDiff}A`);
			}
			this.terminal.write(targetRow <= viewportBottom ? "\r" : "\r\n");
		}

		this.terminal.showCursor();
		this.#cursor.forget();
		this.terminal.stop();
	}

	/**
	 * Replay a resident alt-buffer transcript onto the normal screen, so terminal
	 * scrollback, the terminal's own find, and tmux copy-mode can see the
	 * conversation after veyyon exits. Returns the number of rows written, or 0 when
	 * there was nothing to replay (the native-scrollback surface already leaves the
	 * transcript in the terminal, so it replays nothing).
	 *
	 * The source is the scroll tape plus the live tail captured by the last resident
	 * paint, which together are the full transcript this surface holds — the tape is
	 * the only copy here rather than a mirror of terminal scrollback. It is capped
	 * (see {@link setScrollTapeCap}), so a very long session replays its most recent
	 * rows rather than growing without bound; the session file on disk remains the
	 * complete record either way.
	 *
	 * A crash cannot run this. That is a real limit and not worth pretending
	 * otherwise: the alt buffer restores whatever preceded launch, and the transcript
	 * is then only in the session file.
	 */
	#replayTranscriptToNormalScreen(): number {
		if (!this.#altTranscriptReplayPending) return 0;
		this.#altTranscriptReplayPending = false;
		const rows = [...this.#scrollTape.rows, ...this.#altTailRows];
		if (rows.length === 0) return 0;
		// Written as prepared rows with an explicit terminator each, exactly like the
		// native surface commits them, so styles and hyperlinks cannot bleed between
		// lines once they are in the terminal's own history.
		let buffer = "";
		for (const row of rows) buffer += `${row}${LINE_TERMINATOR}\r\n`;
		this.terminal.write(buffer);
		return rows.length;
	}

	/**
	 * Force an immediate full replay of the current frame, including native
	 * scrollback. This is the keyboard-accessible equivalent of the resize reset:
	 * no queued diff frame or terminal scrollback probe can downgrade it to a
	 * viewport-only repaint.
	 *
	 * Invalidates every component first so the replay reflects current state. A
	 * geometry-driven reset thaws frozen scrollback snapshots implicitly (the new
	 * width misses every cached snapshot), but a same-width reset would otherwise
	 * replay stale snapshots — leaving host-frozen blocks (e.g. a transcript whose
	 * committed rows are immutable on ED3-risk terminals) showing pre-mutation
	 * content. Invalidation is the generic signal those containers use to retire
	 * their snapshots, which is exactly what a user-driven display reset wants.
	 */
	resetDisplay(): void {
		if (this.#stopped) return;
		this.invalidate();
		// A reset that lands inside a tmux/screen/zellij resize burst would
		// paint mid-reflow and re-introduce the flash race (issue #2088).
		// Fold it into the in-flight debounce instead; the settled paint runs
		// the same `#prepareForcedRender(!isMultiplexerSession())` path via
		// `requestRender(true)`, so the clear-scrollback intent is preserved.
		if (this.#multiplexerResizeTimer) {
			this.#armMultiplexerResizeTimer(!isMultiplexerSession());
			return;
		}
		this.#prepareForcedRender(!isMultiplexerSession());
		this.#resizeEventPending = true;
		this.#renderRequested = false;
		this.#executeRender();
	}

	requestRender(force = false, options?: RenderRequestOptions): void {
		// Any non-component-scoped request makes the pending frame a full one.
		this.#pendingRenderComponentsOnly = false;
		if (force) {
			// Forced repaints landing inside the multiplexer resize debounce
			// (e.g. `#finishSixelProbe`, image-budget eviction, a programmatic
			// `requestRender(true)`) would paint into a still-reflowing pane
			// and reintroduce the flash race. Fold them into the in-flight
			// debounce while preserving the caller's `clearScrollback` intent
			// for the settled paint. The timer's own callback clears
			// `#multiplexerResizeTimer` before re-entering `requestRender(true)`,
			// so this guard only catches external callers — the deferred render
			// itself proceeds straight to `#prepareForcedRender`.
			if (this.#multiplexerResizeTimer) {
				this.#armMultiplexerResizeTimer(options?.clearScrollback === true);
				return;
			}
			// A forced render preempts the post-full-paint ConPTY settle: it owns
			// the next paint and is going to redraw the buffer anyway, so the
			// trailing coalesced render queued by the settle would only race it.
			this.#clearPostFullPaintSettle();
			this.#prepareForcedRender(options?.clearScrollback === true);
			this.#renderRequested = true;
			this.#renderScheduler.scheduleImmediate(() => {
				if (this.#stopped || !this.#renderRequested) {
					return;
				}
				this.#renderRequested = false;
				this.#executeRender();
			});
			return;
		}
		this.#requestOrdinaryRender();
	}

	/**
	 * Schedule a render on behalf of `component` after a self-contained change
	 * (spinner frame, blink) that cannot have affected any other component.
	 *
	 * When every request since the last frame is component-scoped and the
	 * frame is otherwise quiet — no resize or geometry change, no overlays, no
	 * live inline images, no forced repaint, unchanged root child list — the
	 * next compose re-renders only the root subtrees containing the requesting
	 * components and reuses the previous frame's rows (and seam reports) for
	 * every other root child, skipping the full component-tree walk that makes
	 * long transcripts expensive to repaint at animation rate. Any concurrent
	 * full request or unsafe condition downgrades the frame to a normal full
	 * compose, so this is never less correct than `requestRender()` — only
	 * cheaper.
	 */
	requestComponentRender(component: Component): void {
		if (this.#stopped) return;
		// Start a component-scoped accumulation only when nothing else is in
		// flight (a pending throttled request or a deferred ConPTY settle
		// replay may carry full-render intent that must not be narrowed).
		if (!this.#renderRequested && this.#postFullPaintSettleTimer === undefined) {
			this.#pendingRenderComponentsOnly = true;
		}
		this.#componentRenderTargets.add(component);
		this.#requestOrdinaryRender();
	}

	/**
	 * Rewrite a quiet, visible component segment directly.
	 *
	 * Loader-style animation changes one already-positioned segment at a fixed
	 * size. When the current frame geometry is still valid, rewrite just those
	 * rows and update the diff baseline instead of scheduling a full render
	 * cycle. Unsafe states fall back to `requestComponentRender()`, preserving
	 * the ordinary renderer as the correctness path.
	 */
	requestDirectWrite(component: Component): void {
		if (this.#stopped) return;
		if (
			this.#renderRequested ||
			this.#postFullPaintSettleTimer !== undefined ||
			this.#postFullPaintSettleUntilMs > 0
		) {
			this.requestComponentRender(component);
			return;
		}

		const width = this.terminal.columns;
		const height = this.terminal.rows;
		if (!this.#hasEverRendered || this.#resizeEventPending) {
			this.requestComponentRender(component);
			return;
		}
		if (width !== this.#previousWidth || height !== this.#previousHeight || width !== this.#composeWidth) {
			this.requestComponentRender(component);
			return;
		}
		if (this.#clearScrollbackOnNextRender || this.#forceViewportRepaintOnNextRender) {
			this.requestComponentRender(component);
			return;
		}
		if (this.#overlays.size > 0 || this.#altActive || !this.#imageBudget.quiescent) {
			this.requestComponentRender(component);
			return;
		}

		const children = this.children;
		const segments = this.#frameSegments;
		if (segments.length !== children.length) {
			this.requestComponentRender(component);
			return;
		}
		for (let i = 0; i < children.length; i++) {
			if (segments[i]!.component !== children[i]) {
				this.requestComponentRender(component);
				return;
			}
		}

		const root = this.#resolveComponentRoot(component);
		if (root === null) {
			this.requestComponentRender(component);
			return;
		}
		const segmentIndex = segments.findIndex(segment => segment.component === root);
		if (segmentIndex === -1) {
			this.requestComponentRender(component);
			return;
		}
		const segment = segments[segmentIndex]!;
		const fullyLiveUncommittedSegment = segment.liveLocalStart === 0 && segment.start >= this.#committedRows;
		if (
			(segment.liveLocalStart !== undefined && !fullyLiveUncommittedSegment) ||
			segment.start < this.#committedRows
		) {
			this.requestComponentRender(component);
			return;
		}

		const windowTop = Math.max(this.#committedRows, this.#composedFrame.length - height, 0);
		if (windowTop !== this.#windowTopRow) {
			this.requestComponentRender(component);
			return;
		}
		const screenStart = segment.start - windowTop;
		if (screenStart < 0 || screenStart + segment.rowCount > height) {
			this.requestComponentRender(component);
			return;
		}

		const nextLines = root.render(width);
		if (nextLines.length !== segment.rowCount) {
			this.requestComponentRender(component);
			return;
		}
		for (const line of nextLines) {
			if (line.includes(CURSOR_MARKER)) {
				this.requestComponentRender(component);
				return;
			}
		}

		let firstChanged = -1;
		let lastChanged = -1;
		const previousWindow = this.#previousWindow;
		for (let i = 0; i < nextLines.length; i++) {
			const frameRow = segment.start + i;
			const raw = nextLines[i]!;
			const prepared = prepareLine(raw, width);
			this.#composedFrame[frameRow] = raw;
			this.#prepared.setRow(frameRow, prepared);
			if (previousWindow[screenStart + i] === prepared.line) continue;
			previousWindow[screenStart + i] = prepared.line;
			if (firstChanged === -1) firstChanged = i;
			lastChanged = i;
		}
		segments[segmentIndex] = { ...segment, lines: nextLines };
		this.#prepared.raiseValidRows(segment.start + nextLines.length);
		this.#renderStablePrefixRows = Math.min(this.#renderStablePrefixRows, segment.start);

		let cursorPos: { row: number; col: number } | null = null;
		for (let i = this.#frameCursorMarkers.length - 1; i >= 0; i--) {
			const marker = this.#frameCursorMarkers[i]!;
			if (marker.row >= windowTop) {
				cursorPos = marker;
				break;
			}
		}

		if (firstChanged === -1) {
			this.#cursor.writePosition(this.terminal, cursorPos, this.#composedFrame.length);
			this.#previousWidth = width;
			this.#previousHeight = height;
			return;
		}

		const currentScreenRow = clampLow(this.#cursor.row - windowTop, 0, height - 1);
		const targetScreenRow = screenStart + firstChanged;
		const rowDelta = targetScreenRow - currentScreenRow;
		let buffer = this.#paintBeginSequence;
		if (rowDelta > 0) buffer += `\x1b[${rowDelta}B`;
		else if (rowDelta < 0) buffer += `\x1b[${-rowDelta}A`;
		buffer += "\r";
		for (let i = firstChanged; i <= lastChanged; i++) {
			if (i > firstChanged) buffer += "\r\n";
			buffer += lineRewriteSequence(this.#prepared.rowAt(segment.start + i) ?? "", width);
		}
		const cursorControl = this.#cursor.controlSequence(
			cursorPos,
			this.#composedFrame.length,
			segment.start + lastChanged,
		);
		buffer += cursorControl.seq;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);
		this.#windowTopRow = windowTop;
		this.#commit(this.#composedFrame, previousWindow, width, height, cursorControl);
	}

	/** Ordinary (non-forced) scheduling shared by full and component-scoped requests. */
	#requestOrdinaryRender(): void {
		// Coalesce non-forced renders inside the post-full-paint ConPTY settle
		// window into one trailing render. Spinner/blink/streaming components
		// otherwise fire `requestRender(false)` at 30 Hz while the host is still
		// catching up with the previous big paint, and each follow-up viewport
		// repaint nudges Windows Terminal's viewport tracker further off the
		// last row (see #2095).
		if (this.#postFullPaintSettleUntilMs > 0) {
			const now = this.#renderScheduler.now();
			if (now < this.#postFullPaintSettleUntilMs) {
				if (this.#postFullPaintSettleTimer === undefined) {
					this.#postFullPaintSettleTimer = this.#renderScheduler.scheduleRender(() => {
						this.#postFullPaintSettleTimer = undefined;
						this.#postFullPaintSettleUntilMs = 0;
						if (this.#stopped) return;
						this.#requestOrdinaryRender();
					}, this.#postFullPaintSettleUntilMs - now);
				}
				return;
			}
			this.#postFullPaintSettleUntilMs = 0;
		}
		if (this.#renderRequested) return;
		this.#renderRequested = true;
		this.#renderScheduler.scheduleImmediate(() => this.#scheduleRender());
	}

	/**
	 * Decide whether this frame may compose component-scoped, and resolve the
	 * requested components to the root children that must re-render. Returns
	 * null — full compose — whenever a global condition could invalidate rows
	 * the partial compose would reuse, or when a requested component is not
	 * reachable from the current root child list.
	 */
	#resolvePartialComposeRoots(width: number, height: number): Set<Component> | null {
		if (this.#componentRenderTargets.size === 0) return null;
		if (!this.#hasEverRendered || this.#resizeEventPending) return null;
		if (width !== this.#previousWidth || height !== this.#previousHeight || width !== this.#composeWidth) return null;
		if (this.#clearScrollbackOnNextRender || this.#forceViewportRepaintOnNextRender) return null;
		if (this.#overlays.size > 0) return null;
		// The image budget audits display order across the whole frame; a
		// partial walk would under-count it. Engage only on image-free frames.
		if (!this.#imageBudget.quiescent) return null;
		// The root child list must match the segment ledger exactly — a
		// structural change shifts offsets under every reused segment.
		const children = this.children;
		const segments = this.#frameSegments;
		if (segments.length !== children.length) return null;
		for (let i = 0; i < children.length; i++) {
			if (segments[i]!.component !== children[i]) return null;
		}
		const roots = this.#partialComposeRootsScratch;
		roots.clear();
		for (const target of this.#componentRenderTargets) {
			const root = this.#resolveComponentRoot(target);
			if (root === null) return null;
			roots.add(root);
		}
		return roots;
	}

	/** Root child whose subtree contains `target`, memoized per component. */
	#resolveComponentRoot(target: Component): Component | null {
		const cached = this.#componentRootCache.get(target);
		if (cached !== undefined && this.children.includes(cached) && subtreeContains(cached, target)) {
			return cached;
		}
		for (const child of this.children) {
			if (subtreeContains(child, target)) {
				this.#componentRootCache.set(target, child);
				return child;
			}
		}
		this.#componentRootCache.delete(target);
		return null;
	}

	/**
	 * Arm or extend the multiplexer-resize debounce so a single forced render
	 * fires once the pane is quiet. Called by the SIGWINCH callback on every
	 * resize event, and by `requestRender(true)` / `resetDisplay()` when they
	 * land inside an in-flight settle window. Each call cancels the prior
	 * timer, supersedes any queued throttled render (otherwise it would race
	 * tmux's mid-reflow paint), and OR's the caller's `clearScrollback`
	 * intent into `#deferredForcedClearScrollback` — the timer's callback
	 * consumes that flag exactly once when it re-enters `requestRender(true)`.
	 */
	#armMultiplexerResizeTimer(clearScrollback: boolean): void {
		this.#deferredForcedClearScrollback ||= clearScrollback;
		if (this.#renderTimer) {
			this.#renderTimer.cancel();
			this.#renderTimer = undefined;
		}
		this.#renderRequested = false;
		if (this.#multiplexerResizeTimer) {
			this.#multiplexerResizeTimer.cancel();
		}
		this.#multiplexerResizeTimer = this.#renderScheduler.scheduleRender(() => {
			this.#multiplexerResizeTimer = undefined;
			if (this.#stopped) {
				this.#deferredForcedClearScrollback = false;
				return;
			}
			const deferredClearScrollback = this.#deferredForcedClearScrollback;
			this.#deferredForcedClearScrollback = false;
			this.requestRender(true, { clearScrollback: deferredClearScrollback });
		}, TUI.#MULTIPLEXER_RESIZE_DEBOUNCE_MS);
	}

	/**
	 * Arm the post-full-paint settle window after an `#emitFullPaint` that
	 * pushed content into native scrollback on a ConPTY host. Idempotent inside
	 * the window: a later overflowing paint extends `until` to the later
	 * deadline so back-to-back big paints do not double-fire the trailing
	 * coalesced render, and the existing deferred timer is rescheduled to the
	 * later deadline.
	 *
	 * Mid-composition callers (most notably `ImageBudget.endPass()`, which can
	 * call `requestRender()` from inside the in-flight paint when a new image
	 * trips the budget) queue their render *before* the settle exists, so they
	 * fall through the gate and set `#renderRequested` / `#renderTimer` on the
	 * 30 Hz throttle. Without absorbing those, the throttled follow-up fires
	 * inside the 150 ms quiet window and reintroduces the cascade the settle
	 * was meant to stop. Cancel both, then eagerly arm the trailing settle
	 * timer so the in-flight request still rides one coalesced render at the
	 * end of the window. See #2095.
	 */
	#armPostFullPaintSettle(): void {
		if (!isConPTYHosted()) return;
		const until = this.#renderScheduler.now() + TUI.#CONPTY_POST_FULL_PAINT_SETTLE_MS;
		if (until <= this.#postFullPaintSettleUntilMs) return;
		this.#postFullPaintSettleUntilMs = until;
		const hadPendingRender = this.#renderRequested || this.#renderTimer !== undefined;
		// Reclaim any render that was queued during the in-flight composition:
		// `#renderRequested` was set before the settle existed and would
		// otherwise fire on the standard throttle inside the window.
		this.#renderRequested = false;
		if (this.#renderTimer) {
			this.#renderTimer.cancel();
			this.#renderTimer = undefined;
		}
		if (this.#postFullPaintSettleTimer) {
			this.#postFullPaintSettleTimer.cancel();
			this.#postFullPaintSettleTimer = undefined;
		}
		if (hadPendingRender) {
			// Replay the absorbed request via the trailing settle timer so the
			// caller's render still happens — just deferred to the end of the
			// window. Subsequent `requestRender(false)` calls during the
			// settle see this timer and fold into it (existing gate at L1263).
			this.#postFullPaintSettleTimer = this.#renderScheduler.scheduleRender(() => {
				this.#postFullPaintSettleTimer = undefined;
				this.#postFullPaintSettleUntilMs = 0;
				if (this.#stopped) return;
				this.#requestOrdinaryRender();
			}, TUI.#CONPTY_POST_FULL_PAINT_SETTLE_MS);
		}
	}

	#clearPostFullPaintSettle(): void {
		if (this.#postFullPaintSettleTimer) {
			this.#postFullPaintSettleTimer.cancel();
			this.#postFullPaintSettleTimer = undefined;
		}
		this.#postFullPaintSettleUntilMs = 0;
	}

	#maybeDeferGhosttyInitialImagePaint(): boolean {
		if (this.#ghosttyInitialImageDelayDone) return false;
		if (TERMINAL.id !== "ghostty" || TERMINAL.imageProtocol !== ImageProtocol.Kitty) {
			this.#ghosttyInitialImageDelayDone = true;
			return false;
		}
		if (!this.#imageBudget.hasPendingTransmits()) return false;
		if (this.#ghosttyInitialImageDelayTimer) return true;

		const delayMs = Math.max(0, this.#ghosttyImageReadyAtMs - this.#renderScheduler.now());
		if (delayMs === 0) {
			this.#ghosttyInitialImageDelayDone = true;
			return false;
		}

		this.#ghosttyInitialImageDelayTimer = this.#renderScheduler.scheduleRender(() => {
			this.#ghosttyInitialImageDelayTimer = undefined;
			this.#ghosttyInitialImageDelayDone = true;
			if (this.#stopped) return;
			this.#executeRender();
			if (this.#renderRequested) this.#scheduleRender();
		}, delayMs);
		return true;
	}
	#prepareForcedRender(clearScrollback: boolean): void {
		this.#clearScrollbackOnNextRender ||= clearScrollback;
		this.#forceViewportRepaintOnNextRender = true;
		if (this.#renderTimer) {
			this.#renderTimer.cancel();
			this.#renderTimer = undefined;
		}
	}

	#scheduleRender(): void {
		if (this.#stopped || this.#renderTimer || !this.#renderRequested) {
			return;
		}
		// Defer any new throttled render scheduled inside the multiplexer
		// resize settle window: it would race tmux's mid-reflow pane repaint.
		// `#renderRequested` stays set so the eventual forced render — armed
		// by the SIGWINCH callback — picks up the latest component state.
		if (this.#multiplexerResizeTimer) {
			return;
		}
		const now = this.#renderScheduler.now();
		const elapsed = now - this.#lastRenderAt;
		const cadenceDelay = Math.max(0, TUI.#MIN_RENDER_INTERVAL_MS - elapsed);
		// Adaptive backpressure — target ~50% render duty cycle: the next frame
		// starts no sooner than `frame_end + estimated_cost`, i.e.
		// `frame_start + 2 × estimated_cost`. So `elapsed` (which counts from
		// the last frame's start) must already exceed twice the estimate before
		// we allow the follow-up render to fire. The estimate is decayed rather
		// than the previous sample, so a sustained slow loop is held to half the
		// CPU (#4145) and an isolated expensive paint is not charged to the
		// cheap frame behind it. Capped so a pathological cost cannot lock the UI.
		const adaptiveFloor = Math.min(TUI.#MAX_ADAPTIVE_RENDER_MS, this.#frameCostEstimateMs * 2);
		const adaptiveDelay = Math.max(0, adaptiveFloor - elapsed);
		const inputGraceDelay = Math.max(0, this.#inputRenderGraceUntilMs - now);
		const delay = Math.max(cadenceDelay, adaptiveDelay, inputGraceDelay);
		this.#renderTimer = this.#renderScheduler.scheduleRender(() => {
			this.#renderTimer = undefined;
			if (this.#stopped || !this.#renderRequested) {
				return;
			}
			this.#renderRequested = false;
			this.#executeRender();
			if (this.#renderRequested) {
				this.#scheduleRender();
			}
		}, delay);
	}

	/**
	 * Wrap `#doRender()` so every path records the wall-clock frame cost that
	 * feeds adaptive backpressure. Set `#lastRenderAt` first (some render code
	 * reads it re-entrantly) and compute the cost once the paint returns.
	 *
	 * The phase is what a blocked frame is reported as. A compose walks every
	 * component, wraps every line of the transcript and diffs the frame, and it
	 * is the longest synchronous span in an interactive session by a wide margin,
	 * so a `ui.loop-blocked` line with no phase was nearly always this. Two array
	 * operations per frame buys the watchdog a cause it can name.
	 */
	#executeRender(): void {
		const start = this.#renderScheduler.now();
		this.#lastRenderAt = start;
		pushLoopPhase("ui.render");
		try {
			this.#doRender();
		} finally {
			popLoopPhase();
			const costMs = this.#renderScheduler.now() - start;
			this.#frameCostEstimateMs += TUI.#FRAME_COST_SMOOTHING * (costMs - this.#frameCostEstimateMs);
		}
	}

	#handleIsolationWheel(direction: -1 | 1): void {
		this.#applyScrollDelta(this.#wheelAccel.step(direction, this.#renderScheduler.now()));
	}

	/**
	 * Move the frozen transcript view by `rows` in SCROLL-SPACE coordinates: the
	 * tape's rows, then the frame's uncommitted rows, where 0 is the oldest row
	 * the tape still holds and the live tail's view starts at
	 * `#scrollSpaceLiveTop()`. Negative scrolls back into history, positive walks
	 * toward the tail and resumes following once it reaches it.
	 *
	 * One owner for both transports: the wheel path applies its acceleration and
	 * calls this, and the `"alt-arrows"` path routes host-classified cursor keys
	 * here, so the two can never drift on where the view may stop. Returns false
	 * when the gesture changed nothing, which is what lets a mis-classified arrow
	 * fall back to ordinary key handling instead of being silently swallowed.
	 */
	#applyScrollDelta(rows: number): boolean {
		const liveTop = this.#scrollSpaceLiveTop();
		if (rows < 0) {
			// Nothing above the live window at all (fresh session, short frame):
			// stay following instead of freezing a view with nothing behind it.
			if (liveTop === 0 && this.#virtualScrollTop === null) return false;
			const next = Math.max(0, (this.#virtualScrollTop ?? liveTop) + rows);
			if (next === this.#virtualScrollTop) return false; // already at the oldest row
			this.#virtualScrollTop = next;
		} else if (this.#virtualScrollTop !== null) {
			const next = this.#virtualScrollTop + rows;
			if (next >= liveTop) {
				this.#resumeLiveTail();
			} else {
				this.#virtualScrollTop = next;
			}
		} else {
			return false; // scrolling toward the tail while already following it
		}
		this.requestRender();
		return true;
	}

	/**
	 * Every byte the terminal delivers enters here, so this is the second of the
	 * two spans an interactive session spends its synchronous time in. A keystroke
	 * runs the focused component's handler, and that handler can filter a large
	 * list, rebuild a completion set or reflow the composer; without the phase all
	 * of it was reported as a block with no cause.
	 *
	 * The dispatch is a separate method because it returns from a dozen places and
	 * a `finally` around the whole body is the only way to pop the phase on each
	 * one.
	 */
	#handleInput(data: string): void {
		pushLoopPhase("ui.input");
		try {
			this.#dispatchInput(data);
		} finally {
			popLoopPhase();
		}
	}

	#dispatchInput(data: string): void {
		// Ctrl+C/Esc use app-level double-press windows. Give those gestures one
		// frame to drain queued input before an ordinary repaint; delaying every
		// key would make idle navigation pay a full frame of latency.
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
			this.#inputRenderGraceUntilMs = this.#renderScheduler.now() + TUI.#INPUT_RENDER_GRACE_MS;
		}
		if (this.#inputListeners.size > 0) {
			let current = data;
			for (const listener of this.#inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		// Consume terminal cell size responses without blocking unrelated input.
		if (this.#consumeCellSizeResponse(data)) {
			return;
		}

		// Scroll isolation owns every SGR mouse report while wheel tracking is
		// on and no alt-screen overlay is active: the wheel scrolls the frozen
		// transcript region, a click in the pinned footer (band or composer)
		// snaps back to the live tail, and any other report is swallowed so
		// clicks never leak raw SGR bytes into the focused component.
		if (this.#wheelTrackingActive && !this.#altActive && data.startsWith("\x1b[<")) {
			const event = parseSgrMouse(data);
			if (event) {
				if (event.wheel) {
					this.#pressCell = null;
					this.#handleIsolationWheel(event.wheel);
					return;
				}
				const { footerTop, footerBottom, footerRowOffset, contentBottom } = pinnedFooterScreenBounds({
					virtualScrollTop: this.#virtualScrollTop,
					terminalRows: this.terminal.rows,
					pinnedFooterRows: this.#pinnedFooterRows,
					composedFrameRows: this.#composedFrame.length,
					windowTopRow: this.#windowTopRow,
				});
				// A press-then-release in a different cell is a drag, and with the
				// mouse held by the engine that drag selected nothing. Report it so
				// the host can name Shift+drag and the copy picker. Tracking mode is
				// 1000h (press/release only, no motion reports), so the release is
				// the first and only chance to see the gesture.
				if (event.leftClick) {
					this.#pressCell =
						event.row >= 0 && event.row < footerTop && event.row <= contentBottom
							? { row: event.row, col: event.col }
							: null;
				} else if (event.release) {
					const press = this.#pressCell;
					this.#pressCell = null;
					if (press && (press.row !== event.row || press.col !== event.col)) {
						this.onSelectionAttempt?.();
					}
				}
				if (
					event.leftClick &&
					this.#pinnedFooterRows > 0 &&
					event.row >= footerTop &&
					event.row <= footerBottom &&
					event.row >= 0 &&
					event.row < this.terminal.rows
				) {
					// A click in the pinned footer is routed to the child under it
					// (MouseRoutable components get frame-local coordinates), so
					// footer chrome like the status footline can own click targets.
					if (
						routeFooterMouse(
							this.#frameSegments,
							this.#pinnedFooterRows,
							this.#pinnedFooterChildCount,
							event,
							event.row - footerRowOffset,
						)
					) {
						this.requestRender();
					}
					if (this.#virtualScrollTop !== null) {
						// Chat idiom: engaging the composer returns to the present.
						this.scrollToLiveTail();
					}
				}
				return;
			}
		}

		// Alternate Scroll Mode delivers a wheel tick as a bare cursor-up/down key
		// (xterm's `alternateScroll`: "the scroll-back and scroll-forw actions send
		// cursor-up and -down keys"), so this is where the "alt-arrows" transport
		// reads the wheel. Only the LEGACY forms are taken, and that is the whole
		// disambiguation: under the kitty keyboard protocol at a level that reports
		// event types, a key the operator actually pressed arrives as a CSI-u
		// sequence and never matches here, so the composer keeps its arrows while the
		// wheel still scrolls. Where the terminal does not speak that protocol the two
		// are genuinely indistinguishable, and the chosen fallback is that arrows
		// scroll rather than the gesture meaning different things depending on state.
		// The cost there is concrete and worth knowing: the composer keeps every other
		// key, but Up/Down stop moving the caret between the lines of a multi-line
		// draft. Nothing else is lost, because arrows drive no prompt-history walk in
		// this host — there is none to rebind.
		//
		// A gesture the view cannot honor (already at the oldest row, or already
		// following the tail) is NOT consumed, so a typed arrow on a fallback
		// terminal still reaches the focused component instead of vanishing.
		if (this.#altActive && !this.#altOverlayBorrow && this.#altTranscriptWanted()) {
			const scroll = LEGACY_CURSOR_SCROLL[data];
			if (scroll !== undefined && this.scrollByRows(scroll * CURSOR_KEY_SCROLL_ROWS)) {
				return;
			}
		}

		// Global debug key handler (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// If focused component is an overlay, verify it can still take input (visibility can change
		// due to terminal resize or the `visible()` callback, and a card that is playing itself out
		// stops being interactive before it stops being drawn).
		const focusedOverlay = this.#overlays.entries.find(o => o.component === this.#focusedComponent);
		if (focusedOverlay && !this.#overlays.isInteractive(focusedOverlay)) {
			// Focused overlay went invisible under us (resize, or its visible()
			// callback). Hand focus on the same way a close does.
			this.#restoreFocusAfterOverlay(focusedOverlay.preFocus);
		}

		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.#focusedComponent?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !this.#focusedComponent.wantsKeyRelease) {
				return;
			}
			this.#focusedComponent.handleInput(data);
			this.requestRender();
		}
	}

	#consumeCellSizeResponse(data: string): boolean {
		// Response format: ESC [ 6 ; height ; width t
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1], 10);
		const widthPx = parseInt(match[2], 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		// Invalidate all components so images re-render with correct dimensions.
		this.invalidate();
		this.requestRender();
		return true;
	}

	/**
	 * Render one frame.
	 *
	 * Append-only pipeline: compose the frame, derive the commit boundary from
	 * the component-reported live-region seam, advance the committed-row count
	 * monotonically, and emit either a gesture-driven full paint or an
	 * incremental update. Scrollback is `frame[0..committedRows)` at all
	 * times — no viewport probes, no deferred reconciliation.
	 */
	#doRender(): void {
		if (this.#stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;

		// Size any sibling-dependent layout before the children render, while a
		// measurement of them is still a measurement of THIS frame.
		this.onBeforeCompose?.();

		// Consume the component-scoped accumulation: it describes the render
		// requests made up to this frame, whichever path the frame takes.
		const componentScopedOnly = this.#pendingRenderComponentsOnly;
		this.#pendingRenderComponentsOnly = false;

		// Alt-screen residency has two independent reasons, and they behave
		// differently once up:
		//
		// - A fullscreen overlay BORROWS the buffer: the engine paints only the
		//   modal, grabs the full mouse-tracking set for hit-testing, and the
		//   normal screen plus all accounting stay untouched.
		// - The `"alt-arrows"` scroll transport RESIDES there: the transcript
		//   itself lives on the alt buffer so the terminal will translate the wheel
		//   into cursor keys (Alternate Scroll Mode), and mouse tracking is exactly
		//   what must NOT be enabled, since grabbing it is what breaks selection.
		//
		// So the enter sequence depends on the reason, and residency must survive an
		// overlay opening and closing on top of it — an overlay's exit writing
		// `1049l` would otherwise drop the transcript back to the normal screen with
		// the mode still set and the wheel typing arrows into the composer.
		const overlayWantsAlt = this.#wantsAltScreen();
		const transcriptWantsAlt = this.#altTranscriptWanted();
		const wantAlt = overlayWantsAlt || transcriptWantsAlt;
		if (wantAlt && !this.#altActive) {
			// Enhanced keyboard modes can be buffer-local: re-push the active
			// modified-key reporting sequence on the freshly entered alternate
			// screen, or Esc/modified keys revert to legacy encoding inside
			// fullscreen overlays (Ghostty/kitty/iTerm2).
			const tracking = overlayWantsAlt ? MOUSE_TRACKING_ON : "";
			this.terminal.write(`\x1b[?1049h${this.#keyboardEnhancementEnter()}${tracking}`);
			setAltScreenActive(true);
			this.terminal.hideCursor();
			this.#cursor.forget();
			this.#cursor.recordHidden();
			this.#altActive = true;
			this.#altPreviousLines = [];
			this.#altPreviousCursor = undefined;
			this.#altEnterWidth = width;
			this.#altEnterHeight = height;
			this.#syncAltScroll();
		} else if (wantAlt && this.#altActive && overlayWantsAlt !== this.#altOverlayBorrow) {
			// The reason changed while resident: an overlay opened over the
			// transcript, or closed and handed the buffer back to it. Only the
			// tracking set differs, so flip that alone and stay on the buffer.
			this.terminal.write(overlayWantsAlt ? MOUSE_TRACKING_ON : MOUSE_TRACKING_OFF);
			this.#altPreviousLines = [];
			this.#altPreviousCursor = undefined;
		} else if (!wantAlt && this.#altActive) {
			const enhancementExit = this.#keyboardEnhancementExit();
			this.terminal.write(`${MOUSE_TRACKING_OFF}${enhancementExit}\x1b[?1049l`);
			setAltScreenActive(false);
			this.#cursor.forget();
			this.#altActive = false;
			// Scroll isolation re-arms its wheel/button tracking after the
			// overlay's full tracking set is torn down.
			this.#syncWheelTracking();
			this.#altPreviousLines = [];
			this.#altPreviousCursor = undefined;
			// A resize while on the alt buffer reflowed the terminal's saved
			// normal screen; it no longer matches our accounting, so force the
			// geometry rebuild path instead of a stale diff.
			if (width !== this.#altEnterWidth || height !== this.#altEnterHeight) {
				this.#resizeEventPending = true;
			}
		}
		this.#altOverlayBorrow = overlayWantsAlt;
		if (this.#altActive && overlayWantsAlt) {
			this.#componentRenderTargets.clear();
			this.#renderAltFrame(width, height);
			return;
		}

		// Resize viewport fast path. While a non-multiplexer drag is in flight,
		// paint only the viewport and skip composing the off-screen history.
		// Strictly state-isolated: it never consumes #resizeEventPending nor
		// advances any commit/window/diff field, so the authoritative full paint
		// the settle timer queues reconciles as if these throwaway frames never
		// ran. Two render sources reach here mid-drag and BOTH must stay on this
		// path:
		//   - the resize callback's own cheap paint after each SIGWINCH;
		//   - an ordinary (non-forced) render from a live block that keeps
		//     animating through the drag — a spinner tick, a streamed token, a
		//     cursor blink — firing requestRender(false)/requestComponentRender.
		//     #resizeEventPending is still set (the fast path never consumed it),
		//     so without this branch the ordinary render falls through to the
		//     geometry-rebuild full paint below, which LEAVES the borrowed
		//     alternate screen to repaint the whole transcript on the normal
		//     screen — then the next SIGWINCH re-enters the alt screen and paints
		//     only the tail, so the block flashes in for one frame and vanishes.
		// A FORCED render mid-drag (tool finalization, resetDisplay, image
		// reconciliation) also stays on the fast path: preempting would leave
		// the borrowed alternate screen and run the geometry-rebuild full paint
		// on the normal screen — ED3 plus an O(history) replay that visibly
		// scrolls the whole transcript through the viewport, once per forced
		// render and once more at settle. The forced intent is not lost: the
		// fast path consumes neither #forceViewportRepaintOnNextRender nor
		// #clearScrollbackOnNextRender, and the settle's authoritative
		// requestRender(true) honors both — same fold-into-the-settle contract
		// as the multiplexer resize debounce. A visible overlay composites over
		// the transcript and needs the whole window, so it falls through
		// (overlay resizes are not on the drag-cost hot path).
		if (this.#resizeViewportActive && this.#hasEverRendered && this.#overlays.topmostVisible() === undefined) {
			this.#componentRenderTargets.clear();
			this.#renderResizeViewport(width, height);
			return;
		}

		// A destructive replay erases native history and must receive the complete
		// component frame. Give virtualized roots one compose to rehydrate rows
		// they dropped after commit. Height-only and net-unchanged resize events
		// count too: both enter the geometry rebuild path below.
		const replayFullHistory =
			this.#hasEverRendered &&
			!resizeRepaintsInPlace() &&
			(this.#clearScrollbackOnNextRender ||
				this.#resizeEventPending ||
				(this.#previousWidth > 0 && this.#previousWidth !== width) ||
				(this.#previousHeight > 0 && this.#previousHeight !== height));
		if (replayFullHistory) {
			for (const child of this.children) prepareNativeScrollbackReplay(child);
		}

		// 1. Compose the frame. Bracket the render so the image budget observes
		// every inline image in display order (overlays carry none). A
		// component-scoped frame skips the budget pass instead — it is gated on
		// a quiescent budget, and a partial tree walk would under-count display
		// order — and re-renders only the requested root subtrees, reusing the
		// previous segment of every other root child.
		const partialRoots = componentScopedOnly ? this.#resolvePartialComposeRoots(width, height) : null;
		this.#componentRenderTargets.clear();
		let rawFrame: readonly string[];
		if (partialRoots !== null) {
			this.#partialComposeRoots = partialRoots;
			try {
				rawFrame = this.render(width);
			} finally {
				this.#partialComposeRoots = null;
			}
		} else {
			this.#imageBudget.beginPass();
			rawFrame = this.render(width);
			this.#imageBudget.endPass();
		}
		// Slide the commit coordinates onto the frame a virtualized child just
		// compacted. The rows it dropped are rows the engine reported committed
		// and the terminal already holds, so history is unchanged: only the
		// indices move. This runs BEFORE the Ghostty deferral because the drop
		// already happened inside the render above — an abandoned frame does not
		// give those rows back, and leaving the indices behind is what makes the
		// next classification read the shift as a prefix violation.
		if (this.#frameDroppedRows > 0) {
			// The rows left at the drop site's own offset. A virtualized root is
			// not necessarily the first child: `home-anchor-layout` mounts a
			// `topFill` above the transcript whenever a conversation exists, so
			// the dropped rows begin at that child's start row and splicing from
			// index 0 would delete the filler's committed rows instead and leave
			// the prefix misaligned by exactly the header height — which the next
			// audit reads as a divergence and repairs with a whole-screen rebuild.
			const at = Math.min(this.#frameDroppedAt ?? 0, this.#committedRows);
			const dropped = Math.min(this.#frameDroppedRows, Math.max(0, this.#committedRows - at));
			this.#frameDroppedRows = 0;
			this.#frameDroppedAt = undefined;
			if (dropped > 0) {
				this.#committedRows -= dropped;
				this.#committedPrefixAuditRows =
					this.#committedPrefixAuditRows > at
						? Math.max(at, this.#committedPrefixAuditRows - dropped)
						: this.#committedPrefixAuditRows;
				this.#committedPrefix.splice(at, dropped);
				this.#windowTopRow = Math.max(0, this.#windowTopRow - dropped);
				this.#previousFrameLength = Math.max(0, this.#previousFrameLength - dropped);
				// The tracked cursor is a frame-space absolute row too, and every
				// incremental paint is cursor-relative (`#emitUpdate` derives
				// `currentScreenRow` from it and moves the cursor up by that many
				// rows). Left unslid it is `dropped` rows too large for the rest
				// of the session, so the paint lands above where it belongs: the
				// new rows overwrite live output and the previous paint's tail
				// stays visible underneath.
				this.#cursor.row = this.#cursor.row > at ? Math.max(at, this.#cursor.row - dropped) : this.#cursor.row;
			}
		}
		// Ghostty initial-image deferral must run before any render state is
		// consumed (#resizeEventPending, hardware-cursor state, commit
		// re-anchoring): the early return abandons this frame and the deferred
		// render recomposes from scratch, so consuming state here would
		// misclassify a pending resize as an ordinary diff and corrupt the paint.
		if (this.#maybeDeferGhosttyInitialImagePaint()) return;
		// Cursor markers were stripped at compose time (they are internal
		// sentinels and must never reach the terminal, the committed prefix, or
		// the audit); the visible marker is chosen after the window top is
		// known. Ascending by frame row.
		const cursorMarkers = this.#frameCursorMarkers;
		const liveRegionStart = this.#nativeScrollbackLiveRegionStart;

		// Exactness boundary (used by the audit-zone math below). Rows below it
		// are declared FINAL by the component seam: when they commit, they enter
		// the audited zone (byte-exact, repairable on violation). Rows above it
		// that scroll off the window commit as frozen visual snapshots (see
		// #committedPrefixAuditRows). The whole frame is final when the root
		// reports no seam (shell semantics).
		const frameLength = rawFrame.length;
		// Wheel tracking follows scrollability, and "scrollable" means anything
		// sits above the window — the frame overflows the viewport, or rows have
		// already scrolled off onto the tape. A frame test alone released the
		// mouse on every quiet frame of a virtualized transcript, which is what
		// let the terminal scroll the composer off screen. Synced after the emit
		// below.
		this.#frameScrollable = frameLength > height || this.#scrollTape.length > 0;
		const finalBoundary = clampLow(liveRegionStart ?? frameLength, 0, frameLength);

		// 2. Transition state captured before any emitter runs.
		const prevWindowTop = this.#windowTopRow;
		const prevHardwareCursorRow = this.#cursor.row;
		const resizeEventOccurred = this.#resizeEventPending;
		this.#resizeEventPending = false;
		if (resizeEventOccurred) this.#cursor.forget();
		const widthChanged = this.#previousWidth > 0 && this.#previousWidth !== width;
		// A resize event with net-unchanged dimensions still reflowed the
		// terminal buffer; classify it as a height change so geometry handling
		// repaints instead of diffing against a screen that no longer exists.
		const heightChanged =
			(this.#previousHeight > 0 && this.#previousHeight !== height) ||
			(resizeEventOccurred && this.#previousHeight > 0);
		const geometryChanged = widthChanged || heightChanged;

		// Committed-prefix audit. Rows below the audit mark are hard-verified
		// exact bytes; rows between the mark and the current exactness boundary
		// are frozen snapshots whose source JUST became final and must be
		// verified once (a pending header settling, a barrier clearing above a
		// shifted tail); rows past the boundary are still-live frozen snapshots,
		// exempt so a collapsing preview can never spray re-anchors mid-run. A
		// divergence re-anchors — feeding the divergenceRebuild erase-and-replay
		// below (mux fallback: recommit below the stale copy; duplication, never
		// loss) — instead of silently skipping rows (committed nowhere, painted
		// nowhere). Skipped on geometry frames (a rewrap legitimately reflows
		// every row), and skipped when the composed frame's stable prefix
		// covers every verified row and no rows newly became final.
		let committedRowsResynced = false;
		const newlyFinalEnd = Math.min(this.#committedRows, finalBoundary);
		// The exactness boundary can RETREAT (a markdown rewind, a mermaid fence
		// appearing, a fast-path reset re-opening a block): rows verified under
		// the old boundary have a live source again. Demote them to frozen
		// snapshots instead of auditing content that is expected to change —
		// their committed bytes stay as the visual record, and the next boundary
		// rise strict-verifies them once like any other frozen row.
		if (this.#committedPrefixAuditRows > newlyFinalEnd) {
			this.#committedPrefixAuditRows = newlyFinalEnd;
		}
		const auditRan =
			this.#hasEverRendered &&
			!geometryChanged &&
			!this.#clearScrollbackOnNextRender &&
			(this.#renderStablePrefixRows < this.#committedPrefixAuditRows ||
				newlyFinalEnd > this.#committedPrefixAuditRows);
		if (auditRan) {
			const committedRowsBeforeAudit = this.#committedRows;
			this.#auditCommittedPrefix(rawFrame, newlyFinalEnd);
			committedRowsResynced = this.#committedRows !== committedRowsBeforeAudit;
		}
		// True when this frame is a strict, byte-identical PREFIX of the committed
		// record — the viewport squeezed the transcript, history did not change.
		let frameSqueezed = false;
		// A frame that shrank below the committed row count collapsed content
		// that was already recorded (a live suffix collapsing on abort/result).
		// Re-base the commit index at the first divergence against the recorded
		// prefix — frozen snapshots included; a collapse is precisely when the
		// record and the frame part ways — so the surviving exact prefix stays
		// recognized and is never re-shown or re-committed. Only genuinely new
		// content repaints below it.
		if (!geometryChanged && !this.#clearScrollbackOnNextRender && frameLength < this.#committedRows) {
			const limit = Math.min(this.#committedRows, frameLength);
			let diverged = limit;
			for (let i = 0; i < limit; i++) {
				if (!rowsEquivalent(rawFrame[i]!, this.#committedPrefix[i]!)) {
					diverged = i;
					break;
				}
			}
			// A frame the viewport SQUEEZED is not a frame that diverged. When the
			// pinned chrome (HUD rows plus footer) grows past the viewport the
			// transcript is left no room, the frame collapses to a strict PREFIX of
			// what was committed, and every row it still shows matches the record
			// byte for byte. Nothing in history changed and nothing is duplicated,
			// so the erase-and-replay this used to request repaints the whole
			// screen on every frame of a live turn — a strobe, and it is the reason
			// a tall todo list or a busy subagent HUD makes the screen flash.
			// Rebase the index either way (rows the frame no longer draws are not
			// committed), but report a resync ONLY when the surviving rows really
			// disagree with the record, which is the duplicate-block case this
			// repair exists for.
			const contentDiverged = diverged < limit;
			frameSqueezed = !contentDiverged;
			if (diverged < this.#committedRows) {
				this.#committedRows = diverged;
				this.#committedPrefixAuditRows = Math.min(this.#committedPrefixAuditRows, diverged);
				this.#committedPrefix.length = diverged;
				if (contentDiverged) committedRowsResynced = true;
			}
		}
		// Committed-prefix state this frame's commit math extends from
		// (post-audit): drives the audit-mark advance after the emit.
		const preCommitRows = this.#committedRows;
		const preAuditRows = this.#committedPrefixAuditRows;
		let committedPrefixResliced = false;

		// 3. Window and commit math (lengths only; content prepared below).
		let hasVisibleOverlay = false;
		for (const entry of this.#overlays.entries) {
			if (this.#overlays.isVisible(entry)) {
				hasVisibleOverlay = true;
				break;
			}
		}

		// 4. Classify. A resize is an explicit user gesture: normally the engine
		// erases and replays so history rewraps at the new geometry (the reader
		// snapped to the bottom just dragged the window). Multiplexer panes — and
		// terminals that re-report size on alt-screen toggles — instead repaint in
		// place, because an ED3 rewrap is unsafe (pane scrollback / alt-screen
		// feedback loop), so committed history keeps its old wrap.
		const firstPaint = !this.#hasEverRendered;
		const replaceRequested = this.#clearScrollbackOnNextRender;
		const geometryRebuild = geometryChanged && !resizeRepaintsInPlace();
		// Committed history no longer matches the frame: a finalized block
		// replaced its scrolled-off live render, or the frame collapsed into
		// recorded rows. Native scrollback is a render cache, not a court
		// record — erase and replay so history holds the content exactly once,
		// instead of recommitting the final form below the stale fragment
		// (a visibly duplicated block). Multiplexer panes cannot ED3 safely
		// and keep the repair-below fallback in the branches under this one.
		const divergenceRebuild =
			this.#scrollbackRebuildEnabled &&
			!firstPaint &&
			!replaceRequested &&
			!geometryChanged &&
			!isMultiplexerSession() &&
			!frameSqueezed &&
			(committedRowsResynced || frameLength <= this.#committedRows);
		const fullPaint = firstPaint || replaceRequested || geometryRebuild || divergenceRebuild;
		// A destructive rebuild erases native scrollback and replays THIS frame.
		// When a virtualized root has dropped its committed rows, this frame is
		// only the tail, so the replay would put a few rows on a screen the ED3
		// just emptied and the transcript would be gone. The rebuild is decided
		// here, after compose, which is too late to ask for the rows — so ask
		// now and compose again: `#clearScrollbackOnNextRender` makes the next
		// pass a replace, which rehydrates every child (see `replayFullHistory`)
		// and still erases-and-replays, this time with the whole transcript in
		// hand. One shot only; the flag stops a rebuild inside the rebuild.
		if (
			divergenceRebuild &&
			!this.#rehydratingDivergence &&
			this.children.some(child => canPrepareNativeScrollbackReplay(child))
		) {
			this.#rehydratingDivergence = true;
			this.#clearScrollbackOnNextRender = true;
			try {
				this.#doRender();
			} finally {
				this.#rehydratingDivergence = false;
			}
			return;
		}
		// Ceiling on what may enter native scrollback: chrome mounted after the
		// transcript (a HUD, the composer, the status line) rewrites itself every
		// frame, and a chrome row that reached the committed prefix diverges on
		// the very next frame — which is repaired by erasing scrollback and
		// replaying, on every frame of the turn. That is the strobe.
		const historyEnd = this.#historyEndRow(frameLength);
		let windowTop: number;
		let chunkTo: number;
		if (fullPaint) {
			committedPrefixResliced = true;
			windowTop = Math.max(0, frameLength - height);
			chunkTo = Math.min(windowTop, historyEnd);
		} else if (
			frameLength <= this.#committedRows ||
			(frameLength - this.#committedRows < height && cursorMarkers.some(marker => marker.row >= this.#committedRows))
		) {
			// Tail re-anchor (a direct terminal may instead take the
			// divergenceRebuild full paint above when the prefix resynced):
			// either the frame shrank into the committed prefix, or the live tail
			// below the committed boundary no longer fills the viewport while the
			// focused cursor sits in it. Both happen when a tall transient block
			// collapses — a streaming reply aborting after part of its
			// declared-final prefix reached scrollback (the audit resyncs), or a
			// tall transient prompt (the ask dialog's inline editor) shrinking
			// back to the one-line editor (no resync: the committed transcript
			// rows never changed). Flooring windowTop at #committedRows would pin
			// the editor mid-screen with blank rows underneath. The prompt NEVER
			// floats, so the frame tail
			// is re-shown even when the transcript still overflows the viewport.
			// The stale committed copy stays in native history; duplicating a few
			// rows is preferable to a live editor gap — "duplication, never loss"
			// is the ED3-unsafe fallback contract.
			committedPrefixResliced = true;
			windowTop = Math.max(0, frameLength - height);
			chunkTo = Math.min(windowTop, historyEnd);
			this.#committedRows = chunkTo;
			this.#committedPrefix = rawFrame.slice(0, chunkTo);
		} else {
			// Re-anchor to the frame tail, floored at the committed boundary: a
			// shrink (or overlay close) pulls the window back down, but never
			// onto rows already in native history — re-showing those on the
			// grid would duplicate them for a scrolling reader. On a
			// multiplexer resize the pane reflowed its own history; committed
			// rows keep their old wrap there, same as any shell output.
			windowTop = Math.max(this.#committedRows, frameLength - height, 0);
			// Whatever scrolls above the window commits — the tape is the visual
			// record; nothing that was painted may vanish. Overlays freeze
			// commits: composited rows must never enter history, and the hidden
			// gap backfills via the chunk once the overlay closes. A multiplexer
			// resize also commits nothing — the pane keeps its own (old-wrap)
			// history — and re-bases the audit prefix at the new width so the
			// accepted wrap drift does not read as a violation on the next
			// ordinary frame.
			// Rows at or after `finalBoundary` are still LIVE — a HUD mounted
			// between the transcript and the footer, a streaming block's tail.
			// Committing one writes a row that is about to change into immutable
			// history; the next frame's audit reads that as a prefix violation and
			// repairs it by erasing native scrollback and replaying the whole
			// transcript, on every frame of the turn. That is the screen strobing,
			// and a tall todo list or a busy subagent HUD is all it takes: once the
			// pinned chrome outgrows the viewport, `frameLength - height` lands
			// inside the live band. Freeze commits for such a frame — the window
			// still paints in place, and the only rows that miss native scrollback
			// are chrome rows, which were never history to begin with.
			const commitWouldTakeLiveRows = windowTop > historyEnd;
			chunkTo = hasVisibleOverlay || geometryChanged || commitWouldTakeLiveRows ? this.#committedRows : windowTop;
			if (geometryChanged) {
				committedPrefixResliced = true;
				this.#committedPrefix = rawFrame.slice(0, this.#committedRows);
			}
		}

		// Scroll isolation composite: the transcript region shows a frozen
		// slice anchored at #virtualScrollTop while the pinned footer stays
		// live at the viewport bottom. Commits freeze (a chunk's scroll would
		// destroy the frozen view); the backfill runs through the ordinary
		// seam rewrite on resume. windowTop and the commit accounting keep
		// tracking the live tail, so resume needs no reconciliation.
		let virtualScrollSlice = false;
		if (this.#virtualScrollTop !== null) {
			const liveTop = this.#scrollSpaceLiveTop(frameLength);
			if (fullPaint || geometryChanged || hasVisibleOverlay || this.#virtualScrollTop >= liveTop) {
				// Resume: gestures and full paints invalidate the slice, overlays
				// take over the window, and walking down to the tail is following.
				this.#resumeLiveTail();
			} else {
				virtualScrollSlice = true;
				chunkTo = this.#committedRows;
			}
		}

		// 5. Pick the visible cursor marker (bottom-most at or below the window
		// top), prepare lines, and build the visible window slice.
		let cursorPos: { row: number; col: number } | null = null;
		for (let i = cursorMarkers.length - 1; i >= 0; i--) {
			const marker = cursorMarkers[i]!;
			if (marker.row >= windowTop) {
				cursorPos = marker;
				break;
			}
		}
		const frame = this.#prepared.prepare(rawFrame, width);
		let window: string[] = new Array(height);
		// Screen position of the caret for a resident alt-buffer paint, computed
		// while the window is assembled because only here is it known which frame
		// row landed on which screen row. Null means "no visible caret": in a frozen
		// view the composer's row is still painted (it is the pinned footer), but a
		// caret whose frame row sits in the frozen history above has no screen row
		// at all and must not be drawn at a stale one.
		let altCaret: { row: number; col: number } | null = null;
		if (virtualScrollSlice) {
			// Frozen transcript rows above, live footer rows below. The region
			// reads the scroll-space snapshot (tape + this frame's uncommitted
			// rows), built once when the view froze so nothing that happens
			// under it can shift a row the reader is looking at. The footer is
			// always the live frame's last rows, so the composer keeps typing,
			// spinning, and updating while the history above it holds still.
			const uncommittedEnd = Math.max(this.#committedRows, frameLength - this.#pinnedFooterRows);
			this.#scrollSnapshot ??= [...this.#scrollTape.rows, ...frame.slice(this.#committedRows, uncommittedEnd)];
			const snapshot = this.#scrollSnapshot;
			const footerRows = Math.min(this.#pinnedFooterRows, height - 1);
			const regionRows = height - footerRows;
			const viewTop = this.#virtualScrollTop!;
			for (let r = 0; r < height; r++) {
				window[r] =
					r < regionRows
						? (snapshot[viewTop + r] ?? "")
						: (frame[frameLength - footerRows + (r - regionRows)] ?? "");
			}
			drawScrollTrack(window, regionRows, viewTop, snapshot.length, width);
			const footerTop = frameLength - footerRows;
			if (cursorPos !== null && cursorPos.row >= footerTop) {
				altCaret = { row: regionRows + (cursorPos.row - footerTop), col: cursorPos.col };
			}
		} else {
			for (let r = 0; r < height; r++) window[r] = frame[windowTop + r] ?? "";
			if (cursorPos !== null && cursorPos.row >= windowTop && cursorPos.row < windowTop + height) {
				altCaret = { row: cursorPos.row - windowTop, col: cursorPos.col };
			}
		}
		if (hasVisibleOverlay) {
			window = this.#overlays.compositeIntoWindow(window, width, height);
			const overlayMarkers = extractCursorMarkers(window);
			if (overlayMarkers.length > 0) {
				cursorPos = { row: windowTop + overlayMarkers[0]!.row, col: overlayMarkers[0]!.col };
			}
			window = prepareLinesArray(window, width);
		}
		const cursorTrackingLineCount = hasVisibleOverlay ? Math.max(frame.length, windowTop + height) : frame.length;

		const intent: RenderIntent = fullPaint
			? {
					kind: "fullPaint",
					clearScrollback: divergenceRebuild || ((replaceRequested || geometryRebuild) && !isMultiplexerSession()),
				}
			: { kind: "update", chunkTo, windowTop };
		this.#logRedraw(intent, frameLength, height);

		// Load newly-displayed image data once, before this frame's placements
		// reference it. For full paints, the emitter may need to place the
		// transmit after a destructive clear (ED2/ED3) but before row replay, so
		// build the buffer here and let the emitter decide where it lands.
		let imageTransmitBuffer = "";
		for (const seq of this.#imageBudget.takeTransmits()) imageTransmitBuffer += seq;
		// Purge graphics for images the budget demoted to text. Kitty keeps
		// images in a store that text clears don't touch; demoted rows still
		// visible re-render as text and the window diff repaints them.
		// Committed placements are immutable — their pixels are deleted but
		// their rows are not rewritten.
		let purgeSequence = "";
		if (TERMINAL.imageProtocol === ImageProtocol.Kitty) {
			for (const id of this.#imageBudget.takePurgeIds()) purgeSequence += encodeKittyDeleteImage(id);
		} else {
			this.#imageBudget.takePurgeIds();
		}

		// 6a. Resident alt-buffer paint. The transcript lives on the alternate
		// screen for the "alt-arrows" transport, where there is no native scrollback
		// to append to and nothing the terminal owns, so the whole
		// commit/audit/scroll-append planner below does not apply: every frame is a
		// full viewport rewrite of the window already assembled above.
		//
		// The commit ledger is still advanced, because on this surface it means
		// something different and still necessary: rows at or above the window top
		// are moved onto the scroll tape and reported to the root as committed, which
		// is what lets a virtualized transcript DROP them and keeps the composed
		// frame near the viewport height however long the session runs. Here the tape
		// is not a mirror of terminal scrollback, it is the only copy — which is why
		// the audit is skipped entirely: nothing outside this process can hold us to
		// bytes we already painted, so there is no immutability to verify.
		if (this.#altActive) {
			this.#appendScrollTape(frame, Math.min(preCommitRows, chunkTo), chunkTo);
			this.#committedRows = chunkTo;
			this.#committedPrefix.length = 0;
			this.#committedPrefixAuditRows = 0;
			this.#windowTopRow = windowTop;
			this.#emitAltFrame(window, width, height, altCaret ?? undefined);
			this.#previousWindow = window;
			this.#previousFrameLength = frameLength;
			// The rows the tape does not hold yet. Kept so exit can replay the whole
			// transcript (tape + tail) onto the normal screen, since on this surface
			// the terminal has never seen any of it.
			this.#altTailRows = frame.slice(chunkTo);
			this.#altTranscriptReplayPending = true;
			this.#clearScrollbackOnNextRender = false;
			this.#hasEverRendered = true;
			this.#publishCommittedRows();
			return;
		}
		// 6. Emit.
		if (intent.kind === "fullPaint") {
			this.#emitFullPaint(frame, window, width, height, cursorPos, purgeSequence, imageTransmitBuffer, {
				clearScrollback: intent.clearScrollback,
				chunkTo,
				windowTop,
				cursorTrackingLineCount,
			});
			this.#committedPrefix = rawFrame.slice(0, chunkTo);
			// A full paint that erased scrollback rewrote history, so the tape is
			// rewritten with it; one that did not (a multiplexer pane, which
			// cannot ED3 safely) appended below what is already there, and so
			// does the tape.
			if (intent.clearScrollback) this.#scrollTape.clear();
			this.#appendScrollTape(frame, 0, chunkTo);
			this.#committedPrefixAuditRows = Math.min(chunkTo, finalBoundary);
			this.#clearScrollbackOnNextRender = false;
			this.#hasEverRendered = true;
			this.#syncWheelTracking();
			this.#publishCommittedRows();
			if (!firstPaint && frameLength > height) this.#armPostFullPaintSettle();
			return;
		}
		if (imageTransmitBuffer.length > 0) {
			this.terminal.write(imageTransmitBuffer);
		}
		this.#emitUpdate(frame, window, width, height, cursorPos, purgeSequence, {
			chunkTo,
			windowTop,
			prevWindowTop,
			prevHardwareCursorRow,
			forceWindowRewrite: this.#forceViewportRepaintOnNextRender || (geometryChanged && resizeRepaintsInPlace()),
			repaintVirtualScrollInPlace: hasVisibleOverlay || virtualScrollSlice,
			cursorTrackingLineCount,
		});
		this.#syncWheelTracking();
		// Rows [preCommitRows, chunkTo) scrolled off on this frame: they go on
		// the tape as the prepared bytes that were painted. Rows the tail
		// re-anchor re-showed (chunkTo below preCommitRows) are already on it.
		this.#appendScrollTape(frame, Math.min(preCommitRows, chunkTo), chunkTo);
		for (let i = this.#committedPrefix.length; i < chunkTo; i++) {
			this.#committedPrefix.push(rawFrame[i] ?? "");
		}
		// Audit-mark advance. A re-slice re-bases it outright. Otherwise it may
		// advance to the exactness boundary only when this frame verified the
		// newly-final span (auditRan hard-scans it) or no such span existed —
		// rows committed this frame below the boundary are fresh exact bytes.
		if (committedPrefixResliced || auditRan || preAuditRows >= Math.min(preCommitRows, finalBoundary)) {
			this.#committedPrefixAuditRows = Math.min(this.#committedRows, finalBoundary);
		} else {
			this.#committedPrefixAuditRows = Math.min(preAuditRows, this.#committedRows);
		}
		this.#publishCommittedRows();
	}

	/**
	 * Detect committed-prefix violations (see {@link findCommittedPrefixResync}
	 * for the zone semantics) and re-anchor the commit index at the first moved
	 * row, so subsequent rows recommit instead of being skipped: the stale copy
	 * stays in history — duplication, never loss. Pure in-place restyles keep
	 * their alignment and are left alone (stale styling in history was always
	 * the accepted artifact).
	 */
	#auditCommittedPrefix(rawFrame: readonly string[], newlyFinalEnd: number): void {
		const prefix = this.#committedPrefix;
		if (prefix.length === 0) return;
		const resyncTo = findCommittedPrefixResync(rawFrame, prefix, this.#committedPrefixAuditRows, newlyFinalEnd);
		if (resyncTo < 0) return;
		this.#committedRows = resyncTo;
		this.#committedPrefixAuditRows = Math.min(this.#committedPrefixAuditRows, resyncTo);
		prefix.length = resyncTo;
		if ($flag("VEYYON_DEBUG_REDRAW")) {
			const msg = `[${new Date().toISOString()}] commit resync: committed prefix diverged at row ${resyncTo}; recommitting\n`;
			fs.appendFileSync(getDebugLogPath(), msg);
		}
	}

	/**
	 * Frame row where HISTORY ends. Root children that implement the native
	 * scrollback contract are the transcript — the only rows that belong in the
	 * terminal's own scrollback. Anything mounted after the last of them is
	 * chrome: a todo or subagent HUD, the composer, the status line. Chrome
	 * rewrites itself every frame, so a chrome row that reached the committed
	 * prefix is a prefix violation waiting to happen, and the repair for that is
	 * an erase-and-replay of the whole screen.
	 *
	 * Falls back to the whole frame when no child claims history, which is every
	 * plain-container host (a dialog, a one-shot command): there is no chrome to
	 * separate and the old ceiling is the right one. A declared pinned footer is
	 * the exception — it IS chrome, named as such by the host — so its first row
	 * caps the ceiling whether or not anything above it claims the replay
	 * contract. Without that cap a pinned footer over a plain container had no
	 * ceiling at all.
	 */
	#historyEndRow(frameLength: number): number {
		const segments = this.#frameSegments;
		let end = frameLength;
		for (let i = segments.length - 1; i >= 0; i--) {
			const segment = segments[i]!;
			if (canPrepareNativeScrollbackReplay(segment.component)) {
				end = segment.start + segment.rowCount;
				break;
			}
		}
		if (this.#pinnedFooterChildCount > 0 && segments.length >= this.#pinnedFooterChildCount) {
			end = Math.min(end, segments[segments.length - this.#pinnedFooterChildCount]!.start);
		}
		return end;
	}

	/**
	 * Push the post-emit committed-row count to root children that implement
	 * {@link NativeScrollbackCommittedRows}. Compose feeds the same signal
	 * before each child render (see {@link render}), but guards that run
	 * BETWEEN frames — e.g. a controller consulting the transcript's
	 * committed boundary to decide whether a displaceable block may still be
	 * retracted — would otherwise observe a count one frame stale and retract
	 * rows that just entered immutable native scrollback, stranding an
	 * orphaned copy above the repainted block.
	 */
	#publishCommittedRows(): void {
		for (const segment of this.#frameSegments) {
			setNativeScrollbackCommittedRows(
				segment.component,
				Math.min(segment.rowCount, Math.max(0, this.#committedRows - segment.start)),
			);
		}
	}

	/**
	 * Single state-transition point. Every emitter calls this exactly once at
	 * the end so cursor/window accounting stays consistent.
	 */
	#commit(
		lines: readonly string[],
		window: string[],
		width: number,
		height: number,
		hardwareCursor: HardwareCursorUpdate,
	): void {
		this.#previousFrameLength = lines.length;
		this.#previousWindow = window;
		this.#forceViewportRepaintOnNextRender = false;
		this.#previousWidth = width;
		this.#previousHeight = height;
		this.#cursor.recordUpdate(hardwareCursor);
		this.onFrameComposed?.();
	}

	/**
	 * Replay the frame from home, optionally clearing native scrollback first:
	 * committed prefix `[0, chunkTo)` followed by the visible window. ED3
	 * (`CSI 3 J`) is emitted here and only here, and only for gesture-driven
	 * paints (session replace, resize, resetDisplay, or an explicit
	 * `clearScrollback` initial paint).
	 */
	#emitFullPaint(
		frame: readonly string[],
		window: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
		purgeSequence: string,
		imageTransmitBuffer: string,
		options: {
			clearScrollback: boolean;
			chunkTo: number;
			windowTop: number;
			cursorTrackingLineCount: number;
		},
	): void {
		this.#fullRedrawCount += 1;
		const { chunkTo, windowTop, cursorTrackingLineCount } = options;
		// Map the frame-space cursor into paint space: committed-prefix rows
		// keep their index, visible-window rows land after the prefix, and a
		// cursor in neither region (hidden behind the overlay gap) hides.
		let paintCursorPos: { row: number; col: number } | null = null;
		if (cursorPos !== null) {
			if (cursorPos.row < chunkTo) {
				paintCursorPos = cursorPos;
			} else if (cursorPos.row >= windowTop && cursorPos.row < windowTop + height) {
				paintCursorPos = { row: chunkTo + cursorPos.row - windowTop, col: cursorPos.col };
			}
		}
		// ConPTY hosts bound the replay: merge prefix + window into one array
		// so #truncateLargeConptyFrame can measure the payload and retain only
		// the tail. Gated on the host check — everywhere else the merge would
		// copy a pointer per committed row (a 50k-row session = 50k-entry
		// array per resize step / theme change / session replace) just to be
		// returned unchanged. `paintLines` stays null unless truncation
		// actually rewrote the replay.
		let paintLines: string[] | null = null;
		let paintLineCount = chunkTo + height;
		if (isConPTYHosted()) {
			const merged = new Array<string>(chunkTo + height);
			for (let i = 0; i < chunkTo; i++) merged[i] = frame[i] ?? "";
			for (let screenRow = 0; screenRow < height; screenRow++) {
				merged[chunkTo + screenRow] = window[screenRow] ?? "";
			}
			const paint = truncateLargeConptyFrame(merged, width, height, paintCursorPos);
			if (paint.lines !== merged) {
				paintLines = paint.lines;
				paintLineCount = paint.lines.length;
				paintCursorPos = paint.cursorPos;
			}
		}
		let buffer = this.#paintBeginSequence + this.#leaveResizeAltSequence() + purgeSequence;
		if (options.clearScrollback) {
			// Clear native history without blanking the live viewport first. The
			// replay below rewrites every visible row from home, including blanks,
			// so terminals without DEC 2026 never expose an ED2-cleared frame.
			buffer += "\x1b[H\x1b[3J";
		} else {
			// Best-effort: push the pre-paint screen into scrollback on
			// terminals that implement kitty's ED 22
			// (copy-screen-to-scrollback-then-erase). Always follow with ED 2 so
			// the viewport is cleared regardless; on real kitty, ED 2 over the
			// now-blank screen is a no-op and does not push a second copy.
			if (TERMINAL.supportsScreenToScrollback) buffer += "\x1b[22J";
			buffer += "\x1b[2J\x1b[H";
		}
		if (imageTransmitBuffer.length > 0) buffer += imageTransmitBuffer;
		// DECCARA fills optimize only the rows that stay visible; history-bound
		// rows are written as full styled strings (their background must
		// survive in scrollback, which DECCARA cannot reach).
		const visibleStart = Math.max(0, paintLineCount - height);
		let fillSequence = "";
		let visibleTexts: string[] | null = null;
		if (this.#deccaraFillsEnabled() && visibleStart < paintLineCount) {
			// Untruncated, the visible slice is exactly the caller's window
			// (visibleStart === chunkTo) — reuse it rather than copying;
			// planDeccaraFills fills its own `texts` and never mutates input.
			let visible = window;
			if (paintLines !== null) {
				visible = new Array<string>(paintLineCount - visibleStart);
				for (let k = 0; k < visible.length; k++) visible[k] = paintLines[visibleStart + k] ?? "";
			}
			const plan = planDeccaraFills(visible, width);
			visibleTexts = plan.texts;
			fillSequence = plan.sequence;
		}
		if (paintLines === null) {
			// Common path: emit straight from the source arrays (the
			// pre-merge two-loop form); byte-identical to replaying the
			// merged array. Destructive history clears deliberately avoid ED2, so
			// each row must self-clear stale cells left by the previous viewport.
			for (let i = 0; i < chunkTo; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += options.clearScrollback
					? lineRewriteSequence(frame[i] ?? "", width)
					: terminalLine(frame[i] ?? "");
			}
			for (let screenRow = 0; screenRow < height; screenRow++) {
				if (chunkTo + screenRow > 0) buffer += "\r\n";
				const line = visibleTexts ? (visibleTexts[screenRow] ?? "") : (window[screenRow] ?? "");
				buffer += options.clearScrollback ? lineRewriteSequence(line, width) : terminalLine(line);
			}
		} else {
			for (let i = 0; i < paintLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				const line = visibleTexts && i >= visibleStart ? visibleTexts[i - visibleStart] : (paintLines[i] ?? "");
				buffer += options.clearScrollback ? lineRewriteSequence(line, width) : terminalLine(line);
			}
		}
		buffer += fillSequence;
		// Park the hardware cursor at real content bottom, not the padded
		// window bottom — a later height shrink would otherwise scroll live
		// rows into scrollback and duplicate them per resize step.
		const contentRows = clampLow(frame.length - windowTop, 1, height);
		const parkUp = height - contentRows;
		if (parkUp > 0) buffer += `\x1b[${parkUp}A`;
		const contentBottomRow = windowTop + contentRows - 1;
		const paintContentBottomRow = Math.max(0, paintLineCount - 1 - parkUp);
		const cursorControl = this.#cursor.controlSequence(paintCursorPos, paintLineCount, paintContentBottomRow);
		buffer += cursorControl.seq;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);

		const committedCursorState = paintCursorPos ? this.#cursor.targetState(cursorPos, cursorTrackingLineCount) : null;
		const committedCursor = committedCursorState
			? {
					toRow: committedCursorState.row,
					state: committedCursorState,
					visible: committedCursorState.visible,
				}
			: {
					toRow: contentBottomRow,
					state: null,
					visible: cursorControl.visible,
				};

		this.#committedRows = chunkTo;
		this.#windowTopRow = windowTop;
		this.#commit(frame, window, width, height, committedCursor);
	}

	/**
	 * Enter (or extend) the non-multiplexer resize fast path. Marks the drag
	 * active so subsequent `#doRender` calls paint viewport-only, then (re)arms
	 * the quiet-window timer whose callback ends the drag with one authoritative
	 * full paint. Reset on every SIGWINCH, so the full replay fires only once the
	 * user stops dragging.
	 */
	#beginResizeViewport(): void {
		this.#resizeViewportActive = true;
		this.#resizeViewportSettleTimer?.cancel();
		this.#resizeViewportSettleTimer = this.#renderScheduler.scheduleRender(() => {
			this.#resizeViewportSettleTimer = undefined;
			this.#resizeViewportActive = false;
			if (this.#stopped) return;
			// The drag is quiet: replay the rewrapped transcript authoritatively.
			// #resizeEventPending was preserved across every viewport-only frame
			// (the fast path never consumes it), so this classifies as a geometry
			// rebuild — ED3 + full history — and the clearScrollback intent below
			// matches the gesture-driven reset path.
			this.#resizeEventPending = true;
			this.requestRender(true, { clearScrollback: !isMultiplexerSession() });
		}, TUI.#RESIZE_VIEWPORT_SETTLE_MS);
	}

	#requestResizeViewportPaint(): void {
		if (this.#stopped) return;
		this.#renderRequested = false;
		this.#executeRender();
		if (this.#renderRequested) this.#scheduleRender();
	}

	/**
	 * Compose and paint only the viewport for one resize fast-path frame.
	 * State-isolated: advances no commit/window/diff field and calls neither
	 * `#commit` nor `#emitFullPaint`, so the settle full paint reconciles against
	 * the pre-drag screen state.
	 */
	#renderResizeViewport(width: number, height: number): void {
		if (width <= 0 || height <= 0) return;
		// Tail renders call block.render(), which observes inline images on the
		// budget. This is a STABLE (partial) pass: the tail walk is bottom-up and
		// sees only the visible subset, so display-order-by-call-order is wrong
		// here — `beginPass(true)` makes observe() replay the last committed
		// live/text split per image id instead, so images keep their on-screen
		// state through the drag. Reset the pass each frame so a long drag does
		// not accumulate; never endPass() here — that mutates the demotion ledger
		// off a partial walk. The settle paint's own beginPass()/endPass() is the
		// authoritative accounting, and its beginPass() wipes these frames.
		this.#imageBudget.beginPass(true);
		const { window, contentRows } = this.#composeResizeViewport(width, height);
		this.#emitResizeViewport(window, height, contentRows, width);
		this.#resizeViewportPaintCount += 1;
	}

	/**
	 * Build the viewport window for a resize fast-path frame: the bottom
	 * `height` rows of the would-be full frame, collected bottom-up across root
	 * children. {@link ViewportTailProvider}s (the transcript) yield only their
	 * tail; the small live-region children below render in full — so every child
	 * entirely above the fold is skipped. A frame shorter than the viewport is
	 * top-aligned with blank rows below, matching the full-paint window geometry
	 * (windowTop = max(0, frameLength - height)). Cursor markers are stripped
	 * (the drag hides the hardware cursor) and rows are width-fitted via the
	 * stateless preparer, so no persistent prepared-frame cache is touched.
	 */
	#composeResizeViewport(width: number, height: number): { window: readonly string[]; contentRows: number } {
		const tail: string[] = []; // bottom-first
		const children = this.children;
		for (let i = children.length - 1; i >= 0 && tail.length < height; i--) {
			const child = children[i]!;
			const provider = asViewportTailProvider(child);
			const rows = provider ? provider.renderViewportTail(width, height - tail.length) : child.render(width);
			for (let r = rows.length - 1; r >= 0 && tail.length < height; r--) {
				tail.push(rows[r]!);
			}
		}
		const count = tail.length;
		const window: string[] = new Array(height);
		for (let screenRow = 0; screenRow < height; screenRow++) {
			// `tail` holds the bottom `count` frame rows, bottom-first. They fill
			// the viewport when the frame overflows it and sit at the top (blanks
			// below) when it underflows.
			window[screenRow] = screenRow < count ? tail[count - 1 - screenRow]! : "";
		}
		extractCursorMarkers(window);
		return { window: prepareLinesArray(window, width), contentRows: count };
	}

	/**
	 * Resolve the active keyboard-enhancement enter sequence. Falls back to the
	 * legacy `kittyEnableSequence` when a custom Terminal predates the
	 * `keyboardEnhancementEnterSequence` property.
	 */
	#keyboardEnhancementEnter(): string {
		return this.terminal.keyboardEnhancementEnterSequence ?? this.terminal.kittyEnableSequence ?? "";
	}

	/**
	 * Resolve the active keyboard-enhancement exit sequence. Falls back to popping
	 * kitty whenever a custom Terminal exposes its push sequence but predates the
	 * `keyboardEnhancementExitSequence` property.
	 */
	#keyboardEnhancementExit(): string {
		const exit = this.terminal.keyboardEnhancementExitSequence;
		if (exit !== undefined) return exit ?? "";
		return this.terminal.kittyEnableSequence ? "\x1b[<u" : "";
	}

	#enterResizeAltSequence(): string {
		if (this.#resizeAltActive || this.#altActive) return "";
		this.#resizeAltActive = true;
		setAltScreenActive(true);
		this.#cursor.forget();
		this.#cursor.recordHidden();
		return `${ALT_SCREEN_ENTER}${this.#keyboardEnhancementEnter()}`;
	}

	#leaveResizeAltSequence(): string {
		if (!this.#resizeAltActive) return "";
		const enhancementExit = this.#keyboardEnhancementExit();
		this.#resizeAltActive = false;
		setAltScreenActive(false);
		this.#cursor.forget();
		return `${enhancementExit}${ALT_SCREEN_EXIT}`;
	}

	/**
	 * Emit a throwaway viewport repaint for the resize fast path as an alternate-
	 * screen per-row overwrite. The normal buffer may reflow full-width rows on a
	 * width change before the app can repaint; keeping the drag on the alternate
	 * screen makes those transient resizes truncate instead of pushing wrapped
	 * fragments into native scrollback. Normal-screen history is rebuilt once at
	 * settle via `#emitFullPaint`.
	 */
	#emitResizeViewport(window: readonly string[], height: number, contentRows: number, width: number): void {
		let buffer = `${this.#paintBeginSequence + this.#enterResizeAltSequence()}\x1b[H`;
		for (let r = 0; r < height; r++) {
			if (r > 0) buffer += "\r\n";
			buffer += lineRewriteSequence(window[r] ?? "", width);
		}
		// Park the hardware cursor at the real content bottom, not the padded
		// viewport bottom: a later height shrink would otherwise scroll the live
		// rows below the cursor into native scrollback and duplicate them until
		// the settle rebuild erases it.
		const parkUp = height - Math.max(1, contentRows);
		if (parkUp > 0) buffer += `\x1b[${parkUp}A`;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);
	}

	/** Topmost visible overlay requests the alternate-screen buffer. */
	#wantsAltScreen(): boolean {
		const entries = this.#overlays.entries;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i]!;
			if (!this.#overlays.isVisible(entry)) continue;
			return entry.options?.fullscreen === true;
		}
		return false;
	}

	/**
	 * Compose and paint a single fullscreen overlay frame on the alt buffer.
	 * Cursor markers are stripped (the modal draws its own in-band caret and
	 * keeps the hardware cursor hidden), and only the modal is composited over a
	 * blank base — the transcript is never touched while the alt buffer is up.
	 */
	#renderAltFrame(width: number, height: number): void {
		const base: string[] = new Array(Math.max(0, height)).fill("");
		let lines = this.#overlays.compositeIntoWindow(base, width, height);
		extractCursorMarkers(lines);
		lines = prepareLinesArray(lines, width);
		this.#emitAltFrame(lines, width, height);
	}

	/**
	 * Whether the transcript itself should reside on the alt buffer.
	 *
	 * True only for the `"alt-arrows"` transport with isolation on: that transport
	 * gets its gestures from Alternate Scroll Mode, which the terminal honors only
	 * while the alternate screen is displayed. Residency is therefore not a
	 * preference but the precondition for the transport working at all.
	 *
	 * Gated on having rendered once so the first paint still lands on the normal
	 * screen: entering the alt buffer before anything is composed would blank the
	 * operator's terminal for a frame with nothing to show in its place.
	 */
	#altTranscriptWanted(): boolean {
		return this.#scrollTransport === "alt-arrows" && this.#scrollIsolation && !this.#stopped && this.#hasEverRendered;
	}

	/**
	 * Full per-row viewport rewrite on the alt buffer. Emits only sync-output
	 * brackets, a cursor home, and per-row rewrites — never ED3, append-tail, or
	 * any native-scrollback byte, so it is fully isolated from the planner and
	 * #commit.
	 *
	 * `cursor` places the hardware caret after the paint and shows it. A
	 * fullscreen overlay passes nothing and keeps the caret hidden (it draws its
	 * own in-band one), but a resident transcript surface has a live composer on
	 * the alt buffer, and a composer with no visible caret is not a composer.
	 */
	#emitAltFrame(lines: string[], width: number, height: number, cursor?: { row: number; col: number }): void {
		const fitted: string[] = new Array(height);
		for (let r = 0; r < height; r++) fitted[r] = lines[r] ?? "";
		// Flush queued image-data transmits (`a=t`, no visible output) before the
		// paint so id-keyed placements and placeholder cells composed into this
		// frame resolve against loaded data. The normal-screen path flushes these
		// ahead of its paint; without this, an image first shown inside a
		// fullscreen overlay (e.g. the settings shape preview) would render as
		// blank placeholder cells until the overlay closed.
		const imageTransmits = this.#imageBudget.takeTransmits();
		if (imageTransmits.length > 0) {
			let transmitBuffer = "";
			for (const seq of imageTransmits) transmitBuffer += seq;
			this.terminal.write(transmitBuffer);
		}
		// Skip an identical repaint (the modal is mostly static between
		// keystrokes) — unless a forced repaint (resetDisplay,
		// requestRender(true)) is pending: the redraw gesture must repair a
		// corrupted modal even when our cached frame is byte-identical. A caret
		// move alone also has to repaint: the rows can be identical while the
		// composer's cursor moved along one of them, and skipping would leave the
		// caret behind the text the operator is editing.
		const force = this.#forceViewportRepaintOnNextRender;
		this.#forceViewportRepaintOnNextRender = false;
		const caretMoved =
			cursor === undefined
				? this.#altPreviousCursor !== undefined
				: this.#altPreviousCursor === undefined ||
					this.#altPreviousCursor.row !== cursor.row ||
					this.#altPreviousCursor.col !== cursor.col;
		if (!force && !caretMoved && this.#altPreviousLines.length === height) {
			let same = true;
			for (let r = 0; r < height; r++) {
				if (fitted[r] !== this.#altPreviousLines[r]) {
					same = false;
					break;
				}
			}
			if (same) return;
		}
		let buffer = `${this.#paintBeginSequence}\x1b[H`;
		for (let r = 0; r < height; r++) {
			if (r > 0) buffer += "\r\n";
			buffer += lineRewriteSequence(fitted[r], width);
		}
		if (cursor !== undefined) {
			// Rows/cols are 0-based internally and 1-based on the wire.
			const row = clampLow(cursor.row + 1, 1, Math.max(1, height));
			const col = clampLow(cursor.col + 1, 1, Math.max(1, width));
			buffer += `\x1b[${row};${col}H`;
		}
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);
		if (cursor !== undefined) {
			this.terminal.showCursor();
			// Absolute placement, so the row tracker is re-based rather than nudged:
			// this path emits CUP, never a relative move.
			this.#cursor.recordRowOnly(cursor.row, true);
		}
		this.#altPreviousCursor = cursor;
		this.#altPreviousLines = fitted;
		this.#fullRedrawCount += 1;
	}

	/**
	 * Incremental frame update. Three byte shapes:
	 *
	 * - scroll-append: the rows leaving the screen are exactly the newly
	 *   committed chunk, already painted with final content — emit `\r\n` plus
	 *   the new bottom rows, then rewrite whatever else changed in place;
	 * - in-window diff: nothing scrolls, nothing commits — rewrite the changed
	 *   row range (cursor-only when nothing changed);
	 * - seam rewrite: write the chunk at the scrollback seam, then rewrite the
	 *   whole window (live-region re-layout, hidden-gap backfill, mux resize).
	 *
	 * Only chunk rows ever enter native history; the live window repaints in
	 * place with relative moves. This path never emits ED2/ED3 or an absolute
	 * cursor home — those snap a reader scrolled into history back to the
	 * bottom on several terminal families.
	 */
	#emitUpdate(
		frame: readonly string[],
		window: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
		purgeSequence: string,
		options: {
			chunkTo: number;
			windowTop: number;
			prevWindowTop: number;
			prevHardwareCursorRow: number;
			forceWindowRewrite: boolean;
			repaintVirtualScrollInPlace: boolean;
			cursorTrackingLineCount: number;
		},
	): void {
		const {
			chunkTo,
			windowTop,
			prevWindowTop,
			prevHardwareCursorRow,
			forceWindowRewrite,
			repaintVirtualScrollInPlace,
			cursorTrackingLineCount,
		} = options;
		const chunkFrom = this.#committedRows;
		const chunkLength = chunkTo - chunkFrom;
		const scroll = windowTop - prevWindowTop;
		const previousWindow = this.#previousWindow;
		const contentRows = clampLow(frame.length - windowTop, 1, height);
		const contentBottomRow = windowTop + contentRows - 1;
		// Terminals clamp the hardware cursor to the viewport on resize; clamp
		// our tracking to match so relative moves land correctly.
		const clampedCursor = Math.min(prevHardwareCursorRow, prevWindowTop + height - 1);
		const currentScreenRow = clampLow(clampedCursor - prevWindowTop, 0, height - 1);

		// Scroll-append: committing exactly the rows that scroll off the top,
		// with content untouched since they were painted.
		if (
			!forceWindowRewrite &&
			chunkLength > 0 &&
			chunkLength === scroll &&
			scroll < height &&
			chunkFrom === prevWindowTop
		) {
			let prefixIntact = previousWindow.length === height;
			for (let i = 0; prefixIntact && i < chunkLength; i++) {
				if (previousWindow[i] !== frame[chunkFrom + i]) prefixIntact = false;
			}
			if (prefixIntact) {
				let buffer = this.#paintBeginSequence + purgeSequence;
				const moveToBottom = height - 1 - currentScreenRow;
				if (moveToBottom > 0) buffer += `\x1b[${moveToBottom}B`;
				for (let r = height - scroll; r < height; r++) {
					buffer += `\r\n${lineRewriteSequence(window[r] ?? "", width)}`;
				}
				// Rewrite any remaining changed rows after the shift.
				let firstChanged = -1;
				let lastChanged = -1;
				for (let r = 0; r < height - scroll; r++) {
					if ((window[r] ?? "") === (previousWindow[r + scroll] ?? "")) continue;
					if (firstChanged === -1) firstChanged = r;
					lastChanged = r;
				}
				let cursorFromRow = windowTop + height - 1;
				if (firstChanged !== -1) {
					const up = height - 1 - firstChanged;
					if (up > 0) buffer += `\x1b[${up}A`;
					buffer += "\r";
					for (let r = firstChanged; r <= lastChanged; r++) {
						if (r > firstChanged) buffer += "\r\n";
						buffer += lineRewriteSequence(window[r] ?? "", width);
					}
					cursorFromRow = windowTop + lastChanged;
				}
				const cursorControl = this.#cursor.controlSequence(cursorPos, cursorTrackingLineCount, cursorFromRow);
				buffer += cursorControl.seq;
				buffer += this.#paintEndSequence;
				this.terminal.write(buffer);
				this.#committedRows = chunkTo;
				this.#windowTopRow = windowTop;
				this.#commit(frame, window, width, height, cursorControl);
				return;
			}
		}

		// In-window diff: nothing commits. Rewrite in place when the window slid
		// without a commit — an overlay visible (composited rows must never enter
		// history), a commit-frozen geometry frame, or the window pulling back
		// down after a shrink. Overlay cursor-only frames can also leave the
		// tracked row behind the physical cursor; a relative partial rewrite from
		// that stale origin can CRLF on the bottom row and scroll native history
		// without appending to the commit tape, so overlays always take the
		// top-clamped full rewrite.
		const inPlaceRewrite = repaintVirtualScrollInPlace || scroll !== 0;
		if (chunkLength === 0) {
			if (forceWindowRewrite || inPlaceRewrite) this.#fullRedrawCount += 1;
			let firstChanged = forceWindowRewrite || inPlaceRewrite ? 0 : -1;
			let lastChanged = forceWindowRewrite || inPlaceRewrite ? height - 1 : -1;
			if (!forceWindowRewrite && !inPlaceRewrite) {
				const comparable = previousWindow.length === height;
				for (let r = 0; r < height; r++) {
					if (comparable && (window[r] ?? "") === (previousWindow[r] ?? "")) continue;
					if (firstChanged === -1) firstChanged = r;
					lastChanged = r;
				}
			}
			if (firstChanged === -1) {
				if (purgeSequence.length > 0) this.terminal.write(purgeSequence);
				this.#cursor.writePosition(this.terminal, cursorPos, cursorTrackingLineCount);
				this.#previousWidth = width;
				this.#previousHeight = height;
				return;
			}
			let buffer = this.#paintBeginSequence + purgeSequence;
			if (inPlaceRewrite) {
				// The cursor tracker can be stale after overlay-only frames, and
				// meaningless after an uncommitted slide. A large CUU clamps at the
				// viewport top without using absolute cursor home, so the following
				// full-window rewrite cannot overflow the bottom.
				if (height > 1) buffer += `\x1b[${height - 1}A`;
			} else {
				const rowDelta = firstChanged - currentScreenRow;
				if (rowDelta > 0) buffer += `\x1b[${rowDelta}B`;
				else if (rowDelta < 0) buffer += `\x1b[${-rowDelta}A`;
			}
			buffer += "\r";
			// DECCARA-optimize the contiguous rewritten range (visible rows
			// only; rectangles are absolute screen rows).
			let fillTexts: string[] | null = null;
			let fillSequence = "";
			if (this.#deccaraFillsEnabled()) {
				const slice: string[] = new Array(lastChanged - firstChanged + 1);
				for (let r = firstChanged; r <= lastChanged; r++) slice[r - firstChanged] = window[r] ?? "";
				const plan = planDeccaraFills(slice, width, firstChanged);
				fillTexts = plan.texts;
				fillSequence = plan.sequence;
			}
			for (let r = firstChanged; r <= lastChanged; r++) {
				if (r > firstChanged) buffer += "\r\n";
				buffer += lineRewriteSequence(fillTexts ? fillTexts[r - firstChanged] : (window[r] ?? ""), width);
			}
			buffer += fillSequence;
			// Never park below real content (a height shrink would scroll live
			// rows into history and duplicate them per resize step).
			let cursorFromRow = windowTop + lastChanged;
			const contentBottomScreenRow = contentBottomRow - windowTop;
			if (lastChanged > contentBottomScreenRow) {
				buffer += `\x1b[${lastChanged - contentBottomScreenRow}A`;
				cursorFromRow = contentBottomRow;
			}
			const cursorControl = this.#cursor.controlSequence(cursorPos, cursorTrackingLineCount, cursorFromRow);
			buffer += cursorControl.seq;
			buffer += this.#paintEndSequence;
			this.terminal.write(buffer);
			this.#windowTopRow = windowTop;
			this.#commit(frame, window, width, height, cursorControl);
			return;
		}

		// Seam rewrite: write the chunk into history, then the whole window.
		// Cursor moves to the window top with a relative move; the chunk rows
		// pass through the screen and scroll off as the window rows are written
		// below them, so the rows entering scrollback are exactly the chunk.
		this.#fullRedrawCount += 1;
		let buffer = this.#paintBeginSequence + purgeSequence;
		if (currentScreenRow > 0) buffer += `\x1b[${currentScreenRow}A`;
		buffer += "\r";
		let wroteLine = false;
		for (let i = chunkFrom; i < chunkTo; i++) {
			if (wroteLine) buffer += "\r\n";
			buffer += lineRewriteSequence(frame[i] ?? "", width);
			wroteLine = true;
		}
		for (let screenRow = 0; screenRow < height; screenRow++) {
			if (wroteLine) buffer += "\r\n";
			buffer += lineRewriteSequence(window[screenRow] ?? "", width);
			wroteLine = true;
		}
		const parkUp = height - 1 - (contentBottomRow - windowTop);
		if (parkUp > 0) buffer += `\x1b[${parkUp}A`;
		const cursorControl = this.#cursor.controlSequence(cursorPos, cursorTrackingLineCount, contentBottomRow);
		buffer += cursorControl.seq;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);
		this.#committedRows = chunkTo;
		this.#windowTopRow = windowTop;
		this.#commit(frame, window, width, height, cursorControl);
	}

	/** Optional intent log under VEYYON_DEBUG_REDRAW. */
	#logRedraw(intent: RenderIntent, newLength: number, height: number): void {
		if (!$flag("VEYYON_DEBUG_REDRAW")) return;
		const detail =
			intent.kind === "update"
				? `update(chunk=${this.#committedRows}..${intent.chunkTo}, windowTop=${intent.windowTop})`
				: `fullPaint(clearScrollback=${intent.clearScrollback})`;
		const state =
			`committed=${this.#committedRows}, windowTop=${this.#windowTopRow}, ` +
			`lrStart=${this.#nativeScrollbackLiveRegionStart}`;
		const msg = `[${new Date().toISOString()}] render: ${detail} (prev=${this.#previousFrameLength}, new=${newLength}, height=${height}, ${state})\n`;
		fs.appendFileSync(getDebugLogPath(), msg);
	}
}
