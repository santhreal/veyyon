// Smoothly animated numeric value tracking using spring physics.

import { type Animation, type AnimationCurve, MOTION, type MotionClock, motionClock } from "./motion";

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
