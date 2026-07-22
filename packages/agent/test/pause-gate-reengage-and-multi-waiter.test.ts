/**
 * AgentPauseGate: multi-waiter wake, re-engage during wait, listener isolation,
 * pausedAt lifecycle. Complements pause-gate-unit-adversarial without agent loop.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { AgentPauseGate } from "../src/pause";

describe("AgentPauseGate multi-waiter and re-engage", () => {
	let gate: AgentPauseGate;

	afterEach(() => {
		gate?.resume();
	});

	it("resume wakes every concurrent waiter", async () => {
		gate = new AgentPauseGate();
		gate.pause();
		const flags = [false, false, false];
		const waits = flags.map((_, i) =>
			gate.waitUntilResumed().then(() => {
				flags[i] = true;
			}),
		);
		await Bun.sleep(5);
		expect(flags.every(f => !f)).toBe(true);
		gate.resume();
		await Promise.all(waits);
		expect(flags.every(f => f)).toBe(true);
	});

	it("pause after resume parks new waiters again", async () => {
		gate = new AgentPauseGate();
		gate.pause();
		gate.resume();
		gate.pause();
		let released = false;
		const p = gate.waitUntilResumed().then(() => {
			released = true;
		});
		await Bun.sleep(5);
		expect(released).toBe(false);
		gate.resume();
		await p;
		expect(released).toBe(true);
	});

	it("pausedAt is set while paused and cleared after resume", () => {
		gate = new AgentPauseGate();
		expect(gate.pausedAt).toBeUndefined();
		const before = Date.now();
		gate.pause();
		expect(gate.pausedAt).toBeGreaterThanOrEqual(before);
		expect(gate.pausedAt).toBeLessThanOrEqual(Date.now());
		gate.resume();
		expect(gate.pausedAt).toBeUndefined();
	});

	it("listener that throws does not break gate or other listeners", () => {
		gate = new AgentPauseGate();
		const seen: boolean[] = [];
		gate.onChange(() => {
			throw new Error("listener boom");
		});
		gate.onChange(p => seen.push(p));
		expect(() => gate.pause()).not.toThrow();
		expect(gate.paused).toBe(true);
		expect(() => gate.resume()).not.toThrow();
		expect(seen).toEqual([true, false]);
	});

	it("abort mid-wait releases only that waiter; others stay parked", async () => {
		gate = new AgentPauseGate();
		gate.pause();
		const ac = new AbortController();
		let abortedDone = false;
		let otherDone = false;
		const aborted = gate.waitUntilResumed(ac.signal).then(() => {
			abortedDone = true;
		});
		const other = gate.waitUntilResumed().then(() => {
			otherDone = true;
		});
		await Bun.sleep(5);
		ac.abort();
		await aborted;
		expect(abortedDone).toBe(true);
		expect(otherDone).toBe(false);
		expect(gate.paused).toBe(true);
		gate.resume();
		await other;
		expect(otherDone).toBe(true);
	});

	it("double resume after single pause: second returns undefined", () => {
		gate = new AgentPauseGate();
		gate.pause();
		expect(typeof gate.resume()).toBe("number");
		expect(gate.resume()).toBeUndefined();
	});

	it("sequential waitUntilResumed calls each observe current gate state", async () => {
		gate = new AgentPauseGate();
		// Not paused: both waits resolve immediately.
		await gate.waitUntilResumed();
		await gate.waitUntilResumed();
		gate.pause();
		let secondReleased = false;
		const second = gate.waitUntilResumed().then(() => {
			secondReleased = true;
		});
		await Bun.sleep(5);
		expect(secondReleased).toBe(false);
		const ms = gate.resume();
		expect(typeof ms).toBe("number");
		await second;
		expect(secondReleased).toBe(true);
	});
});

