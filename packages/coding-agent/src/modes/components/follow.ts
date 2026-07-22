/**
 * The follow — the design system's rule for anything being produced live:
 * you always see the newest of it, revealed SILKY SMOOTH, with the freshest
 * characters glowing hot and cooling as they age.
 *
 * Provider deltas arrive in bursts (whole sentences at a time), so painting
 * each delta as it lands reads as chunky. {@link SmoothReveal} is the pacing
 * governor between "received" and "shown": it tracks the arrival rate with an
 * EMA and reveals characters at that pace, accelerating smoothly when it falls
 * behind and hard-snapping only past a bounded lag, so the reveal never lags
 * the stream by more than a beat and never dumps a burst in one frame.
 *
 * {@link paintHotTail} is the lava-like trail: the trailing characters of the
 * newest revealed row grade from the theme's cooled body color up to gold at
 * the very tip (matchHighlight — the warm arc's "found thing"), so recency is
 * literally visible. Truecolor only; without 24-bit color there is no trail
 * (a loud, documented degrade — never a half-ramp in 16 colors).
 */

import { truncateToWidth, visibleWidth } from "@veyyon/tui";
import type { Theme } from "../theme/theme";

/** Floor/ceiling on the paced reveal rate, characters per second. The floor
 * keeps a trickling stream readable; the ceiling keeps a firehose smooth
 * instead of strobing. */
const MIN_RATE = 12;
// 400 chars/s base ceiling: ~13 chars per 30fps frame, ~40 at full catch-up —
// fast enough to track any real reasoning stream, slow enough to read as a
// continuous pour rather than page flips.
const MAX_RATE = 400;
/** EMA weight for new arrival-rate samples. */
const RATE_ALPHA = 0.3;
/** Lag (chars) at which catch-up acceleration doubles the pace. */
const CATCHUP_SOFT_CHARS = 80;
/** Ceiling on catch-up acceleration: the pace never exceeds this multiple of
 * the arrival rate, so even a huge burst reveals over multiple frames instead
 * of dumping — the exact "chunked" defect this module exists to fix. */
const CATCHUP_MAX_FACTOR = 3;
/** Advance steps larger than this are clamped: a delayed frame (GC pause, a
 * stalled tick) must not convert the accumulated time into one visual dump. */
const MAX_STEP_MS = 100;
/** Hard bound: never lag the stream by more than this many characters —
 * beyond it the reveal snaps forward so "smooth" can't become "stale". */
const HARD_SNAP_CHARS = 600;

export class SmoothReveal {
	#target = 0;
	#revealed = 0;
	#rate = 60;
	#lastPushAt: number | undefined;
	#lastAdvanceAt: number | undefined;

	/** Report the full received length (monotonic). Updates the arrival-rate
	 * EMA from the delta's size and spacing. */
	push(targetLength: number, now: number): void {
		if (targetLength < this.#target) {
			// A shrink means a new block took over the reveal — restart.
			this.#revealed = targetLength;
			this.#lastAdvanceAt = now;
		}
		if (this.#lastPushAt !== undefined && targetLength > this.#target) {
			const dt = Math.max(1, now - this.#lastPushAt);
			const sample = ((targetLength - this.#target) / dt) * 1000;
			this.#rate = Math.min(MAX_RATE, Math.max(MIN_RATE, this.#rate + RATE_ALPHA * (sample - this.#rate)));
		}
		this.#target = targetLength;
		this.#lastPushAt = now;
	}

	/** Advance the reveal to `now` and return how many characters to show. */
	advance(now: number): number {
		if (this.#lastAdvanceAt === undefined) this.#lastAdvanceAt = now;
		const dt = Math.min(MAX_STEP_MS, Math.max(0, now - this.#lastAdvanceAt));
		this.#lastAdvanceAt = now;
		const lag = this.#target - this.#revealed;
		if (lag <= 0) return this.#revealed;
		if (lag > HARD_SNAP_CHARS) {
			this.#revealed = this.#target - HARD_SNAP_CHARS;
		}
		// Smooth catch-up: pace scales with how far behind we are — but bounded,
		// so the reveal converges on the stream without ever visibly jumping.
		const factor = Math.min(CATCHUP_MAX_FACTOR, 1 + (this.#target - this.#revealed) / CATCHUP_SOFT_CHARS);
		this.#revealed = Math.min(this.#target, this.#revealed + (this.#rate * factor * dt) / 1000);
		return this.#revealed;
	}

	/** Characters currently shown (fractional internally, floor to slice). */
	get revealed(): number {
		return Math.floor(this.#revealed);
	}

	/** Whether the reveal still trails the received stream. */
	get behind(): boolean {
		return this.#revealed < this.#target;
	}

	/** Snap to fully revealed (stream finalized / block settled). */
	finish(): void {
		this.#revealed = this.#target;
	}
}

/** Visible cells of hot trail at the newest edge. */
const HOT_TAIL_CELLS = 12;

function hexChannel(hex: string, i: number): number {
	return parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
}

function mix(a: string, b: string, t: number): string {
	const rgb = [0, 1, 2].map(i => Math.round(hexChannel(a, i) + (hexChannel(b, i) - hexChannel(a, i)) * t));
	return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

type FollowTheme = Pick<Theme, "getColorHex">;

/**
 * Paint the hot trail onto the LAST row of a live reveal: the trailing
 * {@link HOT_TAIL_CELLS} visible characters grade from the surface's cooled
 * body color through bright silver to gold at the very tip. The tail is
 * rebuilt from the row's plain text (prose-only thinking has no inner styling
 * to lose); the head keeps its original ANSI untouched.
 *
 * `cooledToken` names the surface the trail cools back into: reasoning rows
 * cool to `thinkingText` (the default); a running tool's live stdout tail
 * cools to `toolOutput`. One gradient owner for every live surface.
 */
export function paintHotTail(
	row: string,
	theme: FollowTheme,
	trueColor: boolean,
	cooledToken: "thinkingText" | "toolOutput" = "thinkingText",
): string {
	if (!trueColor) return row;
	const plain = row.replace(/\x1b\[[0-9;]*m/g, "");
	const width = visibleWidth(plain);
	if (width === 0) return row;
	const tip = Math.min(HOT_TAIL_CELLS, width);
	const head = truncateToWidth(row, width - tip, "");
	const tailPlain = plain.slice(plain.length - tip);
	const cooled = theme.getColorHex(cooledToken);
	const bright = theme.getColorHex("mdHeading");
	const gold = theme.getColorHex("matchHighlight");
	let out = head;
	for (let i = 0; i < tailPlain.length; i++) {
		// 0 → oldest of the tail (cooled), 1 → the newest character (gold).
		const t = tailPlain.length === 1 ? 1 : i / (tailPlain.length - 1);
		out += `${t < 0.6 ? mix(cooled, bright, t / 0.6) : mix(bright, gold, (t - 0.6) / 0.4)}${tailPlain[i]}`;
	}
	return `${out}\x1b[39m`;
}

/** Exposed for the follow test suite. */
export const FOLLOW_TUNING = {
	minRate: MIN_RATE,
	maxRate: MAX_RATE,
	catchupSoftChars: CATCHUP_SOFT_CHARS,
	hardSnapChars: HARD_SNAP_CHARS,
	hotTailCells: HOT_TAIL_CELLS,
} as const;
