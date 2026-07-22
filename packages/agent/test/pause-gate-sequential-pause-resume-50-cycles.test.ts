/**
 * AgentPauseGate: 50 pause/resume cycles; paused getter and waitUntilResumed.
 * Why: mid-run pause must not leak stuck waiters across rapid toggles.
 */
import { describe, expect, it } from "bun:test";
import { AgentPauseGate } from "@veyyon/agent-core/pause";

describe("pause gate sequential pause resume 50 cycles", () => {
	it("50 cycles settle", async () => {
		const g = new AgentPauseGate();
		expect(g.paused).toBe(false);
		for (let i = 0; i < 50; i++) {
			g.pause();
			expect(g.paused).toBe(true);
			const p = g.waitUntilResumed();
			g.resume();
			await p;
			expect(g.paused).toBe(false);
		}
	});

	it("wait while not paused resolves immediately", async () => {
		const g = new AgentPauseGate();
		await g.waitUntilResumed();
		expect(g.paused).toBe(false);
	});
});
