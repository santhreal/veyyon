/**
 * AgentPauseGate rapid pause/resume: paused flips; waitUntilResumed resolves when running.
 * Why: pause re-entry must not leave waiters hung or duration negative.
 */
import { describe, expect, it } from "bun:test";
import { AgentPauseGate } from "@veyyon/agent-core/pause";

describe("AgentPauseGate rapid toggle matrix", () => {
	it("starts running", () => {
		const g = new AgentPauseGate();
		expect(g.paused).toBe(false);
		expect(g.pausedAt).toBeUndefined();
	});

	it("pause then resume cycle 20 times", () => {
		const g = new AgentPauseGate();
		for (let i = 0; i < 20; i++) {
			const paused = g.pause();
			expect(paused).toBe(true);
			expect(g.paused).toBe(true);
			expect(g.pausedAt).toBeGreaterThan(0);
			// second pause while paused returns false
			expect(g.pause()).toBe(false);
			const d = g.resume();
			expect(g.paused).toBe(false);
			expect(d).toBeGreaterThanOrEqual(0);
			expect(g.pausedAt).toBeUndefined();
		}
	});

	it("waitUntilResumed resolves immediately when running", async () => {
		const g = new AgentPauseGate();
		await Promise.race([
			g.waitUntilResumed(),
			new Promise((_, rej) => setTimeout(() => rej(new Error("wait hung")), 50)),
		]);
	});

	it("waitUntilResumed after pause resolves on resume", async () => {
		const g = new AgentPauseGate();
		g.pause();
		let resolved = false;
		const p = g.waitUntilResumed().then(() => {
			resolved = true;
		});
		expect(resolved).toBe(false);
		g.resume();
		await p;
		expect(resolved).toBe(true);
	});

	it("multiple waiters all resolve on one resume", async () => {
		const g = new AgentPauseGate();
		g.pause();
		const flags = [false, false, false];
		const waits = flags.map((_, i) =>
			g.waitUntilResumed().then(() => {
				flags[i] = true;
			}),
		);
		g.resume();
		await Promise.all(waits);
		expect(flags).toEqual([true, true, true]);
	});

	it("resume when not paused returns undefined", () => {
		const g = new AgentPauseGate();
		expect(g.resume()).toBeUndefined();
	});
});
