/**
 * Two schedulers, one for each way a test drives frames.
 *
 * {@link StressRenderScheduler} runs everything the engine queues until it stops queueing, which is
 * what a suite wants when it cares about the settled screen. {@link ManualRenderScheduler} runs
 * nothing on its own: it holds each armed frame so a suite can read what the engine ASKED for —
 * the delay, whether an earlier request was cancelled and re-armed — before anything paints. A
 * latency question can only be answered by the second, because a frame that has already run no
 * longer says when it was going to.
 */

import type { RenderScheduler } from "@veyyon/tui/tui";
import type { VirtualTerminal } from "../terminal/virtual-terminal";

export class StressRenderScheduler implements RenderScheduler {
	#time = 0;
	#nextTimerId = 0;
	#immediateCallbacks: (() => void)[] = [];
	#renderCallbacks = new Map<number, () => void>();

	now(): number {
		this.#time += 20;
		return this.#time;
	}

	/** Bump the synthetic clock without firing callbacks (time-gap simulation). */
	advance(ms: number): void {
		this.#time += ms;
	}

	scheduleImmediate(callback: () => void): void {
		this.#immediateCallbacks.push(callback);
	}

	scheduleRender(callback: () => void, _delayMs: number): { cancel(): void } {
		const id = this.#nextTimerId;
		this.#nextTimerId += 1;
		this.#renderCallbacks.set(id, callback);
		return {
			cancel: () => {
				this.#renderCallbacks.delete(id);
			},
		};
	}

	async drain(term: VirtualTerminal): Promise<void> {
		let rounds = 0;
		while (this.#immediateCallbacks.length > 0 || this.#renderCallbacks.size > 0) {
			rounds += 1;
			if (rounds > 100) {
				throw new Error("Render scheduler did not settle after 100 drain rounds");
			}
			const immediate = this.#immediateCallbacks;
			this.#immediateCallbacks = [];
			for (const callback of immediate) callback();

			if (this.#renderCallbacks.size === 0) continue;
			const render = [...this.#renderCallbacks.values()];
			this.#renderCallbacks.clear();
			for (const callback of render) callback();
		}
		await term.flush();
	}
}

/** A clock a render can charge its own cost to, so a test can make a frame expensive. */
export interface FrameClock {
	time: number;
}

/** A frame the engine armed, held until the test decides to run it. */
export interface ArmedFrame {
	delayMs: number;
	run: () => void;
	cancelled: boolean;
}

/** How immediate callbacks are handled: run where they are scheduled, or queued for the test. */
export type ImmediateMode = "inline" | "queued";

/**
 * A scheduler that arms frames and runs none of them.
 *
 * The clock only moves when a test moves it, or when a frame that costs something runs, so a delay
 * read back from {@link pending} is the delay the engine computed and not a wall-clock sample.
 */
export class ManualRenderScheduler implements RenderScheduler, FrameClock {
	time = 0;
	readonly armed: ArmedFrame[] = [];
	readonly immediates: Array<() => void> = [];
	readonly #immediateMode: ImmediateMode;

	constructor(immediateMode: ImmediateMode = "inline") {
		this.#immediateMode = immediateMode;
	}

	now(): number {
		return this.time;
	}

	/** Move the clock without running anything. */
	advance(ms: number): void {
		this.time += ms;
	}

	scheduleImmediate(callback: () => void): void {
		if (this.#immediateMode === "inline") callback();
		else this.immediates.push(callback);
	}

	/** Run the queued immediate callbacks, answering how many ran. Inline mode leaves none. */
	runImmediates(): number {
		const queued = this.immediates.splice(0, this.immediates.length);
		for (const callback of queued) callback();
		return queued.length;
	}

	scheduleRender(callback: () => void, delayMs: number): { cancel(): void } {
		const entry: ArmedFrame = { delayMs, run: callback, cancelled: false };
		this.armed.push(entry);
		return {
			cancel(): void {
				entry.cancelled = true;
			},
		};
	}

	/** The frame waiting to paint, if the engine has one armed. */
	pending(): ArmedFrame | undefined {
		return this.armed.filter(entry => !entry.cancelled).at(-1);
	}

	/** Wait out the pending frame's delay and run it. Its own render charges whatever it costs. */
	runPending(): void {
		const frame = this.pending();
		if (!frame) throw new Error("no frame was armed");
		this.time += frame.delayMs;
		this.armed.length = 0;
		frame.run();
	}

	/**
	 * Run frames until none is armed, answering how many ran. `maxFrames` is a termination
	 * assertion, not a tuning knob: a scheduler that re-arms forever fails here instead of hanging.
	 */
	drainFrames(maxFrames: number): number {
		let ran = 0;
		while (this.pending()) {
			if (ran === maxFrames) throw new Error(`still arming frames after ${maxFrames}`);
			this.runPending();
			ran++;
		}
		return ran;
	}
}
