/**
 * WHY THIS SUITE EXISTS. `TurnsInFlight` counts the prompt and wake turns a session runs at once, and
 * `end()` answering `true` is what makes the session run its settle work. A wake turn can start while a
 * prompt is still running, so a count that settled on the first `end()` would run settle work under a
 * turn still in flight, and a count that went below zero after a stray `end()` would report the next
 * turn as idle before it finished.
 *
 * THE CLASS. Every transition of the count: a nested begin, an end that leaves a turn running, the
 * end that reaches zero, `end(true)` from any depth, and an end with nothing in flight.
 *
 * WHAT IT DOES NOT CATCH. The macOS power assertion: it is taken only on darwin outside the test
 * runtime, so this suite observes the count and nothing the assertion does.
 */
import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { TurnsInFlight } from "@veyyon/coding-agent/session/runtime/turns-in-flight";

function turns(): TurnsInFlight {
	return new TurnsInFlight(Settings.isolated());
}

describe("a session is idle only when every turn it began has ended", () => {
	it("starts idle", () => {
		expect(turns().active).toBe(false);
	});

	it("stays active until the last of two overlapping turns ends", () => {
		const inFlight = turns();
		inFlight.begin();
		inFlight.begin();

		expect(inFlight.end()).toBe(false);
		expect(inFlight.active).toBe(true);
		expect(inFlight.end()).toBe(true);
		expect(inFlight.active).toBe(false);
	});

	it("ends every turn at once when asked to", () => {
		const inFlight = turns();
		inFlight.begin();
		inFlight.begin();
		inFlight.begin();

		expect(inFlight.end(true)).toBe(true);
		expect(inFlight.active).toBe(false);
	});

	it("does not count below zero, so the turn after a stray end still runs to its own end", () => {
		const inFlight = turns();
		expect(inFlight.end()).toBe(true);

		inFlight.begin();
		expect(inFlight.active).toBe(true);
		expect(inFlight.end()).toBe(true);
		expect(inFlight.active).toBe(false);
	});
});
