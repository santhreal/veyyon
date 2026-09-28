import { afterEach, describe, expect, it, vi } from "bun:test";
import { ExponentialYield, YieldGate } from "@veyyon/agent-core/utils/yield";

const YIELD_INTERVAL_MS = 50;

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * WHY: the shared gate sat in front of every streamed event, every turn start
 * and every tool batch, and slept 20 ms whenever 50 ms had passed since its
 * last sleep. A stream whose events arrive more than 50 ms apart — a model
 * pausing, a slow provider, the first token of a reply — therefore held every
 * such event 20 ms before any view saw it, although the loop had been idle in
 * I/O the whole time. The class closed here: the gate sleeps only for a run of
 * calls the event loop did not turn between, and never for a caller that
 * already awaited I/O. Not caught: a caller that bypasses the gate, or a hot
 * loop that turns the event loop on every iteration but still starves it.
 *
 * The gate runs over an injected clock, a counting sleep and a manual turn
 * signal, so no test spies on process-global `performance.now`,
 * `scheduler.wait` or `setImmediate`: a sibling file's `vi.restoreAllMocks()`
 * could wipe those spies mid-run under concurrent `bun test`.
 */
function makeGate(): { gate: YieldGate; advanceBy: (ms: number) => void; turn: () => void; sleeps: () => number } {
	let now = 1_000_000;
	let pending: (() => void) | undefined;
	const sleep = vi.fn(async () => {});
	const gate = new YieldGate({
		now: () => now,
		sleep,
		onTurn: callback => {
			pending = callback;
		},
	});
	return {
		gate,
		advanceBy: (ms: number) => {
			now += ms;
		},
		turn: () => {
			const callback = pending;
			pending = undefined;
			callback?.();
		},
		sleeps: () => sleep.mock.calls.length,
	};
}

describe("YieldGate.yieldIfDue", () => {
	it("never sleeps for calls the event loop turned between, however far apart", async () => {
		const { gate, advanceBy, turn, sleeps } = makeGate();

		for (let i = 0; i < 10; i++) {
			await gate.yieldIfDue();
			advanceBy(YIELD_INTERVAL_MS * 5);
			turn();
		}
		expect(sleeps()).toBe(0);
	});

	it("sleeps once a run without a turn reaches the interval, not before", async () => {
		const { gate, advanceBy, sleeps } = makeGate();

		await gate.yieldIfDue();
		advanceBy(YIELD_INTERVAL_MS - 1);
		await gate.yieldIfDue();
		expect(sleeps()).toBe(0);

		advanceBy(1);
		await gate.yieldIfDue();
		expect(sleeps()).toBe(1);
	});

	it("starts a new run after a sleep, so the next sleep needs a full interval", async () => {
		const { gate, advanceBy, sleeps } = makeGate();

		await gate.yieldIfDue();
		advanceBy(YIELD_INTERVAL_MS);
		await gate.yieldIfDue();
		expect(sleeps()).toBe(1);

		await gate.yieldIfDue();
		advanceBy(YIELD_INTERVAL_MS - 1);
		await gate.yieldIfDue();
		expect(sleeps()).toBe(1);

		advanceBy(1);
		await gate.yieldIfDue();
		expect(sleeps()).toBe(2);
	});

	it("a turn in the middle of a run restarts it", async () => {
		const { gate, advanceBy, turn, sleeps } = makeGate();

		await gate.yieldIfDue();
		advanceBy(YIELD_INTERVAL_MS - 1);
		turn();
		await gate.yieldIfDue();
		advanceBy(YIELD_INTERVAL_MS - 1);
		await gate.yieldIfDue();
		expect(sleeps()).toBe(0);
	});

	it("restarts the run on a backward clock and still sleeps one interval later", async () => {
		const { gate, advanceBy, sleeps } = makeGate();

		await gate.yieldIfDue();
		advanceBy(-YIELD_INTERVAL_MS * 4);
		await gate.yieldIfDue();
		expect(sleeps()).toBe(0);

		advanceBy(YIELD_INTERVAL_MS);
		await gate.yieldIfDue();
		expect(sleeps()).toBe(1);
	});

	it("reads a real event-loop turn from the default signal", async () => {
		let now = 1_000_000;
		const sleep = vi.fn(async () => {});
		const gate = new YieldGate({ now: () => now, sleep });

		// The default signal is a real event-loop turn, which fake timers cannot
		// produce; an immediate between calls turns the loop with no delay, as
		// awaiting a socket read does.
		for (let i = 0; i < 4; i++) {
			await gate.yieldIfDue();
			now += YIELD_INTERVAL_MS * 2;
			await new Promise<void>(resolve => setImmediate(resolve));
		}
		expect(sleep.mock.calls.length).toBe(0);

		// Settled promises alone never turn it, as a buffered burst of events
		// does not: calls at 0, 50, 100 and 150 ms sleep at 50 and at 150.
		for (let i = 0; i < 4; i++) {
			await gate.yieldIfDue();
			now += YIELD_INTERVAL_MS;
			await Promise.resolve();
		}
		expect(sleep.mock.calls.length).toBe(2);
	});
});

describe("ExponentialYield.race", () => {
	it("returns the racer's value as soon as it settles", async () => {
		const ey = new ExponentialYield({ minMs: 5_000, maxMs: 10_000 });
		const racer = Bun.sleep(10).then(() => "done");
		const start = performance.now();
		const out = await ey.race([racer]);
		const elapsed = performance.now() - start;
		expect(out).toBe("done");
		// The 5s yield must not have delayed us: settle within a comfy margin.
		expect(elapsed).toBeLessThan(500);
	});

	it("cancels the losing sleep so it does not keep the loop alive", async () => {
		// If the losing Bun.sleep weren't cancelled, this test would block for
		// the full minMs after the racer wins, since the prior implementation
		// kept fresh timers ticking. We pick a minMs far larger than the racer
		// delay and assert we return well before it.
		const ey = new ExponentialYield({ minMs: 2_000, maxMs: 2_000 });
		const racer = Bun.sleep(20).then(() => 42);
		const start = performance.now();
		const out = await ey.race([racer]);
		const elapsed = performance.now() - start;
		expect(out).toBe(42);
		expect(elapsed).toBeLessThan(500);

		// After race resolves, ensure the AbortController-driven cancel really
		// unblocked the underlying timer: a short follow-up sleep should not
		// be perturbed by residual pending timers. (Sanity: this returns.)
		await Bun.sleep(30);
	});
});
