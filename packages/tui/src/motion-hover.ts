// The pointer band, faded in and out instead of switched.
//
// A hover band used to be a boolean: the row under the pointer was painted with
// the selection background on the frame the motion report arrived, and unpainted
// on the frame it left. Dragging the pointer down a list therefore strobed — a
// hard band jumping row to row at whatever rate the terminal coalesces motion
// reports, which is the one place in a terminal UI where a 90ms fade is the
// difference between "the list is tracking me" and "something is flashing".
//
// The state is per ROW rather than one "current strength", because the interesting
// frame is the one where two rows are painted at once: the row the pointer left is
// still on its way out while the row it arrived at is on its way in. A single
// strength cannot express that, and every attempt to fake it (fade out fully, then
// fade in) doubles the latency of a gesture that has to feel immediate.
//
// Nothing here knows what a band looks like. It owns WHEN each row is at what
// strength; the theme owns what strength 0.4 paints as.

import { type Animation, MOTION, type MotionClock, motionClock } from "./motion";

export interface HoverFadeOptions {
	/** Called on every animated frame, so the host repaints between mouse reports. */
	requestRender: () => void;
	/**
	 * False lands every row on its final strength at once and registers nothing,
	 * which is the binary band this replaced. A non-truecolor terminal, or a user
	 * with transitions off, sees exactly what it saw before.
	 */
	enabled?: boolean;
	/** The clock to run on. Tests pass a hand-ticked one. */
	clock?: MotionClock;
}

/**
 * Cross-fading hover strength, keyed by whatever identifies a row.
 *
 * A row the pointer arrives at travels to 1, a row it leaves travels to 0 and is
 * forgotten when it gets there. `strengthAt` is what a renderer reads; it returns
 * 0 for every row that is neither hovered nor still leaving, so a list with no
 * pointer over it pays one map lookup per row and nothing else.
 *
 * The key is the list's own row identity, not a screen position: an index for a
 * list that hover-tests to one, a setting id for a list that hover-tests to that.
 * A band must survive the row moving under it — a filter keystroke, a scroll — and
 * a screen-position key would restart the fade on the wrong row.
 */
export class HoverFade<K = number> {
	/** Live fades by row key. A settled fade-out deletes its own entry. */
	readonly #fades = new Map<K, Animation>();
	#key: K | null = null;
	readonly #requestRender: () => void;
	readonly #enabled: boolean;
	readonly #clock: MotionClock;

	constructor(options: HoverFadeOptions) {
		this.#requestRender = options.requestRender;
		this.#enabled = options.enabled ?? true;
		this.#clock = options.clock ?? motionClock;
	}

	/** The row the pointer is over, or null. */
	get key(): K | null {
		return this.#key;
	}

	/** How many rows are still painting a band. Live fades, not hovered rows. */
	get liveCount(): number {
		return this.#fades.size;
	}

	/**
	 * Point at a row (null for "the pointer left the list"). Returns true when
	 * something changed and the host must repaint; a report naming the row that
	 * is already hovered changes nothing, which is most of them.
	 */
	set(key: K | null): boolean {
		if (key === this.#key) return false;
		this.#key = key;
		// Iterating a copy: a settled fade-out deletes its own entry from `onDone`,
		// which `#retarget` reaches synchronously when motion is off.
		for (const [row, fade] of [...this.#fades]) {
			if (row === key) continue;
			this.#retarget(row, fade, 0);
		}
		if (key !== null) {
			const existing = this.#fades.get(key);
			if (existing !== undefined) this.#retarget(key, existing, 1);
			else this.#start(key);
		}
		this.#requestRender();
		return true;
	}

	/** Band strength for a row, 0 (no band) through 1 (the full band). */
	strengthAt(key: K): number {
		return this.#fades.get(key)?.value ?? 0;
	}

	/**
	 * Drop every fade without painting another frame. The host is going away, so
	 * a settling band has nothing left to settle onto, and an animation still
	 * registered with the shared clock would keep the ticker awake for a list
	 * that no longer exists.
	 */
	dispose(): void {
		for (const fade of this.#fades.values()) fade.cancel();
		this.#fades.clear();
		this.#key = null;
	}

	#start(key: K): void {
		const fade = this.#clock.animate(MOTION.hover, {
			to: 1,
			enabled: this.#enabled,
			onFrame: () => {
				this.#requestRender();
			},
			onDone: () => {
				// A settled fade is forgotten unless it is the row the pointer is on:
				// that one is the resting band `strengthAt` reads while the pointer
				// sits still, and the value a later fade-out starts from. Deciding it
				// from the CURRENT hovered row rather than from the target this fade
				// was started with is what keeps a row that was left and re-entered
				// from settling into an entry nothing ever removes.
				if (this.#key !== key) this.#fades.delete(key);
			},
		});
		this.#fades.set(key, fade);
	}

	#retarget(key: K, fade: Animation, to: number): void {
		fade.retarget(to);
		// No motion: land it now. `finish` runs the fade's onDone, which is what
		// drops a row on its way out, so the map stays the same size it would be
		// after an animated fade-out settled.
		if (!this.#enabled) fade.finish();
		else this.#clock.resume(fade);
		if (key === this.#key) return;
		if (fade.done) this.#fades.delete(key);
	}
}
