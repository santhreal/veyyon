// One clock for every animation in the terminal.
//
// Before this, each animated surface owned a `setInterval` and its own easing
// maths: the welcome bloom, the modal reveal, the spinners, the pause field.
// That has three costs. Two surfaces animating at once run two timers that
// never share a frame, so their motion beats against each other. A timer that
// outlives its component keeps waking the process. And every surface picks its
// own curve, so nothing in the product moves the same way twice.
//
// A MotionClock owns a single ticker. Animations register with it, the clock
// samples them all on one frame and calls each one's onFrame, and it stops
// ticking the moment nothing is live. Curves and durations live in one table
// (MOTION), so "how this product moves" is a single edit.
//
// Interruption is the point of the spring mode. A value that is retargeted
// mid-flight keeps its velocity instead of snapping to a new curve, which is
// what separates motion that feels physical from motion that feels scripted:
// hover from row to row, or a list that is scrolled while it is still settling,
// stays continuous.

/** A normalized easing curve: 0 → 0, 1 → 1, sampled on [0, 1]. */
export type Easing = (t: number) => number;

export const linear: Easing = t => t;
/** Fast start, gentle landing. The workhorse for anything appearing. */
export const easeOutCubic: Easing = t => 1 - (1 - t) ** 3;
/** Sharper landing than cubic: reads as "arrived" rather than "drifted". */
export const easeOutQuint: Easing = t => 1 - (1 - t) ** 5;
/** Symmetric, for a value that moves between two resting states. */
export const easeInOutCubic: Easing = t => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
/** Gentle acceleration away, for anything leaving. */
export const easeInCubic: Easing = t => t ** 3;

/**
 * A mass-spring-damper, integrated per frame. `damping` at or above the
 * critical value 2·sqrt(stiffness·mass) settles without overshoot; slightly
 * under it gives the single small overshoot that reads as responsive rather
 * than springy.
 */
export interface SpringSpec {
	stiffness: number;
	damping: number;
	mass?: number;
	/** Distance and speed below which the spring is called settled. */
	restDelta?: number;
}

/**
 * The product's motion vocabulary. Every animated surface names one of these
 * instead of inventing a duration, so the whole terminal moves as one thing.
 */
export const MOTION = {
	/** A surface arriving: card, popup, panel. */
	enter: { duration: 220, easing: easeOutQuint },
	/** The same surface leaving. Shorter — waiting on an exit feels broken. */
	exit: { duration: 130, easing: easeInCubic },
	/** A pointer affordance lighting up. Must be under a frame of perception. */
	hover: { duration: 90, easing: easeOutCubic },
	/** Content growing or collapsing in place. */
	expand: { duration: 180, easing: easeOutQuint },
	/** A selection or caret travelling between two rows, interruptible. */
	move: { spring: { stiffness: 260, damping: 30, mass: 1 } },
	/** A value being nudged, e.g. a progress or context bar. */
	settle: { spring: { stiffness: 170, damping: 26, mass: 1 } },
} as const satisfies Record<string, AnimationCurve>;

/** Either mode a motion can run in: a fixed curve, or a spring. */
export type AnimationCurve = { duration: number; easing: Easing } | { spring: SpringSpec };

export interface AnimationSpec {
	/** Starting value; defaults to 0. */
	from?: number;
	/** Target value. */
	to: number;
	/** Called once per sampled frame while the animation is live. */
	onFrame?: (value: number) => void;
	/** Called once when the animation settles or is finished early. */
	onDone?: () => void;
}

/**
 * Distance from target, as a fraction of the whole travel, at which a spring
 * is called settled. Springs approach asymptotically, so this is what decides
 * how long the clock keeps waking: at a thousandth, the tail of a soft spring
 * ticks for another third of a second after the motion is visually over, on a
 * grid whose smallest unit is one terminal row.
 */
const DEFAULT_REST_DELTA = 0.005;
const FRAME_MS = 1000 / 60;
/** A frame gap longer than this is a stall (debugger, blocked loop); the
 * animation jumps rather than replaying the missed time in one lurch. */
const MAX_FRAME_MS = 100;

/**
 * A single running value. Read `value` during render; the clock advances it.
 * An animation is inert once `done`, and the clock forgets it.
 */
export class Animation {
	#value: number;
	#target: number;
	#velocity = 0;
	#elapsed = 0;
	#from: number;
	#done = false;
	readonly #curve: AnimationCurve;
	readonly #onFrame?: (value: number) => void;
	readonly #onDone?: () => void;

	constructor(curve: AnimationCurve, spec: AnimationSpec) {
		this.#curve = curve;
		this.#from = spec.from ?? 0;
		this.#value = this.#from;
		this.#target = spec.to;
		this.#onFrame = spec.onFrame;
		this.#onDone = spec.onDone;
		if (this.#value === this.#target) this.#done = true;
	}

	get value(): number {
		return this.#value;
	}

	get target(): number {
		return this.#target;
	}

	get done(): boolean {
		return this.#done;
	}

	/**
	 * Aim at a new target without losing what the value is doing right now. In
	 * spring mode the current velocity carries into the new motion; in curve
	 * mode the curve restarts from the current value, which is the closest a
	 * fixed curve gets to continuity.
	 */
	retarget(to: number): void {
		if (to === this.#target && !this.#done) return;
		this.#target = to;
		this.#from = this.#value;
		this.#elapsed = 0;
		this.#done = this.#value === to && Math.abs(this.#velocity) < DEFAULT_REST_DELTA;
	}

	/** Jump to the target and settle. Used on dismount and by reduced motion. */
	finish(): void {
		if (this.#done) return;
		this.#value = this.#target;
		this.#velocity = 0;
		this.#done = true;
		this.#onFrame?.(this.#value);
		this.#onDone?.();
	}

	/** Settle where it stands, without reaching the target and without onDone. */
	cancel(): void {
		this.#done = true;
	}

	/** Advance by `dtMs`. Returns true while the animation is still live. */
	step(dtMs: number): boolean {
		if (this.#done) return false;
		const dt = Math.min(Math.max(dtMs, 0), MAX_FRAME_MS);
		if ("spring" in this.#curve) this.#stepSpring(dt);
		else this.#stepCurve(dt);
		this.#onFrame?.(this.#value);
		if (this.#done) this.#onDone?.();
		return !this.#done;
	}

	#stepCurve(dt: number): void {
		const { duration, easing } = this.#curve as { duration: number; easing: Easing };
		this.#elapsed += dt;
		const t = duration <= 0 ? 1 : Math.min(1, this.#elapsed / duration);
		this.#value = this.#from + (this.#target - this.#from) * easing(t);
		if (t >= 1) {
			this.#value = this.#target;
			this.#done = true;
		}
	}

	#stepSpring(dt: number): void {
		const {
			stiffness,
			damping,
			mass = 1,
			restDelta = DEFAULT_REST_DELTA,
		} = (this.#curve as { spring: SpringSpec }).spring;
		// Fixed sub-steps keep the integrator stable when a frame runs long; a
		// single big step at 60 Hz stiffness diverges instead of settling.
		let remaining = dt;
		while (remaining > 0) {
			const h = Math.min(remaining, FRAME_MS) / 1000;
			remaining -= Math.min(remaining, FRAME_MS);
			const displacement = this.#value - this.#target;
			const acceleration = (-stiffness * displacement - damping * this.#velocity) / mass;
			this.#velocity += acceleration * h;
			this.#value += this.#velocity * h;
		}
		// Scaled by travel, so a spring over twenty rows and one over a single
		// unit both stop when they are visually there rather than one of them
		// creeping for another few hundred frames.
		const rest = restDelta * Math.max(1, Math.abs(this.#target - this.#from));
		if (Math.abs(this.#value - this.#target) < rest && Math.abs(this.#velocity) < rest * 60) {
			this.#value = this.#target;
			this.#velocity = 0;
			this.#done = true;
		}
	}
}

/**
 * The ticker every animation shares. Production code uses {@link motionClock};
 * a test builds its own and calls {@link MotionClock.tick} with the frame times
 * it wants, so motion is asserted frame by frame without a real timer.
 */
export class MotionClock {
	#live = new Set<Animation>();
	#timer: NodeJS.Timeout | null = null;
	#lastTick: number | null = null;
	readonly #now: () => number;
	readonly #autoTick: boolean;

	constructor(options: { now?: () => number; autoTick?: boolean } = {}) {
		this.#now = options.now ?? (() => performance.now());
		this.#autoTick = options.autoTick ?? false;
	}

	get liveCount(): number {
		return this.#live.size;
	}

	/**
	 * Start a value moving. With `enabled: false` the animation lands on its
	 * target immediately and never registers, which is how a terminal without
	 * truecolor, or a user with transitions off, sees the end state and no
	 * motion at all.
	 */
	animate(curve: AnimationCurve, spec: AnimationSpec & { enabled?: boolean }): Animation {
		const animation = new Animation(curve, spec);
		if (spec.enabled === false) {
			animation.finish();
			return animation;
		}
		if (!animation.done) {
			this.#live.add(animation);
			this.#ensureTicking();
		}
		return animation;
	}

	/** Re-register an animation that was retargeted after settling. */
	resume(animation: Animation): void {
		if (animation.done) return;
		this.#live.add(animation);
		this.#ensureTicking();
	}

	/** Advance every live animation by the time since the previous tick. */
	tick(now: number = this.#now()): void {
		const dt = this.#lastTick === null ? FRAME_MS : now - this.#lastTick;
		this.#lastTick = now;
		for (const animation of [...this.#live]) {
			if (!animation.step(dt)) this.#live.delete(animation);
		}
		if (this.#live.size === 0) this.#stopTicking();
	}

	/** Drop everything, used when a screen tears down. */
	clear(): void {
		this.#live.clear();
		this.#stopTicking();
	}

	#ensureTicking(): void {
		if (!this.#autoTick || this.#timer !== null) return;
		this.#lastTick = this.#now();
		this.#timer = setInterval(() => this.tick(), FRAME_MS);
		this.#timer.unref?.();
	}

	#stopTicking(): void {
		if (this.#timer === null) return;
		clearInterval(this.#timer);
		this.#timer = null;
		this.#lastTick = null;
	}
}

/** The clock the running product uses. */
export const motionClock = new MotionClock({ autoTick: true });
