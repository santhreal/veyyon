import { describe, expect, it } from "bun:test";
import { AgentPauseGate } from "../src/pause";

describe("AgentPauseGate", () => {
	it("starts unpaused", () => {
		const gate = new AgentPauseGate();
		expect(gate.paused).toBe(false);
		expect(gate.pausedAt).toBeUndefined();
	});
	it("pause() sets paused state", () => {
		const gate = new AgentPauseGate();
		expect(gate.pause()).toBe(true);
		expect(gate.paused).toBe(true);
		expect(gate.pausedAt).toBeDefined();
	});
	it("pause() returns false when already paused", () => {
		const gate = new AgentPauseGate();
		gate.pause();
		expect(gate.pause()).toBe(false);
	});
	it("resume() clears paused state and returns duration", () => {
		const gate = new AgentPauseGate();
		gate.pause();
		const duration = gate.resume();
		expect(gate.paused).toBe(false);
		expect(typeof duration).toBe("number");
		expect(duration).toBeGreaterThanOrEqual(0);
	});
	it("resume() returns undefined when not paused", () => {
		const gate = new AgentPauseGate();
		expect(gate.resume()).toBeUndefined();
	});
	it("onChange listener receives pause notification", () => {
		const gate = new AgentPauseGate();
		const events: boolean[] = [];
		gate.onChange(paused => events.push(paused));
		gate.pause();
		expect(events).toEqual([true]);
	});
	it("onChange listener receives resume notification", () => {
		const gate = new AgentPauseGate();
		const events: boolean[] = [];
		gate.onChange(paused => events.push(paused));
		gate.pause();
		gate.resume();
		expect(events).toEqual([true, false]);
	});
	it("onChange returns unsubscribe function", () => {
		const gate = new AgentPauseGate();
		const events: boolean[] = [];
		const unsub = gate.onChange(paused => events.push(paused));
		gate.pause();
		unsub();
		gate.resume();
		expect(events).toEqual([true]);
	});
	it("waitUntilResumed resolves immediately when not paused", async () => {
		const gate = new AgentPauseGate();
		await gate.waitUntilResumed();
	});
	it("waitUntilResumed resolves after resume", async () => {
		const gate = new AgentPauseGate();
		gate.pause();
		const promise = gate.waitUntilResumed();
		gate.resume();
		await promise;
	});
	it("waitUntilResumed throws on aborted signal when paused", async () => {
		const gate = new AgentPauseGate();
		gate.pause();
		const controller = new AbortController();
		controller.abort();
		await expect(gate.waitUntilResumed(controller.signal)).rejects.toThrow();
	});
	it("waitUntilResumed throws on aborted signal when not paused", async () => {
		const gate = new AgentPauseGate();
		const controller = new AbortController();
		controller.abort();
		await expect(gate.waitUntilResumed(controller.signal)).rejects.toThrow();
	});
	it("multiple listeners all receive notifications", () => {
		const gate = new AgentPauseGate();
		const events1: boolean[] = [];
		const events2: boolean[] = [];
		gate.onChange(p => events1.push(p));
		gate.onChange(p => events2.push(p));
		gate.pause();
		expect(events1).toEqual([true]);
		expect(events2).toEqual([true]);
	});
	it("listener that throws does not prevent other listeners", () => {
		const gate = new AgentPauseGate();
		const events: boolean[] = [];
		gate.onChange(() => {
			throw new Error("listener error");
		});
		gate.onChange(p => events.push(p));
		gate.pause();
		expect(events).toEqual([true]);
	});
	it("pause and resume cycle works multiple times", () => {
		const gate = new AgentPauseGate();
		gate.pause();
		gate.resume();
		gate.pause();
		expect(gate.paused).toBe(true);
		gate.resume();
		expect(gate.paused).toBe(false);
	});
});
