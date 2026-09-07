/**
 * The clock and timers the engine schedules frames on. A test hands the `TUI`
 * a manual one and steps it; the default is the event loop.
 */
import { performance } from "node:perf_hooks";

export interface RenderTimer {
	cancel(): void;
}

export interface RenderScheduler {
	now(): number;
	scheduleImmediate(callback: () => void): void;
	scheduleRender(callback: () => void, delayMs: number): RenderTimer;
}

export const DEFAULT_RENDER_SCHEDULER: RenderScheduler = {
	now: () => performance.now(),
	scheduleImmediate: callback => {
		setImmediate(callback);
	},
	scheduleRender: (callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		return {
			cancel: () => {
				clearTimeout(timer);
			},
		};
	},
};

/**
 * When the next frame may start. Pure arithmetic over three clocks the `TUI`
 * reports: when the last frame started, how long frames have been costing,
 * and whether a keystroke asked for a frame of grace.
 */
export class RenderCadence {
	static readonly MIN_RENDER_INTERVAL_MS = 1000 / 30;
	static readonly INPUT_RENDER_GRACE_MS = RenderCadence.MIN_RENDER_INTERVAL_MS;
	/**
	 * Cap on the adaptive floor derived from `#frameCostEstimateMs`. Bounds the
	 * UI responsiveness at ~5 fps under sustained heavy renders — anything
	 * slower feels dead to the user and no longer justifies further CPU savings.
	 */
	static readonly MAX_ADAPTIVE_RENDER_MS = 200;
	/**
	 * Weight of the newest frame in `#frameCostEstimateMs`. At 0.3 a sustained
	 * change in frame cost is ~90% absorbed within seven frames, so the loop
	 * reaches its duty-cycle floor inside a quarter second of going slow, while
	 * an isolated spike lifts the floor by under a third of itself.
	 */
	static readonly FRAME_COST_SMOOTHING = 0.3;

	#lastRenderAt = 0;
	/**
	 * Decayed estimate of what a frame costs, in milliseconds. {@link delayFor}
	 * derives the adaptive floor from it to hold the render loop near a 50%
	 * duty cycle: without one the throttle collapses to zero as soon as
	 * `elapsed >= MIN_RENDER_INTERVAL_MS`, and a run of slow frames (large
	 * transcript diffs, huge assistant text wrap, component-tree walks) turns
	 * the loop into a busy loop at 40-50% CPU (see #4145).
	 *
	 * A duty cycle is a property of a window, not of one frame, and reading the
	 * previous frame alone conflated two different situations. A loop that
	 * paints slowly on every frame converges here and is held to half the CPU,
	 * which is what #4145 asked for. A single expensive paint among cheap ones
	 * moves the estimate by a fraction of itself, so the frame after it still
	 * arrives at the cadence: a scrolled viewport leaves the diff nothing to
	 * reuse and costs a full paint, and putting a 66ms floor under the cheap
	 * diff that followed it is how a session that painted on time 68% of the
	 * time published at 14.2 fps against a 30 fps capture.
	 */
	#frameCostEstimateMs = 0;
	#inputRenderGraceUntilMs = 0;

	/** Milliseconds until the next frame may start, measured from `now`. */
	delayFor(now: number): number {
		const elapsed = now - this.#lastRenderAt;
		const cadenceDelay = Math.max(0, RenderCadence.MIN_RENDER_INTERVAL_MS - elapsed);
		// Adaptive backpressure — target ~50% render duty cycle: the next frame
		// starts no sooner than `frame_end + estimated_cost`, i.e.
		// `frame_start + 2 × estimated_cost`. So `elapsed` (which counts from
		// the last frame's start) must already exceed twice the estimate before
		// we allow the follow-up render to fire. The estimate is decayed rather
		// than the previous sample, so a sustained slow loop is held to half the
		// CPU (#4145) and an isolated expensive paint is not charged to the
		// cheap frame behind it. Capped so a pathological cost cannot lock the UI.
		const adaptiveFloor = Math.min(RenderCadence.MAX_ADAPTIVE_RENDER_MS, this.#frameCostEstimateMs * 2);
		const adaptiveDelay = Math.max(0, adaptiveFloor - elapsed);
		const inputGraceDelay = Math.max(0, this.#inputRenderGraceUntilMs - now);
		return Math.max(cadenceDelay, adaptiveDelay, inputGraceDelay);
	}

	/** A frame is starting at `now`. */
	frameStarted(now: number): void {
		this.#lastRenderAt = now;
	}

	/** The frame that started at `start` has returned at `now`; fold its cost into the estimate. */
	frameEnded(start: number, now: number): void {
		this.#frameCostEstimateMs += RenderCadence.FRAME_COST_SMOOTHING * (now - start - this.#frameCostEstimateMs);
	}

	/** Hold the next frame one interval past `now`, so a double-press gesture drains its queued input first. */
	graceInput(now: number): void {
		this.#inputRenderGraceUntilMs = now + RenderCadence.INPUT_RENDER_GRACE_MS;
	}
}
