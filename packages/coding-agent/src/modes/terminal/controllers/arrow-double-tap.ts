/**
 * The double-tap gesture on an arrow key, once.
 *
 * Two gestures share it: `←←` on an empty composer opens the agent dashboard
 * (the downward axis) or returns a focused agent view to the main session,
 * and `→→` opens the room strip (the sideways axis). One detector per arrow,
 * one rhythm for both: a user who learns the timing going down uses the same
 * timing going sideways, and a second copy of the window is how one gesture
 * grows two feels.
 */

import { AGENT_VIEW_LEFT_TAP_WINDOW_MS } from "../components/dashboard/agent-view-timings";

/**
 * The shortest interval two taps may be apart and still be a gesture.
 *
 * Rejects terminal-synthesized arrow-key bursts: "click to move cursor" and
 * pointer features in iTerm2, WezTerm, kitty and tmux emit several arrow keys
 * in a single stdin read (sub-millisecond apart) on a stray click, which used
 * to pop the card with no key ever pressed. Three or more rapid taps are
 * likewise a burst, not a gesture. A deliberate human double-tap is always
 * tens of milliseconds apart.
 */
export const ARROW_DOUBLE_TAP_MIN_GAP_MS = 40;

export class ArrowDoubleTap {
	#lastTapTime = 0;
	// Tap counter; reset whenever a quiet gap (>= AGENT_VIEW_LEFT_TAP_WINDOW_MS)
	// starts a fresh sequence.
	#count = 0;

	/**
	 * Record one tap. True only on the SECOND tap of a fresh sequence when it
	 * lands a human-plausible interval after the first
	 * (`[ARROW_DOUBLE_TAP_MIN_GAP_MS, AGENT_VIEW_LEFT_TAP_WINDOW_MS)`). Taps
	 * closer than the lower bound, or any third-and-later tap before a quiet
	 * gap, never fire.
	 */
	tap(now: number = Date.now()): boolean {
		const sinceLast = now - this.#lastTapTime;
		this.#lastTapTime = now;
		if (sinceLast >= AGENT_VIEW_LEFT_TAP_WINDOW_MS) {
			// Quiet gap: this tap starts a fresh sequence.
			this.#count = 1;
			return false;
		}
		this.#count += 1;
		if (this.#count === 2 && sinceLast >= ARROW_DOUBLE_TAP_MIN_GAP_MS) {
			// Exactly two taps, the second a human-plausible interval after the first.
			this.#count = 0;
			this.#lastTapTime = 0;
			return true;
		}
		return false;
	}

	/**
	 * Forget the sequence in progress. The other arrow calls this on its own
	 * tap: `← → ←` is not a double-left, whatever the timing.
	 */
	reset(): void {
		this.#count = 0;
		this.#lastTapTime = 0;
	}
}
