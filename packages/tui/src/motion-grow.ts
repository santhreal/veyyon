// A block of rows that grows into place instead of appearing whole.
//
// The suggestion popup, and any other block appended under a live surface, used
// to be a cut: five rows of chrome existed on one frame that did not exist on
// the frame before. The eye reads that as the composer jumping rather than as a
// list opening, and it happens on almost every keystroke.
//
// A reveal is two transforms over rows that are ALREADY rendered: the block is
// clipped to the rows it has grown to, and every visible row resolves out of the
// ground behind it. Nothing upstream renders differently while it plays, so a
// frame of the animation is byte-assertable and the component stays ignorant of
// motion.
//
// The reveal is armed by the block APPEARING, not by every render of it. That is
// the whole reason this is a class and not a function: a popup rebuilds its list
// on every keystroke, and a reveal that restarted on each rebuild would replay a
// 220ms grow per character typed, which is worse than no motion at all.

import { type Animation, type AnimationCurve, MOTION, type MotionClock, motionClock } from "./motion";
import { fadeLinesTowards, revealedRows } from "./motion-paint";

export interface BlockRevealOptions {
	/** Called on every animated frame, so the host repaints between input events. */
	requestRender: () => void;
	/**
	 * False lands the reveal at 1 immediately and registers nothing on the clock:
	 * the block appears whole, exactly as it did before. This is the ambient
	 * transitions/truecolor gate, which the HOST owns — a component honors what it
	 * is given so a direct construction stays deterministic.
	 */
	enabled?: boolean;
	/** The clock to run on. Tests pass a hand-ticked one. */
	clock?: MotionClock;
	/**
	 * Ground the rows resolve out of, as `#rrggbb`. Omitted means the rows are
	 * clipped but never faded, which is what a caller that cannot know the ground
	 * behind it should ask for: a fade toward a guessed color is a visible color
	 * shift, while no fade is merely less motion.
	 */
	ground?: string;
	/** Which motion this is. Defaults to {@link MOTION.enter}. */
	curve?: AnimationCurve;
	/**
	 * Smallest block worth painting, in rows. A list's is 1 — one suggestion is a
	 * real frame of the animation — where a bordered card's is 2, because a lone
	 * border row reads as a stray rule.
	 */
	minimum?: number;
}

/**
 * A one-shot grow for a rendered block of rows.
 *
 * `arm()` when the block becomes visible, `disarm()` when it goes away, and pass
 * every frame's rows through `apply()`. Re-arming while already armed is a no-op,
 * so the block grows once per appearance however many times it re-renders.
 */
export class BlockReveal {
	#armed = false;
	#animation: Animation | null = null;
	readonly #requestRender: () => void;
	readonly #enabled: boolean;
	readonly #clock: MotionClock;
	readonly #ground: string | undefined;
	readonly #curve: AnimationCurve;
	readonly #minimum: number;

	constructor(options: BlockRevealOptions) {
		this.#requestRender = options.requestRender;
		this.#enabled = options.enabled ?? true;
		this.#clock = options.clock ?? motionClock;
		this.#ground = options.ground;
		this.#curve = options.curve ?? MOTION.enter;
		this.#minimum = options.minimum ?? 1;
	}

	/**
	 * How far the block has grown, 0 through 1. 1 while disarmed, so a caller that
	 * never arms anything is byte-identical to no reveal at all, and 1 again once
	 * the animation has landed — the animation's own settled value IS the resting
	 * state, so there is no second flag to keep in step with it.
	 *
	 * The timeline starts on the FIRST READ after arming rather than at `arm()`
	 * itself: the block can be armed a frame or more before it is painted (a
	 * debounced provider answering, a host that renders on its own schedule), and
	 * an arm-anchored clock plays the grow to nobody.
	 */
	get value(): number {
		if (!this.#armed) return 1;
		const animation = this.#animation;
		if (animation !== null) return animation.value;
		const started = this.#clock.animate(this.#curve, {
			from: 0,
			to: 1,
			enabled: this.#enabled,
			onFrame: () => {
				this.#requestRender();
			},
		});
		this.#animation = started;
		return started.value;
	}

	/**
	 * The block just appeared: grow it. Idempotent while it is already armed —
	 * a re-render, a refreshed item list, or a second arm on the same appearance
	 * must not restart the grow.
	 */
	arm(): void {
		if (this.#armed) return;
		this.#armed = true;
		this.#animation = null;
	}

	/**
	 * The block went away: cancel whatever it was playing and forget it, so the
	 * next `arm()` grows again and no frame is requested for a block nobody is
	 * painting. This is also the whole of teardown — a host going away wants
	 * exactly the same thing, so there is no second spelling of it.
	 */
	disarm(): void {
		this.#animation?.cancel();
		this.#animation = null;
		this.#armed = false;
	}

	/**
	 * Clip and fade one frame of the block. Returns the rows untouched once the
	 * reveal has settled or was never armed, so a settled block costs one branch.
	 */
	apply(rows: readonly string[]): readonly string[] {
		const progress = this.value;
		if (progress >= 1) return rows;
		const shown = revealedRows(rows.length, progress, this.#minimum);
		const clipped = rows.slice(0, shown);
		return this.#ground === undefined ? clipped : fadeLinesTowards(clipped, this.#ground, progress);
	}
}
