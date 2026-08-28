import { type Animation, type AnimationCurve, MOTION, type MotionClock, motionClock } from "./motion";

export interface SettleValueOptions {
	requestRender: () => void;
	enabled?: boolean;
	epsilon?: number;
	clock?: MotionClock;
	curve?: AnimationCurve;
}

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

	get value(): number | undefined {
		return this.#animation ? this.#animation.value : this.#value;
	}

	get live(): boolean {
		return this.#animation !== undefined && !this.#animation.done;
	}

	set(target: number): boolean {
		if (!Number.isFinite(target)) return false;
		const current = this.value;
		if (current === undefined) {
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

	finish(): void {
		if (!this.#animation) return;
		this.#value = this.#animation.target;
		this.#animation.cancel();
		this.#animation = undefined;
	}

	reset(): void {
		this.#animation?.cancel();
		this.#animation = undefined;
		this.#value = undefined;
	}

	dispose(): void {
		this.finish();
	}
}
