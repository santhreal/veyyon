import { type Animation, MOTION, type MotionClock, motionClock } from "./motion";

export interface HoverFadeOptions {
	requestRender: () => void;
	enabled?: boolean;
	clock?: MotionClock;
}

export class HoverFade<K = number> {
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

	get key(): K | null {
		return this.#key;
	}

	get liveCount(): number {
		return this.#fades.size;
	}

	set(key: K | null): boolean {
		if (key === this.#key) return false;
		this.#key = key;
		for (const [row, fade] of this.#fades) {
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

	strengthAt(key: K): number {
		return this.#fades.get(key)?.value ?? 0;
	}

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
				if (this.#key !== key) this.#fades.delete(key);
			},
		});
		this.#fades.set(key, fade);
	}

	#retarget(key: K, fade: Animation, to: number): void {
		fade.retarget(to);
		if (!this.#enabled) fade.finish();
		else this.#clock.resume(fade);
		if (key === this.#key) return;
		if (fade.done) this.#fades.delete(key);
	}
}
