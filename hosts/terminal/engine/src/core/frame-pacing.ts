/**
 * When the engine's next frame may paint: the throttle a requested frame waits behind, and the
 * settle windows a terminal host needs before the engine writes to it again. Every time here is on
 * the clock of the engine's `RenderScheduler`.
 */

const MIN_RENDER_INTERVAL_MS = 1000 / 30;

const INPUT_RENDER_GRACE_MS = MIN_RENDER_INTERVAL_MS;

/**
 * Weight of the newest frame in `FramePacer`'s cost estimate. At 0.3 a sustained
 * change in frame cost is ~90% absorbed within seven frames, so the loop
 * reaches its duty-cycle floor inside a quarter second of going slow, while
 * an isolated spike lifts the floor by under a third of itself.
 */
const FRAME_COST_SMOOTHING = 0.3;

/**
 * Cap on the adaptive floor derived from `FramePacer`'s cost estimate. Bounds the
 * UI responsiveness at ~5 fps under sustained heavy renders — anything
 * slower feels dead to the user and no longer justifies further CPU savings.
 */
const MAX_ADAPTIVE_RENDER_MS = 200;

// Pane-reflow settle window for tmux/screen/zellij. The host process gets
// SIGWINCH (and `process.stdout` already reports the new geometry) before
// the multiplexer finishes repainting the pane at the new size, and
// drag-resize/pane-close animations fire several events in flight. A forced
// render on each SIGWINCH races those mid-reflow paints — the multiplexer's
// catch-up paint then partially overwrites the TUI output, which the user
// sees as a viewport flash or blank screen before the next throttled frame
// arrives (issue #2088). Coalescing every SIGWINCH inside this window into
// a single forced render lets the multiplexer settle first.
export const MULTIPLEXER_RESIZE_DEBOUNCE_MS = 50;

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
export const RESIZE_VIEWPORT_SETTLE_MS = 120;

// Ghostty can drop Kitty graphics commands sent during its first post-startup
// settle window, leaving only Unicode placeholder cells. Hold the first image
// paint until that window has passed; later images render normally.
export const GHOSTTY_INITIAL_IMAGE_DELAY_MS = 100;

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
export const CONPTY_POST_FULL_PAINT_SETTLE_MS = 150;

/** The throttle between frames: a 30 fps cadence, a cost-derived floor and an input grace. */
export class FramePacer {
	/** Start of the newest frame. */
	#frameStartedAt = 0;
	/**
	 * Decayed estimate of what a frame costs, in milliseconds. {@link delay}
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
	#inputGraceUntilMs = 0;

	/**
	 * Records the start of a frame. Called before the frame composes, because a render requested
	 * from inside the compose schedules against this start.
	 */
	frameStarted(start: number): void {
		this.#frameStartedAt = start;
	}

	/** Folds the cost of the frame that ran from `start` to `end` into the estimate. */
	frameEnded(start: number, end: number): void {
		this.#frameCostEstimateMs += FRAME_COST_SMOOTHING * (end - start - this.#frameCostEstimateMs);
	}

	/**
	 * Holds the next frame one cadence interval past `now`. Ctrl+C/Esc use app-level double-press
	 * windows, and the hold gives those gestures one frame to drain queued input before an
	 * ordinary repaint.
	 */
	holdForInput(now: number): void {
		this.#inputGraceUntilMs = now + INPUT_RENDER_GRACE_MS;
	}

	/** Milliseconds a frame requested at `now` waits before it paints. */
	delay(now: number): number {
		const elapsed = now - this.#frameStartedAt;
		// Adaptive backpressure — target ~50% render duty cycle: the next frame
		// starts no sooner than `frame_end + estimated_cost`, i.e.
		// `frame_start + 2 × estimated_cost`. So `elapsed` (which counts from
		// the last frame's start) must already exceed twice the estimate before
		// the follow-up render may fire. The estimate is decayed rather
		// than the previous sample, so a sustained slow loop is held to half the
		// CPU (#4145) and an isolated expensive paint is not charged to the
		// cheap frame behind it. Capped so a pathological cost cannot lock the UI.
		const adaptiveFloor = Math.min(MAX_ADAPTIVE_RENDER_MS, this.#frameCostEstimateMs * 2);
		return Math.max(0, MIN_RENDER_INTERVAL_MS - elapsed, adaptiveFloor - elapsed, this.#inputGraceUntilMs - now);
	}
}
