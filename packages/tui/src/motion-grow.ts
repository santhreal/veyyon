// Block reveal animation controller for expanding popup elements.
import { type Animation, type AnimationCurve, MOTION, type MotionClock, motionClock } from "./motion";
import { fadeLinesTowards, revealedRows } from "./motion-paint";

export interface BlockRevealOptions {
	/** Called on every animated frame, so the host repaints between input events. */
	requestRender: () => void;
	/** Disable animation and display block immediately at full size. */
	enabled?: boolean;
	/** The clock to run on. Tests pass a hand-ticked one. */
	clock?: MotionClock;
	/** Ground background color `#rrggbb` for fade transitions. */
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

	/** Growth progress from 0 to 1 (1 when disarmed or settled). */
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
