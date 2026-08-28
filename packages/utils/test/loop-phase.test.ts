import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { currentLoopPhase, popLoopPhase, pushLoopPhase, takeLoopPhaseProfile } from "@veyyon/utils";

/**
 * Contract: the loop-phase breadcrumb is a LIFO string stack. `currentLoopPhase()`
 * reports the most recently pushed, still-unpopped label and `undefined` once the
 * stack drains. The watchdog reads this to name the work that blocked the loop, so
 * the ordering and empty-state behavior are the externally observable guarantee.
 *
 * The stack is a process-global; drain it around each case so a leaked phase from
 * this or any other suite cannot poison an assertion or leak outward.
 */
function drain(): void {
	while (currentLoopPhase() !== undefined) popLoopPhase();
	takeLoopPhaseProfile(); // clear the consume-on-read accounting between cases
}

beforeEach(drain);
afterEach(drain);

describe("loop phase stack", () => {
	test("currentLoopPhase() is undefined on an empty stack", () => {
		expect(currentLoopPhase()).toBeUndefined();
	});

	test("push/pop expose the top label in strict LIFO order through nested phases", () => {
		pushLoopPhase("render");
		expect(currentLoopPhase()).toBe("render");

		pushLoopPhase("layout");
		expect(currentLoopPhase()).toBe("layout");

		pushLoopPhase("paint");
		expect(currentLoopPhase()).toBe("paint");

		// Unwinding reveals each enclosing phase in reverse insertion order.
		popLoopPhase();
		expect(currentLoopPhase()).toBe("layout");

		popLoopPhase();
		expect(currentLoopPhase()).toBe("render");

		popLoopPhase();
		expect(currentLoopPhase()).toBeUndefined();
	});

	test("popping an already-empty stack stays undefined without underflow", () => {
		// Unbalanced pops (error paths popping more than they pushed) must not throw
		// or wrap around to a stale label.
		popLoopPhase();
		popLoopPhase();
		expect(currentLoopPhase()).toBeUndefined();

		// And the stack is still usable afterward.
		pushLoopPhase("after-underflow");
		expect(currentLoopPhase()).toBe("after-underflow");
	});

	test("takeLoopPhaseProfile surfaces a popped phase once, then clears it", () => {
		// A synchronous hot path pushes then pops its phase entirely before the
		// watchdog's delayed tick runs, so the live stack is empty by then.
		pushLoopPhase("ui.select-filter");
		popLoopPhase();
		expect(currentLoopPhase()).toBeUndefined();

		// The banked cost still names the just-finished phase for that one read,
		// then is consumed so a later phase-less block is not blamed on it.
		expect(takeLoopPhaseProfile().phase).toBe("ui.select-filter");
		expect(takeLoopPhaseProfile().phase).toBeUndefined();
	});

	test("takeLoopPhaseProfile charges a still-held phase for the time it has been open", () => {
		pushLoopPhase("outer"); // stays held across the inner phase
		pushLoopPhase("inner");
		popLoopPhase(); // inner done; outer still live

		// A live phase wins: the block is still inside it, and its cost covers the
		// inner one it encloses.
		const profile = takeLoopPhaseProfile();
		expect(profile.phase).toBe("outer");
		expect(profile.ms).toBeGreaterThanOrEqual(0);
		popLoopPhase();
	});

	/**
	 * THE DEFECT THIS CLOSES: a label alone was reported as the cause of a block.
	 * Four spans in the product push a phase, so the last one before any block is
	 * nearly always the render pass — and hundreds of logged blocks of 250-650ms
	 * were attributed to a pass that benchmarks at 0.03ms streaming and 12ms for a
	 * cold 2000-block paint. The cost is what separates a cause from a breadcrumb.
	 */
	test("a phase reports the synchronous time it actually spent", () => {
		const spin = (ms: number): void => {
			const until = performance.now() + ms;
			while (performance.now() < until) {
				// Busy-wait: the point is to hold the loop, which is what the watchdog measures.
			}
		};
		pushLoopPhase("cheap");
		popLoopPhase();
		pushLoopPhase("expensive");
		spin(12);
		popLoopPhase();

		// The costliest label wins, not the most recent one.
		const profile = takeLoopPhaseProfile();
		expect(profile.phase).toBe("expensive");
		expect(profile.ms).toBeGreaterThanOrEqual(10);
	});

	test("one interval's cost is never billed to the next", () => {
		pushLoopPhase("first");
		popLoopPhase();
		expect(takeLoopPhaseProfile().phase).toBe("first");

		// Nothing ran since, so there is nothing to report and no carried-over cost.
		const second = takeLoopPhaseProfile();
		expect(second.phase).toBeUndefined();
		expect(second.ms).toBe(0);
	});
});
