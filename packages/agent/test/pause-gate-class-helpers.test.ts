import { describe, expect, it } from "bun:test";
import { AgentPauseGate } from "../src/pause";

describe("AgentPauseGate", () => {
	it("starts unpaused", () => {
		const gate = new AgentPauseGate();
		expect(gate.paused).toBe(false);
	});
	it("pausedAt is undefined when not paused", () => {
		const gate = new AgentPauseGate();
		expect(gate.pausedAt).toBeUndefined();
	});
	it("pause returns true when not paused", () => {
		const gate = new AgentPauseGate();
		expect(gate.pause()).toBe(true);
	});
	it("pause returns false when already paused", () => {
		const gate = new AgentPauseGate();
		gate.pause();
		expect(gate.pause()).toBe(false);
	});
	it("is paused after pause", () => {
		const gate = new AgentPauseGate();
		gate.pause();
		expect(gate.paused).toBe(true);
	});
	it("pausedAt is set when paused", () => {
		const gate = new AgentPauseGate();
		gate.pause();
		expect(gate.pausedAt).toBeDefined();
		expect(typeof gate.pausedAt).toBe("number");
	});
	it("resume returns undefined when not paused", () => {
		const gate = new AgentPauseGate();
		expect(gate.resume()).toBeUndefined();
	});
	it("resume returns elapsed time when paused", () => {
		const gate = new AgentPauseGate();
		gate.pause();
		const elapsed = gate.resume();
		expect(typeof elapsed).toBe("number");
		expect(elapsed).toBeGreaterThanOrEqual(0);
	});
	it("is not paused after resume", () => {
		const gate = new AgentPauseGate();
		gate.pause();
		gate.resume();
		expect(gate.paused).toBe(false);
	});
	it("pausedAt is undefined after resume", () => {
		const gate = new AgentPauseGate();
		gate.pause();
		gate.resume();
		expect(gate.pausedAt).toBeUndefined();
	});
	it("onChange listener receives true on pause", () => {
		const gate = new AgentPauseGate();
		const events: boolean[] = [];
		gate.onChange(paused => events.push(paused));
		gate.pause();
		expect(events).toEqual([true]);
	});
	it("onChange listener receives false on resume", () => {
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
		unsub();
		gate.pause();
		expect(events).toEqual([]);
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
	it("multiple listeners all receive events", () => {
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
		gate.resume();
		expect(gate.paused).toBe(false);
	});
});
