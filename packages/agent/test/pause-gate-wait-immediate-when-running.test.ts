/**
 * waitUntilResumed resolves quickly when gate is not paused.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { AgentPauseGate } from "../src/pause";

describe("AgentPauseGate waitUntilResumed immediate", () => {
	let gate: AgentPauseGate;
	afterEach(() => {
		gate?.resume();
	});

	it("resolves under 50ms when not paused", async () => {
		gate = new AgentPauseGate();
		const t0 = performance.now();
		await gate.waitUntilResumed();
		expect(performance.now() - t0).toBeLessThan(50);
	});

	it("resolves under 50ms after resume", async () => {
		gate = new AgentPauseGate();
		gate.pause();
		gate.resume();
		const t0 = performance.now();
		await gate.waitUntilResumed();
		expect(performance.now() - t0).toBeLessThan(50);
	});
});
