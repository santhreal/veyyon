/**
 * AgentPauseGate onChange: listener fires true on pause, false on resume; unsubscribe stops.
 */
import { describe, expect, it } from "bun:test";
import { AgentPauseGate } from "@veyyon/agent-core/pause";

describe("AgentPauseGate listener fire count matrix", () => {
	it("listener receives pause then resume", () => {
		const g = new AgentPauseGate();
		const events: boolean[] = [];
		g.onChange(p => events.push(p));
		g.pause();
		g.resume();
		expect(events).toEqual([true, false]);
	});

	it("unsubscribe prevents further events", () => {
		const g = new AgentPauseGate();
		const events: boolean[] = [];
		const unsub = g.onChange(p => events.push(p));
		g.pause();
		unsub();
		g.resume();
		g.pause();
		expect(events).toEqual([true]);
	});

	it("two listeners both fire", () => {
		const g = new AgentPauseGate();
		const a: boolean[] = [];
		const b: boolean[] = [];
		g.onChange(p => a.push(p));
		g.onChange(p => b.push(p));
		g.pause();
		g.resume();
		expect(a).toEqual([true, false]);
		expect(b).toEqual([true, false]);
	});

	for (let n = 1; n <= 10; n++) {
		it(`${n} pause/resume cycles`, () => {
			const g = new AgentPauseGate();
			const events: boolean[] = [];
			g.onChange(p => events.push(p));
			for (let i = 0; i < n; i++) {
				g.pause();
				g.resume();
			}
			expect(events).toHaveLength(n * 2);
			for (let i = 0; i < n; i++) {
				expect(events[i * 2]).toBe(true);
				expect(events[i * 2 + 1]).toBe(false);
			}
		});
	}
});
