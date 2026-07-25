/**
 * The two pieces of the context-encoding measurement that have been wrong
 * before, pinned.
 *
 * WHY THIS SUITE EXISTS. Both of these functions replace an earlier estimate
 * that was wrong by a large factor and steered real work in the wrong
 * direction.
 *
 * `encodeGreedy` replaces a counter that tallied every handle whose expansion
 * appeared anywhere in the text. Overlapping matches cannot both be emitted, so
 * counting them separately reported a compression ceiling about fifty times
 * higher than anything achievable, and that inflated ceiling was used to
 * justify continuing.
 *
 * `retainedTokenCost` replaces charging a token once. Context is re-read on
 * every later turn, so a token's real price depends on when it enters the
 * session. Charging the dictionary once made a dictionary that loses money look
 * like it saved it.
 */

import { describe, expect, test } from "bun:test";
import { encodeGreedy, retainedTokenCost } from "./context-encode-ceiling";
import { REFERENCE_RATE_CARD } from "./cost-model";

describe("encodeGreedy", () => {
	/**
	 * The exact bug: two handles whose expansions overlap in the text. Only one
	 * can be emitted. The old counter scored both and doubled the apparent
	 * saving; this must consume the region once.
	 */
	test("emits only one handle when two expansions overlap", () => {
		const encoded = encodeGreedy("abcd", [
			["§x", "abc"],
			["§y", "bcd"],
		]);
		expect(encoded).toBe("§xd");
	});

	/**
	 * Longest-first is what makes the greedy pass worth anything: preferring the
	 * short match would leave the long one unusable and understate the saving.
	 */
	test("prefers the longer expansion at the same position", () => {
		const encoded = encodeGreedy("abcdef", [
			["§s", "abc"],
			["§l", "abcdef"],
		]);
		expect(encoded).toBe("§l");
	});

	/** Every occurrence is replaced, not just the first. */
	test("replaces every occurrence, not only the first", () => {
		expect(encodeGreedy("go go go", [["§g", "go"]])).toBe("§g §g §g");
	});

	/** Text with no match is returned byte for byte, so a useless dictionary scores zero rather than corrupting the corpus. */
	test("returns the input unchanged when nothing matches", () => {
		expect(encodeGreedy("nothing here", [["§q", "absent"]])).toBe("nothing here");
	});

	/**
	 * An empty expansion must never match. Left unguarded it matches at every
	 * position, so the encoder would emit a handle per character, loop forever or
	 * balloon the text, and report a nonsense (negative) saving.
	 */
	test("ignores an empty expansion instead of matching everywhere", () => {
		expect(encodeGreedy("abc", [["§e", ""]])).toBe("abc");
	});

	/** An empty dictionary is a no-op, which is the zero-budget baseline the sweep starts from. */
	test("is a no-op for an empty dictionary", () => {
		expect(encodeGreedy("abc", [])).toBe("abc");
	});
});

describe("retainedTokenCost", () => {
	/**
	 * A token entering on the final turn is never re-read, so it costs exactly
	 * fresh input and nothing more. This is the boundary the reread arithmetic
	 * gets wrong by one if `totalTurns - turn` is used instead of minus one.
	 */
	test("charges a last-turn token as fresh input only", () => {
		expect(retainedTokenCost(9, 10)).toBeCloseTo(REFERENCE_RATE_CARD.input / 1_000_000, 15);
	});

	/**
	 * The finding that reframed the whole effort, as arithmetic: a token entering
	 * at turn 0 of a 66-turn session is billed once as input and 65 times as
	 * cache read, roughly seventeen times its face value. This is why context
	 * size dominates the bill and why the dictionary, which sits in the prompt
	 * from turn 0, is the most expensive place to put anything.
	 */
	test("charges a turn-0 token of a 66-turn session at ~17x face value", () => {
		const unit = retainedTokenCost(0, 66);
		const face = REFERENCE_RATE_CARD.input / 1_000_000;
		expect(unit / face).toBeCloseTo(17.25, 2);
	});

	/** Cost falls monotonically the later a token enters, which is what makes late context cheaper than early context. */
	test("falls monotonically as a token enters later", () => {
		const costs = [0, 10, 20, 30].map(turn => retainedTokenCost(turn, 40));
		for (let i = 1; i < costs.length; i++) expect(costs[i]).toBeLessThan(costs[i - 1]);
	});

	/** A turn index past the end cannot produce a negative reread count and a negative price. */
	test("never returns less than the fresh-input price", () => {
		expect(retainedTokenCost(99, 10)).toBeCloseTo(REFERENCE_RATE_CARD.input / 1_000_000, 15);
	});
});
