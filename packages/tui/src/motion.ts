import { clamp } from "@veyyon/utils/math";

export type Easing = (t: number) => number;

export const linear: Easing = t => t;
export const easeOutCubic: Easing = t => 1 - (1 - t) ** 3;
export const easeOutQuint: Easing = t => 1 - (1 - t) ** 5;
export const easeInOutCubic: Easing = t => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
export const easeInCubic: Easing = t => t ** 3;

export interface SpringSpec {
	stiffness: number;
	damping: number;
	mass?: number;
	restDelta?: number;
}

export const MOTION = {
	enter: { duration: 260, easing: easeOutQuint },
	hover: { duration: 90, easing: easeOutCubic },
	expand: { duration: 180, easing: easeOutQuint },
	reflow: { duration: 320, easing: easeInOutCubic },
	move: { spring: { stiffness: 260, damping: 30, mass: 1 } },
	settle: { spring: { stiffness: 170, damping: 26, mass: 1 } },
} as const satisfies Record<string, AnimationCurve>;

export type AnimationCurve = { duration: number; easing: Easing } | { spring: SpringSpec };

export interface AnimationSpec {
	from?: number;
	to: number;
	onFrame?: (value: number) => void;
	onDone?: () => void;
}

const DEFAULT_REST_DELTA = 0.005;
const FRAME_MS = 1000 / 60;
const MAX_FRAME_MS = 100;
const MAX_MOTION_MS = 4000;

function isPositiveFinite(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

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
	return (FRAME_MS / 1000) * Math.sqrt(stiffness / mass) < 2;
}

export class Animation {
	#value: number;
	#target: number;
	#velocity = 0;
	#elapsed = 0;
	#from: number;
	#done = false;
	readonly #curve: AnimationCurve;
	readonly #settles: boolean;
	readonly #onFrame?: (value: number) => void;
	readonly #onDone?: () => void;

	constructor(curve: AnimationCurve, spec: AnimationSpec) {
		this.#curve = curve;
		const from = spec.from;
		this.#from = from !== undefined && Number.isFinite(from) ? from : 0;
		this.#value = this.#from;
		this.#target = spec.to;
		this.#onFrame = spec.onFrame;
		this.#onDone = spec.onDone;
		this.#settles = curveSettles(curve);
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

	finish(): void {
		if (this.#done) return;
		this.#value = this.#target;
		this.#velocity = 0;
		this.#done = true;
		this.#onFrame?.(this.#value);
		this.#onDone?.();
	}

	cancel(): void {
		this.#done = true;
	}

	step(dtMs: number): boolean {
		if (this.#done) return false;
		const dt = clamp(dtMs, 0, MAX_FRAME_MS);
		this.#elapsed += dt;
		if ("spring" in this.#curve) this.#stepSpring(dt);
		else this.#stepCurve();
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
		let remaining = dt;
		while (remaining > 0) {
			const h = Math.min(remaining, FRAME_MS) / 1000;
			remaining -= Math.min(remaining, FRAME_MS);
			const displacement = this.#value - this.#target;
			const acceleration = (-stiffness * displacement - damping * this.#velocity) / mass;
			this.#velocity += acceleration * h;
			this.#value += this.#velocity * h;
		}
		const rest = restDelta * Math.max(1, Math.abs(this.#target - this.#from));
		if (Math.abs(this.#value - this.#target) < rest && Math.abs(this.#velocity) < rest * 60) {
			this.#value = this.#target;
			this.#velocity = 0;
			this.#done = true;
		}
	}
}

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

	resume(animation: Animation): void {
		if (animation.done) return;
		this.#live.add(animation);
		this.#ensureTicking();
	}

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

export const motionClock = new MotionClock({ autoTick: true });
