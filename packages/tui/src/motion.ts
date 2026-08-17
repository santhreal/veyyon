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
	/**
	 * A surface arriving: card, popup, panel. 220ms was chosen when the entrance
	 * was one fade over the whole block, where the extra 40ms bought nothing: the
	 * block had as many distinct frames as it had rows either way. With a per-row
	 * cascade every row owns a continuous ramp, so the duration is what decides how
	 * much of the overlap is visible, and at 220ms the cascade was over before the
	 * eye had followed it.
	 */
	enter: { duration: 260, easing: easeOutQuint },
	/** The same surface leaving. Shorter — waiting on an exit feels broken. */
	exit: { duration: 130, easing: easeInCubic },
	/** A pointer affordance lighting up. Must be under a frame of perception. */
	hover: { duration: 90, easing: easeOutCubic },
	/** Content growing or collapsing in place. */
	expand: { duration: 180, easing: easeOutQuint },
	/**
	 * One specular highlight crossing a surface that has just arrived. It outlasts
	 * the entrance deliberately: the card is in place and settled while the light
	 * is still travelling over it, which is what reads as material rather than as a
	 * transition. Slower than everything else here because it is the only motion in
	 * the product with a frame for every frame of the clock — it moves through
	 * colour, not through terminal rows, so it cannot look stepped.
	 */
	sweep: { duration: 520, easing: easeOutCubic },
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
 * The longest an animation may run from its last retarget before the clock
 * lands it and lets go. Nothing in {@link MOTION} travels for more than about
 * two thirds of a second, so this is six times the longest real motion and
 * never fires for one; it exists because "the animation reports done" is what
 * stops the ticker, and an animation that never reports done is a 60fps
 * repaint of the whole terminal for as long as the process lives. A spring is
 * an asymptote with a threshold on it, and a threshold is exactly the kind of
 * condition that can be missed forever: an integrator that diverges to
 * Infinity never comes back inside its rest band, and a spring damped by an
 * arbitrarily small amount decays for arbitrarily long. Retargeting resets the
 * deadline, so a value the host keeps moving is never cut off mid-travel.
 */
const MAX_MOTION_MS = 4000;

function isPositiveFinite(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

/**
 * Whether a curve can reach its resting state at all. A spring settles only
 * with a restoring force, dissipation, finite inertia, a rest band it can
 * enter, and a period the integrator can resolve: zero or negative damping
 * conserves or pumps energy and oscillates forever, zero stiffness never pulls
 * toward the target, infinite mass never moves, a zero restDelta is a
 * threshold an asymptote never crosses, and a stiffness past the sub-step's
 * stability limit diverges to Infinity. A fixed curve settles whenever its
 * duration is a real number — zero and negative land on the first frame, where
 * NaN and Infinity never let the normalized time reach 1.
 *
 * A spec that fails this is a caller error, and the honest answer to it is the
 * one `enabled: false` already gives: the value is at its target, and nothing
 * registers with the clock.
 */
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
	// Semi-implicit Euler is stable only while its step is short against the
	// spring's own period. Past h·sqrt(k/m) = 2 the integrator gains energy on
	// every step and the value walks out to Infinity instead of settling, which
	// puts it outside a rest band it can never re-enter. The sub-step is pinned
	// at one 60Hz frame, so this is a property of the spec alone and the answer
	// is available here rather than a hundred frames into the divergence.
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

	/**
	 * Aim at a new target without losing what the value is doing right now. In
	 * spring mode the current velocity carries into the new motion; in curve
	 * mode the curve restarts from the current value, which is the closest a
	 * fixed curve gets to continuity.
	 */
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
