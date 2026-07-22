/**
 * AgentPauseGate: multiple listeners, unsubscribe isolation.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { AgentPauseGate } from "../src/pause";

describe("AgentPauseGate listeners", () => {
	let gate: AgentPauseGate;
	afterEach(() => {
		gate?.resume();
	});

	it("all listeners see the same transition sequence", () => {
		gate = new AgentPauseGate();
		const a: boolean[] = [];
		const b: boolean[] = [];
		gate.onChange(p => a.push(p));
		gate.onChange(p => b.push(p));
		gate.pause();
		gate.resume();
		expect(a).toEqual([true, false]);
		expect(b).toEqual([true, false]);
	});

	it("unsub one leaves the other active", () => {
		gate = new AgentPauseGate();
		const a: boolean[] = [];
		const b: boolean[] = [];
		const unsubA = gate.onChange(p => a.push(p));
		gate.onChange(p => b.push(p));
		unsubA();
		gate.pause();
		gate.resume();
		expect(a).toEqual([]);
		expect(b).toEqual([true, false]);
	});

	it("pause false when already paused does not re-notify", () => {
		gate = new AgentPauseGate();
		const seen: boolean[] = [];
		gate.onChange(p => seen.push(p));
		expect(gate.pause()).toBe(true);
		expect(gate.pause()).toBe(false);
		expect(seen).toEqual([true]);
	});
});
