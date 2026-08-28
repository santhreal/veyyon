// Unified animation clock and motion curves for terminal components.

import { clamp } from "@veyyon/utils/math";

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
	/** Content appearing: popup grow. */
	enter: { duration: 260, easing: easeOutQuint },
	/** A pointer affordance lighting up. Must be under a frame of perception. */
	hover: { duration: 90, easing: easeOutCubic },
	/** Content growing or collapsing in place. */
	expand: { duration: 180, easing: easeOutQuint },
	/** Row reflowing content sideways or changing width in place. */
	reflow: { duration: 320, easing: easeInOutCubic },
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
/** Maximum animation lifetime from last retarget before forcing completion. */
const MAX_MOTION_MS = 4000;

function isPositiveFinite(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

/** Check whether an animation curve or spring spec can settle at its resting state. */
function curveSettles(curve: AnimationCurve): boolean {
	if (!("spring" in curve)) return Number.isFinite(curve.duration);
	const { stiffness, damping, mass = 1, restDelta = DEFAULT_REST_DELTA } = curve.spring;
	if (
		!isPositiveFinite(stiffness) ||
		!isPositiveFinite(damping) ||
		!isPositiveFinite(mass) ||
		!isPositiveFinite(restDelta)
	) {
		return false;
	}
	// Stability limit for semi-implicit Euler integration at 60Hz sub-step.
	return (FRAME_MS / 1000) * Math.sqrt(stiffness / mass) < 2;
}

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
	/** False when this curve provably cannot reach rest; see {@link curveSettles}. */
	readonly #settles: boolean;
	readonly #onFrame?: (value: number) => void;
	readonly #onDone?: () => void;

	constructor(curve: AnimationCurve, spec: AnimationSpec) {
		this.#curve = curve;
		// A start that is not a number is not a position, and 0 is already what
		// `from` means when it is left out.
		const from = spec.from;
		this.#from = from !== undefined && Number.isFinite(from) ? from : 0;
		this.#value = this.#from;
		this.#target = spec.to;
		this.#onFrame = spec.onFrame;
		this.#onDone = spec.onDone;
		this.#settles = curveSettles(curve);
		// Everything the clock accepts must eventually report done, because that
		// is the only thing that stops the ticker. A target that is not a real
		// number is not a destination — the value stays where it is — and a curve
		// that cannot settle lands on its target the way `enabled: false` does.
		if (!Number.isFinite(this.#target)) this.#done = true;
		else if (!this.#settles) {
			this.#value = this.#target;
			this.#done = true;
		} else if (this.#value === this.#target) this.#done = true;
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

	/** Retarget animation towards a new target value, preserving velocity if spring. */
	retarget(to: number): void {
		if (!Number.isFinite(to)) return;
		if (to === this.#target && !this.#done) return;
		this.#target = to;
		this.#from = this.#value;
		this.#elapsed = 0;
		if (!this.#settles) {
			this.#value = to;
			this.#velocity = 0;
			this.#done = true;
			return;
		}
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
		const dt = clamp(dtMs, 0, MAX_FRAME_MS);
		this.#elapsed += dt;
		if ("spring" in this.#curve) this.#stepSpring(dt);
		else this.#stepCurve();
		// The backstop under the invariant the whole clock rests on. Rejecting the
		// specs that provably cannot settle is not enough on its own: a spring is
		// an asymptote with a threshold on it, and a damping small enough will
		// decay for longer than the session without ever crossing that threshold.
		// Past the deadline the value is where it was going.
		if (!this.#done && this.#elapsed >= MAX_MOTION_MS) {
			this.#value = this.#target;
			this.#velocity = 0;
			this.#done = true;
		}
		this.#onFrame?.(this.#value);
		if (this.#done) this.#onDone?.();
		return !this.#done;
	}

	#stepCurve(): void {
		const { duration, easing } = this.#curve as { duration: number; easing: Easing };
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

/** Shared animation clock ticker. */
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

	/** Register and start an animated value. */
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
		const toRemove: Animation[] = [];
		for (const anim of this.#live) {
			if (!anim.step(dt)) toRemove.push(anim);
		}
		for (let ri = 0; ri < toRemove.length; ri++) {
			this.#live.delete(toRemove[ri]!);
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
