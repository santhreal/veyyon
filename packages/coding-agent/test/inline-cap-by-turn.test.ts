/**
 * Pricing a tool result by when it arrives, not just how big it is.
 *
 * WHY THIS SUITE EXISTS. A tool result is billed once as fresh input and then
 * re-read as a cache token on every later turn, so its real cost is its size
 * multiplied by how much session remains. On a measured 66-turn trace a 40k
 * `go test` result arrived at turn 13, was re-read 52 times, and cost about
 * 4.7% of the entire session bill by itself. The same bytes at turn 60 would
 * have cost almost nothing.
 *
 * The flat byte cap cannot see that: it spills a huge late result that was
 * nearly free while keeping a moderate early one that will be billed sixty more
 * times. These tests pin the ordering that fixes it, and the floor that stops
 * the fix from starving the early turns it is squeezing.
 */

import { describe, expect, it } from "bun:test";
import {
	DEFAULT_SESSION_HORIZON_TURNS,
	expectedRereads,
	inlineCapForTurn,
} from "@veyyon/coding-agent/session/streaming-output";

describe("expectedRereads", () => {
	/** A result on turn 0 sits in context for the whole session, which is the expensive case. */
	it("counts the whole horizon for a first-turn result", () => {
		expect(expectedRereads(0, 60)).toBe(60);
	});

	/** Later arrival, fewer re-reads: the monotonic property the cap is built on. */
	it("falls as the result arrives later", () => {
		expect(expectedRereads(30, 60)).toBe(30);
		expect(expectedRereads(59, 60)).toBe(1);
	});

	/**
	 * Past the horizon it clamps to one, never zero. A zero would make the scaled
	 * cap divide by zero and, read literally, would claim a result costs nothing
	 * at all, when every result is read at least on the turn it arrives.
	 */
	it("never returns less than one, even past the horizon", () => {
		expect(expectedRereads(500, 60)).toBe(1);
		expect(expectedRereads(-5, 60)).toBe(60);
	});
});

describe("inlineCapForTurn", () => {
	/**
	 * The behaviour the whole mechanism exists for, stated as an ordering: an
	 * early result gets a TIGHTER inline budget than a late one, so it spills to
	 * an artifact sooner. This is the opposite of what size-only capping does.
	 */
	it("gives an early result a tighter budget than a late one", () => {
		const early = inlineCapForTurn(100_000, 0, 60);
		const late = inlineCapForTurn(100_000, 58, 60);
		expect(early).toBeLessThan(late);
	});

	/**
	 * The floor binds for most of the session, and that is worth asserting rather
	 * than discovering later.
	 *
	 * Equalising total context cost means the budget scales as 1/re-reads, which
	 * is extremely steep: at turn 0 of a 60-turn horizon it is a sixtieth of the
	 * nominal budget. The floor catches all of that, so in practice the mechanism
	 * behaves as a flat 4x tightening across the first ~55 turns and only relaxes
	 * at the very end. The steepness is economically correct (a turn-0 result
	 * really is billed sixty times) but the floor is what makes it shippable, so
	 * the floor is the parameter to tune, not the curve.
	 */
	it("sits at the floor for most of the session, relaxing only near the end", () => {
		expect(inlineCapForTurn(100_000, 0, 60)).toBe(25_000);
		expect(inlineCapForTurn(100_000, 30, 60)).toBe(25_000);
		expect(inlineCapForTurn(100_000, 55, 60)).toBe(25_000);
		expect(inlineCapForTurn(100_000, 58, 60)).toBe(50_000);
	});

	/** A late result gets the full budget: nothing re-reads it, so there is nothing to save. */
	it("gives a result at the horizon the full budget", () => {
		expect(inlineCapForTurn(100_000, 59, 60)).toBe(100_000);
		expect(inlineCapForTurn(100_000, 200, 60)).toBe(100_000);
	});

	/**
	 * The floor. Without it the earliest turns are squeezed toward nothing, which
	 * spills exactly the output an agent needs while it is still orienting. A
	 * spilled result the model then has to fetch costs an extra turn, and an
	 * extra turn is more expensive than the bytes saved.
	 */
	it("never squeezes below the floor fraction", () => {
		expect(inlineCapForTurn(100_000, 0, 60, 0.25)).toBe(25_000);
		expect(inlineCapForTurn(100_000, 0, 60, 0.5)).toBe(50_000);
	});

	/** The budget is never exceeded, so this can only ever tighten a cap, never loosen one. */
	it("never returns more than the configured budget", () => {
		for (const turn of [0, 1, 10, 30, 59, 100]) {
			expect(inlineCapForTurn(100_000, turn, 60)).toBeLessThanOrEqual(100_000);
		}
	});

	/** Monotonic across the whole range: no turn is cheaper to be early on than to be late on. */
	it("is monotonically non-decreasing in turn index", () => {
		let previous = 0;
		for (let turn = 0; turn <= 60; turn++) {
			const cap = inlineCapForTurn(100_000, turn, 60);
			expect(cap).toBeGreaterThanOrEqual(previous);
			previous = cap;
		}
	});

	/**
	 * The default horizon is a measured figure, not a round guess: the DeepSWE
	 * traces ran 66 and 79 turns, and 60 sits conservatively under both so the
	 * mechanism understates rather than overstates how costly early output is.
	 */
	it("defaults to a horizon just under the measured session lengths", () => {
		expect(DEFAULT_SESSION_HORIZON_TURNS).toBe(60);
		expect(inlineCapForTurn(100_000, 0)).toBe(inlineCapForTurn(100_000, 0, 60));
	});
});
