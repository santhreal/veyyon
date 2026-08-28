// One clock for every animation in the terminal, its curve table, and the frame
// transforms it drives.
//
// This module is pure math and pure string rewriting over lines that are already
// rendered: it performs no terminal I/O, which is why it lives in `@veyyon/utils`
// rather than in `@veyyon/tui`. A renderer of any kind — terminal, browser, test
// harness — drives the same clock and the same curves.
//
// It was five files (`motion`, `motion-paint`, `motion-grow`, `motion-hover`,
// `motion-settle`) that no consumer used one at a time: a surface that animates
// needs the clock, the curve table and at least one transform, so five imports
// bought nothing but five files to keep in sync. Each section below opens with the
// note its own file carried.

import { sgrSequence } from "./ansi";
import { clamp, clamp01 } from "./math";
import { parseHexColor } from "./paint-ground";

// ==========================================================================================================
// motion.ts
// ==========================================================================================================

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
	/** Content appearing: popup grow. */
	enter: { duration: 260, easing: easeOutQuint },
	/** A pointer affordance lighting up. Must be under a frame of perception. */
	hover: { duration: 90, easing: easeOutCubic },
	/** Content growing or collapsing in place. */
	expand: { duration: 180, easing: easeOutQuint },
	/**
	 * A row reflowing its content sideways: a status line trading one readout for a
	 * wider path, a column changing width in place.
	 *
	 * Longer and symmetric where `expand` is short and front-loaded, because the two
	 * differ in what the eye is tracking. `expand` reveals content that was not there,
	 * so a sharp landing reads as "arrived". A reflow moves text that is already on
	 * screen and being read, across a grid whose smallest step is one cell: under a
	 * fifth of a second most of a front-loaded curve lands inside two or three frames,
	 * so the row jumps and then crawls through its tail. Even distribution over a
	 * longer travel is what makes the cells appear to slide rather than cut.
	 */
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

// ==========================================================================================================
// motion-paint.ts
// ==========================================================================================================

// Frame transforms an animation drives: blending colors, fading a rendered
// block toward the ground it sits on, and growing a block a row at a time.
//
// These are pure functions over already-rendered lines. That is deliberate: a
// component renders once, at full strength, and the animation reshapes the
// bytes on the way out. Nothing downstream has to know a transition is running,
// and every frame of a transition is byte-assertable in a test.
//
// Only truecolor (`38;2;r;g;b` / `48;2;r;g;b`) is faded. An indexed color is
// left exactly as written: guessing its RGB means carrying a palette that the
// terminal may not be using, and a wrong guess is a visible color shift rather
// than a missing fade. Motion is gated on truecolor at the call site anyway.

function clampChannel(value: number): number {
	return clamp(Math.round(value), 0, 255);
}

/** `#rrggbb` from channels, each clamped to a byte. */
export function toHexColor(r: number, g: number, b: number): string {
	return `#${[r, g, b].map(c => clampChannel(c).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Mix two colors. `t` 0 returns `from`, 1 returns `to`. Blending is done on
 * the raw channels rather than in a perceptual space: over the 90-220ms these
 * transitions run, the difference is invisible, and the cost is not.
 */
export function blendHex(from: string, to: string, t: number): string {
	const a = parseHexColor(from);
	const b = parseHexColor(to);
	if (a === null || b === null) return t >= 0.5 ? to : from;
	const k = clamp01(t);
	return toHexColor(a.r + (b.r - a.r) * k, a.g + (b.g - a.g) * k, a.b + (b.b - a.b) * k);
}

/**
 * The SGR scanner. `ansi.ts` owns the pattern: four modules used to spell it
 * out themselves and the fourth had already drifted into dropping colon-form
 * truecolor. This is the fifth caller, not a fifth copy.
 */
const SGR = sgrSequence("g");

/**
 * Fade one rendered line toward `groundHex`. `strength` 1 leaves the line
 * untouched; 0 paints every truecolor channel as the ground, which reads as
 * the line dissolving into the background rather than blinking out.
 *
 * Parameters are split keeping their separators, so a colon-form sequence
 * (`ESC [ 38:2:255:0:0 m`, which libvte and several test runners emit) comes
 * back out in the spelling it went in with.
 */
export function fadeLineTowards(line: string, groundHex: string, strength: number): string {
	const k = clamp01(strength);
	if (k >= 1) return line;
	const ground = parseHexColor(groundHex);
	if (ground === null) return line;
	const channels = [ground.r, ground.g, ground.b];
	SGR.lastIndex = 0;
	return line.replace(SGR, (whole, params: string) => {
		if (params === "") return whole;
		// Even indices are values, odd indices the `;` or `:` between them.
		const tokens = params.split(/([;:])/);
		let changed = false;
		for (let i = 0; i < tokens.length; i += 2) {
			const code = tokens[i];
			if ((code !== "38" && code !== "48") || tokens[i + 2] !== "2") continue;
			const first = i + 4;
			if (tokens[first + 4] === undefined) break; // truncated triple: leave it alone
			for (let c = 0; c < 3; c++) {
				const from = Number(tokens[first + c * 2]);
				if (!Number.isFinite(from)) continue;
				tokens[first + c * 2] = String(clampChannel(channels[c]! + (from - channels[c]!) * k));
				changed = true;
			}
			i = first + 4;
		}
		return changed ? `\x1b[${tokens.join("")}m` : whole;
	});
}

/** Fade a block of rendered lines toward the ground behind it. */
export function fadeLinesTowards(lines: readonly string[], groundHex: string, strength: number): string[] {
	if (strength >= 1) return [...lines];
	return lines.map(line => fadeLineTowards(line, groundHex, strength));
}

/**
 * How many rows of a block of `total` rows are shown at `progress`. `minimum`
 * is the smallest block worth showing — a bordered card's is 2, because one
 * border row alone reads as a stray rule rather than a card opening.
 */
export function revealedRows(total: number, progress: number, minimum = 0): number {
	if (total <= 0) return 0;
	const floor = Math.min(minimum, total);
	const shown = Math.min(total, Math.round(total * clamp01(progress)));
	return Math.max(floor, shown);
}

// ==========================================================================================================
// motion-grow.ts
// ==========================================================================================================

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

// ==========================================================================================================
// motion-hover.ts
// ==========================================================================================================

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

// ==========================================================================================================
// motion-settle.ts
// ==========================================================================================================

// A number that walks to its new value instead of teleporting to it.
//
// `MOTION.settle` names this case -- "a value being nudged, e.g. a progress or
// context bar" -- and until now nothing in the product used it: every gauge
// wrote its new number straight into the next frame. That is fine for a value
// nobody watches and wrong for one that reports spend, because a jump carries
// no direction. A context gauge that drops two cells between two frames says
// "it is 6 now"; the same gauge walking those two cells says "you just spent
// two", which is the whole reason the gauge is on screen.
//
// A spring rather than a curve, because the value is retargeted while it is
// still moving -- a streaming turn revises the estimate every few hundred
// milliseconds -- and a fixed curve restarted per revision reads as a stutter.
// The spring keeps its velocity across a retarget, so a long spend is one
// continuous travel however many times the number underneath it changed.
//
// Nothing here knows what a gauge looks like. It owns WHERE the value is right
// now; the renderer owns what 61.4% draws as.
//
// The curve is an option because "a number that walks to its new value" is not
// only a gauge. A viewport's scroll offset is the same primitive read as rows
// instead of percent, and it names `MOTION.move` -- the interruptible travel a
// selection uses -- rather than `MOTION.settle`. One owner for the walking, two
// curves for what is walking.

export interface SettleValueOptions {
	/** Called on every animated frame, so the host repaints between revisions. */
	requestRender: () => void;
	/**
	 * False lands every target immediately and registers nothing, which is the
	 * jump this replaced. `display.transitions: off` sees exactly what it saw
	 * before, frame for frame.
	 */
	enabled?: boolean;
	/**
	 * Travel smaller than this is not worth a frame: the value snaps and no
	 * animation is started. A gauge quantized to eight cells and an integer
	 * percentage cannot show a tenth of a point, and a spring chasing one would
	 * keep the process ticking for nothing.
	 */
	epsilon?: number;
	/** The clock to run on. Tests pass a hand-ticked one. */
	clock?: MotionClock;
	/**
	 * Which motion the travel runs on. Defaults to {@link MOTION.settle}, the
	 * nudged-value spring. A caller whose value is a position rather than a
	 * measurement passes {@link MOTION.move}.
	 */
	curve?: AnimationCurve;
}

/**
 * One settling number.
 *
 * The FIRST value it is given lands with no travel: a gauge that sweeps up from
 * zero the first time it is painted is animating the fact that the session just
 * started, which is not a change anyone made. Every later value travels.
 */
export class SettleValue {
	#animation: Animation | undefined;
	#value: number | undefined;
	readonly #requestRender: () => void;
	readonly #enabled: boolean;
	readonly #epsilon: number;
	readonly #clock: MotionClock;
	readonly #curve: AnimationCurve;

	constructor(options: SettleValueOptions) {
		this.#requestRender = options.requestRender;
		this.#enabled = options.enabled ?? true;
		this.#epsilon = options.epsilon ?? 0;
		this.#clock = options.clock ?? motionClock;
		this.#curve = options.curve ?? MOTION.settle;
	}

	/** Where the value is right now, or undefined before it has ever been set. */
	get value(): number | undefined {
		return this.#animation ? this.#animation.value : this.#value;
	}

	/** True while a frame is still owed. */
	get live(): boolean {
		return this.#animation !== undefined && !this.#animation.done;
	}

	/**
	 * Aim at `target`. Returns true when the value moved on this call, so a
	 * caller that only wants to repaint on a change can ask.
	 */
	set(target: number): boolean {
		if (!Number.isFinite(target)) return false;
		const current = this.value;
		if (current === undefined) {
			// First sighting: this IS the value, not a change to it.
			this.#value = target;
			return true;
		}
		if (current === target && !this.live) return false;
		if (!this.#enabled || Math.abs(target - current) < this.#epsilon) {
			this.#animation?.cancel();
			this.#animation = undefined;
			this.#value = target;
			return current !== target;
		}
		if (this.#animation && !this.#animation.done) {
			this.#animation.retarget(target);
			this.#clock.resume(this.#animation);
			return true;
		}
		this.#animation = this.#clock.animate(this.#curve, {
			from: current,
			to: target,
			onFrame: () => this.#requestRender(),
		});
		return true;
	}

	/** Land on the target now, without another frame. */
	finish(): void {
		if (!this.#animation) return;
		this.#value = this.#animation.target;
		this.#animation.cancel();
		this.#animation = undefined;
	}

	/**
	 * Forget the value entirely, so the next `set` lands rather than travels.
	 * What the gauge measures went away (the segment is off, the session was
	 * replaced); the next number it is given is a first sighting again.
	 */
	reset(): void {
		this.#animation?.cancel();
		this.#animation = undefined;
		this.#value = undefined;
	}

	/** Drop the animation without painting another frame; the host is going away. */
	dispose(): void {
		this.finish();
	}
}
