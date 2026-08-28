import { type Animation, type AnimationCurve, MOTION, type MotionClock, motionClock } from "./motion";
import { fadeLinesTowards, revealedRows } from "./motion-paint";

export interface BlockRevealOptions {
	requestRender: () => void;
	enabled?: boolean;
	clock?: MotionClock;
	ground?: string;
	curve?: AnimationCurve;
	minimum?: number;
}

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

	arm(): void {
		if (this.#armed) return;
		this.#armed = true;
		this.#animation = null;
	}

	disarm(): void {
		this.#animation?.cancel();
		this.#animation = null;
		this.#armed = false;
	}

	apply(rows: readonly string[]): readonly string[] {
		const progress = this.value;
		if (progress >= 1) return rows;
		const shown = revealedRows(rows.length, progress, this.#minimum);
		const clipped = rows.slice(0, shown);
		return this.#ground === undefined ? clipped : fadeLinesTowards(clipped, this.#ground, progress);
	}
}
