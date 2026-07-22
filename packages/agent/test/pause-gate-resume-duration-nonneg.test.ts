/**
 * AgentPauseGate resume duration is non-negative and undefined when not paused.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { AgentPauseGate } from "../src/pause";

describe("AgentPauseGate resume duration", () => {
	let gate: AgentPauseGate;
	afterEach(() => {
		gate?.resume();
	});

	it("undefined when not paused", () => {
		gate = new AgentPauseGate();
		expect(gate.resume()).toBeUndefined();
	});

	it("non-negative after pause", async () => {
		gate = new AgentPauseGate();
		gate.pause();
		await Bun.sleep(3);
		const ms = gate.resume();
		expect(typeof ms).toBe("number");
		expect(ms!).toBeGreaterThanOrEqual(0);
	});

	it("second resume undefined", () => {
		gate = new AgentPauseGate();
		gate.pause();
		gate.resume();
		expect(gate.resume()).toBeUndefined();
	});
});
