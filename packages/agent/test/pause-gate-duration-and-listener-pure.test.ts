/**
 * AgentPauseGate pure: pause/resume duration non-neg, listener unsubscribe,
 * wait resolves immediately when running.
 */
import { describe, expect, it } from "bun:test";
import { AgentPauseGate } from "@veyyon/agent-core";

describe("AgentPauseGate pure extras", () => {
	it("wait resolves immediately when not paused", async () => {
		const g = new AgentPauseGate();
		const t0 = Date.now();
		await g.waitUntilResumed();
		expect(Date.now() - t0).toBeLessThan(50);
	});

	it("pause then resume reports non-negative duration", async () => {
		const g = new AgentPauseGate();
		expect(g.pause()).toBe(true);
		expect(g.pause()).toBe(false); // already paused
		await new Promise(r => setTimeout(r, 5));
		const d = g.resume();
		expect(d).toBeDefined();
		expect(d!).toBeGreaterThanOrEqual(0);
	});

	it("onChange unsubscribe stops delivery", () => {
		const g = new AgentPauseGate();
		let n = 0;
		const unsub = g.onChange(() => {
			n++;
		});
		g.pause();
		expect(n).toBe(1);
		unsub();
		g.resume();
		g.pause();
		expect(n).toBe(1);
	});
});
