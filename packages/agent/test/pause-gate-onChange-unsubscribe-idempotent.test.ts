/**
 * Unsubscribing twice is safe; no extra notifications after unsub.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { AgentPauseGate } from "../src/pause";

describe("AgentPauseGate unsubscribe idempotent", () => {
	let gate: AgentPauseGate;
	afterEach(() => {
		gate?.resume();
	});

	it("double unsub safe", () => {
		gate = new AgentPauseGate();
		const seen: boolean[] = [];
		const unsub = gate.onChange(p => seen.push(p));
		unsub();
		unsub();
		gate.pause();
		gate.resume();
		expect(seen).toEqual([]);
	});
});
