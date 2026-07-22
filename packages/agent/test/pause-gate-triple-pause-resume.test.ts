/**
 * Three pause/resume cycles leave gate running and listeners correct.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { AgentPauseGate } from "../src/pause";

describe("AgentPauseGate triple pause/resume", () => {
	let gate: AgentPauseGate;
	afterEach(() => {
		gate?.resume();
	});

	it("three cycles", () => {
		gate = new AgentPauseGate();
		const seen: boolean[] = [];
		gate.onChange(p => seen.push(p));
		for (let i = 0; i < 3; i++) {
			expect(gate.pause()).toBe(true);
			expect(gate.paused).toBe(true);
			expect(typeof gate.resume()).toBe("number");
			expect(gate.paused).toBe(false);
		}
		expect(seen).toEqual([true, false, true, false, true, false]);
	});
});
