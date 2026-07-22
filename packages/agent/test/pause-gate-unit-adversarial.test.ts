import { afterEach, describe, expect, it } from "bun:test";
import { AgentPauseGate } from "@veyyon/agent-core";

/**
 * AgentPauseGate unit contracts without spinning a full agent loop:
 * engage/re-engage, resume duration, listener notify, abort-during-wait.
 */

describe("AgentPauseGate unit adversarial", () => {
	let gate: AgentPauseGate;

	afterEach(() => {
		gate?.resume();
	});

	it("pause returns true once then false while still engaged", () => {
		gate = new AgentPauseGate();
		expect(gate.paused).toBe(false);
		expect(gate.pause()).toBe(true);
		expect(gate.paused).toBe(true);
		expect(gate.pause()).toBe(false);
		expect(gate.paused).toBe(true);
	});

	it("resume returns undefined when not paused and a duration when paused", async () => {
		gate = new AgentPauseGate();
		expect(gate.resume()).toBeUndefined();
		gate.pause();
		await Bun.sleep(5);
		const ms = gate.resume();
		expect(typeof ms).toBe("number");
		expect(ms!).toBeGreaterThanOrEqual(0);
		expect(gate.paused).toBe(false);
	});

	it("onChange fires true then false across pause/resume", () => {
		gate = new AgentPauseGate();
		const seen: boolean[] = [];
		const unsub = gate.onChange(p => {
			seen.push(p);
		});
		gate.pause();
		gate.resume();
		expect(seen).toEqual([true, false]);
		unsub();
		gate.pause();
		gate.resume();
		// Unsubscribed: no further notifications.
		expect(seen).toEqual([true, false]);
	});

	it("waitUntilResumed resolves immediately when not paused", async () => {
		gate = new AgentPauseGate();
		const start = performance.now();
		await gate.waitUntilResumed();
		expect(performance.now() - start).toBeLessThan(50);
	});

	it("waitUntilResumed parks until resume", async () => {
		gate = new AgentPauseGate();
		gate.pause();
		let released = false;
		const pending = gate.waitUntilResumed().then(() => {
			released = true;
		});
		await Bun.sleep(10);
		expect(released).toBe(false);
		gate.resume();
		await pending;
		expect(released).toBe(true);
	});

	it("waitUntilResumed with aborted signal returns without resuming the gate", async () => {
		gate = new AgentPauseGate();
		gate.pause();
		const ac = new AbortController();
		ac.abort();
		await gate.waitUntilResumed(ac.signal);
		// Gate remains engaged for other waiters.
		expect(gate.paused).toBe(true);
		gate.resume();
	});

	it("pausedAt is set while paused and cleared after resume", () => {
		gate = new AgentPauseGate();
		expect(gate.pausedAt).toBeUndefined();
		gate.pause();
		expect(typeof gate.pausedAt).toBe("number");
		expect(gate.pausedAt!).toBeGreaterThan(0);
		gate.resume();
		expect(gate.pausedAt).toBeUndefined();
	});

	it("listener errors do not break pause/resume", () => {
		gate = new AgentPauseGate();
		gate.onChange(() => {
			throw new Error("hostile listener");
		});
		expect(() => gate.pause()).not.toThrow();
		expect(gate.paused).toBe(true);
		expect(() => gate.resume()).not.toThrow();
		expect(gate.paused).toBe(false);
	});
});
