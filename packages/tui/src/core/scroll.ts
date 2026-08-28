/**
 * Scroll-gesture state that has no dependency on the render pipeline: the
 * history tape the frozen transcript view reads from, the wheel accelerator,
 * and the terminal sequences and key table the two transports use.
 *
 * Split out of `tui.ts`. The viewport arithmetic that turns a scroll-space row
 * into a painted window stays with the engine, because it reads the composed
 * frame and the commit ledger.
 */

// Alternate Scroll Mode (xterm `alternateScroll`, DECSET 1007). While the
// alternate screen is displayed the terminal translates wheel ticks into
// cursor-up/down KEYS instead of mouse reports, so an application can scroll
// its own viewport without enabling mouse tracking at all — which is the whole
// point: mouse tracking is what takes native drag-select away (see the
// scroll-transport note on #scrollTransport). xterm ships the resource
// defaulting to false, but the manual states the mode is also settable by
// control sequence, so the resource default does not decide this for us.
//
// The cost is that a wheel tick is byte-identical to a real arrow key press.
// `ScrollTransport` documents how that ambiguity is resolved.
export const ALT_SCROLL_ON = "\x1b[?1007h";
export const ALT_SCROLL_OFF = "\x1b[?1007l";
/**
 * Legacy cursor-key sequences mapped to a scroll direction: -1 scrolls back into
 * history, +1 walks toward the live tail.
 *
 * Both the normal (`CSI A`) and application-cursor (`SS3 A`) forms appear,
 * because the terminal synthesizes whichever the active DECCKM mode calls for and
 * an application that set application-cursor keys would otherwise see the wheel
 * do nothing. Exact-match only: anything carrying parameters or modifiers is a
 * real keypress, never a synthesized wheel tick.
 */
export const LEGACY_CURSOR_SCROLL: Readonly<Record<string, -1 | 1 | undefined>> = {
	"\x1b[A": -1,
	"\x1b[B": 1,
	"\x1bOA": -1,
	"\x1bOB": 1,
};

/**
 * How a scroll gesture reaches the engine while scroll isolation is on.
 *
 * `"mouse"` grabs mouse reporting on the normal screen: the wheel is
 * unambiguous and native drag-select is lost (Shift+drag instead), and the
 * transcript stays in the terminal's own scrollback.
 *
 * `"alt-arrows"` holds the alternate screen with Alternate Scroll Mode, so the
 * terminal converts the wheel into cursor keys and no mouse tracking is needed:
 * native drag-select keeps working, at the cost of the transcript no longer
 * living in terminal scrollback. Because a synthesized wheel arrow is
 * byte-identical to a typed one, the host must tell the engine which arrows are
 * scrolls; see {@link TUI.setScrollTransport}.
 */
export type ScrollTransport = "mouse" | "alt-arrows";

/** Wheel scroll step in rows per tick; three reads as a calm scroll, one is sluggish. */
const WHEEL_SCROLL_ROWS = 3;
// Acceleration (the opencode scrollbox lesson): repeated same-direction ticks
// inside this window step the multiplier up to the cap, so flying through a
// long transcript does not cost one wrist-flick per screen.
const WHEEL_ACCEL_WINDOW_MS = 300;
const WHEEL_ACCEL_MAX_STREAK = 3;

/** Rows a legacy cursor-key scroll tick moves, before any acceleration. */
export const CURSOR_KEY_SCROLL_ROWS = WHEEL_SCROLL_ROWS;

// The scroll tape: every PREPARED row the engine has painted and let scroll
// off the window, oldest first — the engine's own mirror of what the
// terminal's scrollback holds. Scroll isolation reads history from here and
// not from the composed frame, because virtualized roots (the coding agent's
// TranscriptContainer) DROP committed rows from their render output once the
// engine reports them committed. That keeps the frame near the viewport height
// however long the session runs, so a frame-sourced frozen view could only
// ever scroll back by the commit lag — a few rows — and the wheel then did
// nothing at all.
//
// It mirrors the terminal, it is not a court record: a tail re-anchor
// re-shows rows that are already on the tape (the "duplication, never loss"
// contract), and those duplicates are not appended a second time, so the
// tape can hold each row once where the terminal holds it twice.
export class ScrollTape {
	#rows: string[] = [];
	// Rows kept on the tape. A long session's history is bounded so the engine
	// cannot grow without limit; older rows stay reachable through the
	// terminal's own scrollback, which is what the tape mirrors.
	#cap = 20_000;

	get length(): number {
		return this.#rows.length;
	}

	/** The tape's rows, oldest first. Callers must not mutate the returned array. */
	get rows(): readonly string[] {
		return this.#rows;
	}

	/**
	 * Cap the scroll tape (rows). Below the current length the oldest rows are
	 * dropped immediately; they stay reachable through the terminal's own
	 * scrollback. Must be at least one screen or scrolling back has nothing to
	 * show, so the floor is enforced rather than silently accepted.
	 */
	setCap(rows: number, floorRows: number): void {
		this.#cap = Math.max(floorRows, Math.trunc(rows));
		this.#trim();
	}

	/**
	 * Append the rows this frame let scroll off the window to the tape.
	 * `rows` are PREPARED lines (exactly the bytes painted), so a frozen view
	 * re-shows history byte-for-byte instead of re-deriving it from components
	 * that may have dropped it.
	 */
	append(rows: readonly string[], from: number, to: number): void {
		for (let i = from; i < to; i++) this.#rows.push(rows[i] ?? "");
		this.#trim();
	}

	/** Drop every row: a destructive rebuild erased the terminal's scrollback too. */
	clear(): void {
		this.#rows.length = 0;
	}

	#trim(): void {
		const excess = this.#rows.length - this.#cap;
		if (excess > 0) this.#rows.splice(0, excess);
	}
}

/**
 * Wheel acceleration. Same-direction ticks arriving inside the accel window
 * step the multiplier up to the cap; a direction change or a pause resets it.
 */
export class WheelAccelerator {
	#lastDirection: -1 | 1 | null = null;
	#lastAtMs = 0;
	#streak = 0;

	/** Signed rows this tick should scroll, in scroll-space coordinates. */
	step(direction: -1 | 1, nowMs: number): number {
		if (direction === this.#lastDirection && nowMs - this.#lastAtMs < WHEEL_ACCEL_WINDOW_MS) {
			this.#streak = Math.min(this.#streak + 1, WHEEL_ACCEL_MAX_STREAK);
		} else {
			this.#streak = 0;
		}
		this.#lastDirection = direction;
		this.#lastAtMs = nowMs;
		const rows = WHEEL_SCROLL_ROWS * (1 + this.#streak);
		return direction === -1 ? -rows : rows;
	}
}
