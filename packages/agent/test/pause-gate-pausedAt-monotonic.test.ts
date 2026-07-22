/**
 * AgentPauseGate pausedAt is set on pause and advances across re-pauses.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { AgentPauseGate } from "../src/pause";

describe("AgentPauseGate pausedAt", () => {
	let gate: AgentPauseGate;
	afterEach(() => {
		gate?.resume();
	});

	it("pausedAt undefined when not paused", () => {
		gate = new AgentPauseGate();
		expect(gate.pausedAt).toBeUndefined();
	});

	it("pausedAt within [before, after] window of pause()", async () => {
		gate = new AgentPauseGate();
		const before = Date.now();
		gate.pause();
		const at = gate.pausedAt!;
		const after = Date.now();
		expect(at).toBeGreaterThanOrEqual(before);
		expect(at).toBeLessThanOrEqual(after);
		await Bun.sleep(5);
		// stays same while paused
		expect(gate.pausedAt).toBe(at);
		gate.resume();
		expect(gate.pausedAt).toBeUndefined();
	});

	it("second pause after resume gets a new pausedAt >= first", async () => {
		gate = new AgentPauseGate();
		gate.pause();
		const first = gate.pausedAt!;
		gate.resume();
		await Bun.sleep(5);
		gate.pause();
		const second = gate.pausedAt!;
		expect(second).toBeGreaterThanOrEqual(first);
	});
});
