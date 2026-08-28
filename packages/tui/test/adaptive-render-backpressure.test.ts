/**
 * WHY: the render loop's adaptive floor decides when the next frame may start,
 * and it has been wrong in both directions.
 *
 * First it was absent. A frame costing more than the 33ms cadence collapsed the
 * delay to zero and the next frame fired immediately (oh-my-pi#4145): during a
 * long-running eval the loop pinned 40-50% CPU and dropped visible frames.
 *
 * The fix read the PREVIOUS FRAME'S cost and put twice it under the next frame.
 * That holds a sustained slow loop to a 50% duty cycle, which is what #4145
 * asked for, but it also charges one expensive paint to the cheap frame behind
 * it. A scrolled viewport leaves the diff nothing to reuse, so one full paint
 * lands among cheap diffs and the frame after it waits 66ms for no reason. The
 * published hero take is the measurement: 68% of its moving frames arrived at
 * the 30 fps capture interval and the clip still averaged 14.2 fps, because the
 * other 32% were held for two or three intervals by a floor a spike had raised.
 *
 * The floor now comes from a decayed estimate of frame cost, so the class this
 * suite closes is "the floor answers a question about a window using one
 * sample". Both directions are pinned: a sustained slow loop must still reach a
 * floor at least as large as the frame cost and must never let the delay
 * collapse, and an isolated spike must not push the next frame past the cadence.
 *
 * What it does not catch: the cost of a paint itself. A full paint at a 2000
 * block transcript measures 31ms on the recorder's grid, and no scheduling
 * change makes that frame cheaper — see `packages/tui/bench/frame.bench.ts`.
 */
import { describe, expect, it } from "bun:test";
import { type Component, type RenderTimer, TUI } from "@veyyon/tui";
import { VirtualTerminal } from "./virtual-terminal";

const MIN_RENDER_INTERVAL_MS = 1000 / 30;
const MAX_ADAPTIVE_RENDER_MS = 200;
const FRAME_COST_SMOOTHING = 0.3;

class ScriptedFrameCost implements Component {
	#nextCostMs: number | null = null;
	scheduler!: { nowMs: number };

	/** Program the next render() to virtually consume `costMs` on the scheduler clock. */
	scheduleCost(costMs: number): void {
		this.#nextCostMs = costMs;
	}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		if (this.#nextCostMs !== null) {
			this.scheduler.nowMs += this.#nextCostMs;
			this.#nextCostMs = null;
		}
		return ["probe"];
	}
}

class DeferredRenderScheduler {
	nowMs = 0;
	readonly immediates: Array<() => void> = [];
	readonly timers: Array<{ callback: () => void; canceled: boolean; delayMs: number }> = [];

	now(): number {
		return this.nowMs;
	}

	scheduleImmediate(callback: () => void): void {
		this.immediates.push(callback);
	}

	scheduleRender(callback: () => void, delayMs: number): RenderTimer {
		const timer = { callback, canceled: false, delayMs };
		this.timers.push(timer);
		return {
			cancel: () => {
				timer.canceled = true;
			},
		};
	}
}

/** Drain immediates + fire the next scheduled render timer. Returns its `delayMs`. */
function stepRender(scheduler: DeferredRenderScheduler): number | null {
	while (scheduler.immediates.length > 0) scheduler.immediates.shift()!();
	const timer = scheduler.timers.shift();
	if (!timer || timer.canceled) return null;
	scheduler.nowMs += timer.delayMs;
	timer.callback();
	return timer.delayMs;
}

/** Start a TUI whose frame costs and clock are both scripted. */
function drive(): { tui: TUI; probe: ScriptedFrameCost; scheduler: DeferredRenderScheduler } {
	const term = new VirtualTerminal(20, 4);
	const scheduler = new DeferredRenderScheduler();
	const probe = new ScriptedFrameCost();
	probe.scheduler = scheduler;
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	tui.addChild(probe);
	tui.start();
	// Drain the start-time render, which is a full paint and not under test.
	stepRender(scheduler);
	scheduler.timers.length = 0;
	return { tui, probe, scheduler };
}

/** Render one frame costing `costMs` and return the delay the scheduler chose for it. */
function frame(tui: TUI, probe: ScriptedFrameCost, scheduler: DeferredRenderScheduler, costMs: number): number {
	probe.scheduleCost(costMs);
	tui.requestRender();
	const delay = stepRender(scheduler);
	expect(delay).not.toBeNull();
	return delay!;
}

describe("the render floor answers a question about a window", () => {
	it("keeps the plain min-interval cadence when frames are cheap", () => {
		const { tui, probe, scheduler } = drive();
		try {
			for (let i = 0; i < 3; i++) {
				// The cadence floor is min-interval; the adaptive floor from a
				// 1ms estimate is well below it, so the delay is the cadence.
				expect(frame(tui, probe, scheduler, 1)).toBeLessThanOrEqual(MIN_RENDER_INTERVAL_MS + 1);
			}
		} finally {
			tui.stop();
		}
	});

	it("does not charge one expensive paint to the cheap frame behind it", () => {
		const { tui, probe, scheduler } = drive();
		try {
			// Settle the estimate on a cheap session, then scroll: one full
			// paint at three times the cadence among frames that cost nothing.
			for (let i = 0; i < 8; i++) frame(tui, probe, scheduler, 1);
			frame(tui, probe, scheduler, 100);

			// This is the frame the operator sees held. Reading the previous
			// sample put a 200ms floor here; the estimate puts the frame back
			// on the cadence, and the spike costs it under a third of itself.
			const afterSpike = frame(tui, probe, scheduler, 1);
			expect(afterSpike).toBeLessThanOrEqual(MIN_RENDER_INTERVAL_MS * 2);
			expect(afterSpike).toBeLessThan(100);

			// And the estimate walks back down rather than holding the session
			// slow: three cheap frames later the cadence is untouched again.
			for (let i = 0; i < 3; i++) frame(tui, probe, scheduler, 1);
			expect(frame(tui, probe, scheduler, 1)).toBeLessThanOrEqual(MIN_RENDER_INTERVAL_MS + 1);
		} finally {
			tui.stop();
		}
	});

	it("holds a sustained slow loop to a duty cycle instead of busy-looping (#4145)", () => {
		const { tui, probe, scheduler } = drive();
		try {
			const slowFrameCostMs = 100;
			const delays: number[] = [];
			for (let i = 0; i < 12; i++) delays.push(frame(tui, probe, scheduler, slowFrameCostMs));

			// What #4145 asked for is a duty cycle, so that is what is asserted:
			// once the estimate has absorbed the loop, the share of the wall
			// clock spent painting settles at half. The estimate approaches the
			// frame cost from below and never reaches it, so the floor lands
			// just under twice the cost and the duty cycle just over a half.
			for (const delay of delays.slice(-4)) {
				const duty = slowFrameCostMs / (slowFrameCostMs + delay);
				expect(duty).toBeLessThan(0.55);
			}

			// Absorbing the loop takes a moment, and during it the floor is
			// still under the frame cost, so some frames do fire back to back.
			// That window is bounded and pinned exactly rather than counted:
			// the floor clears the cost once `2 * (1 - 0.7^k) > 1`, which is
			// the third slow frame, so exactly one frame runs with no gap.
			const backToBack = delays.flatMap((delay, index) => (delay === 0 ? [index] : []));
			expect(backToBack).toEqual([1]);

			// Across the whole run, including that window, the loop still
			// spends under two thirds of the wall clock painting.
			const painted = slowFrameCostMs * delays.length;
			const idled = delays.reduce((sum, delay) => sum + delay, 0);
			expect(painted / (painted + idled)).toBeLessThan(0.65);

			// Convergence is bounded, not eventual: seven frames is the
			// smoothing weight's settling time, a quarter second at 30 fps.
			const settlingFrames = delays.findIndex(delay => delay >= slowFrameCostMs / 2);
			expect(settlingFrames).toBeGreaterThanOrEqual(0);
			expect(settlingFrames).toBeLessThanOrEqual(7);
		} finally {
			tui.stop();
		}
	});

	it("caps the adaptive delay so a pathological frame doesn't stall the UI", () => {
		const { tui, probe, scheduler } = drive();
		try {
			// A 5-second frame. Even a third of it is far past the cap, so the
			// follow-up delay is bounded on the first frame after the spike and
			// stays bounded while the loop keeps costing that much.
			frame(tui, probe, scheduler, 5_000);
			expect(frame(tui, probe, scheduler, 1)).toBeLessThanOrEqual(MAX_ADAPTIVE_RENDER_MS);
			for (let i = 0; i < 5; i++) {
				expect(frame(tui, probe, scheduler, 5_000)).toBeLessThanOrEqual(MAX_ADAPTIVE_RENDER_MS);
			}
		} finally {
			tui.stop();
		}
	});

	it("moves the floor by the smoothing weight, not by the whole sample", () => {
		const { tui, probe, scheduler } = drive();
		try {
			for (let i = 0; i < 8; i++) frame(tui, probe, scheduler, 1);
			const spikeMs = 100;
			frame(tui, probe, scheduler, spikeMs);

			// The frame right after a spike is never held by the adaptive floor
			// at all, and that is arithmetic rather than luck: the floor is
			// twice a weighted fraction of the spike, the weight is below a
			// half, and the spike itself has already elapsed. This is the frame
			// the previous design delayed for twice the spike.
			expect(2 * FRAME_COST_SMOOTHING).toBeLessThan(1);
			expect(frame(tui, probe, scheduler, 1)).toBe(0);

			// The floor the spike did raise shows up on the frame after that,
			// where the clock is no longer ahead of it. It sits near twice the
			// weighted spike and nowhere near twice the spike, and it is a band
			// because a settled cheap estimate is not exactly zero.
			const expectedFloor = 2 * spikeMs * FRAME_COST_SMOOTHING * (1 - FRAME_COST_SMOOTHING);
			const delay = frame(tui, probe, scheduler, 1);
			expect(delay).toBeGreaterThan(expectedFloor * 0.9);
			expect(delay).toBeLessThan(expectedFloor * 1.15);
			expect(delay).toBeLessThan(spikeMs);
		} finally {
			tui.stop();
		}
	});
});
