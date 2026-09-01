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
 * `retainedTokenCost`, which had the same history and used to be tested here,
 * moved to `cost-model.ts` when the second ceiling script turned out to have its
 * own copy of it; its tests moved with it rather than being left pointing at a
 * re-export.
 */

import { describe, expect, test } from "bun:test";
import { encodeGreedy } from "./context-encode-ceiling";

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
