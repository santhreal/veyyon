/**
 * pause returns false when already paused; paused stays true.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { AgentPauseGate } from "../src/pause";

describe("AgentPauseGate pause while paused", () => {
	let gate: AgentPauseGate;
	afterEach(() => {
		gate?.resume();
	});

	it("second pause is false", () => {
		gate = new AgentPauseGate();
		expect(gate.pause()).toBe(true);
		expect(gate.pause()).toBe(false);
		expect(gate.pause()).toBe(false);
		expect(gate.paused).toBe(true);
	});
});
