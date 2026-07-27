/**
 * `firstNonEmpty` exists because `??` and `||` each get half of this wrong.
 *
 * WHY THIS SUITE EXISTS. The operation is "pick the first value that is actually set",
 * and the cases that decide it are the boring ones: an env var exported as `TERM=`, a
 * config field left as `"  "`, a zero. `??` keeps `""` because it is not nullish; `||`
 * drops `""` but also drops `0` and `false`; neither trims. So every hand-rolled
 * version of this gets a different answer on the inputs that actually occur, which is
 * why there is one function rather than an idiom repeated at each call site.
 *
 * It backs the terminal-name lookup in the prompt's workstation block, where a blank
 * `TERM` must fall through to `COLORTERM` rather than winning as an empty string.
 */
import { describe, expect, it } from "bun:test";
import { firstNonEmpty, nonEmptyTrimmed } from "../src/strings";

describe("firstNonEmpty", () => {
	/** The ordinary case: the first set value wins and later ones are not consulted. */
	it("returns the first value that has content", () => {
		expect(firstNonEmpty("first", "second")).toBe("first");
		expect(firstNonEmpty(undefined, "second", "third")).toBe("second");
	});

	/**
	 * The case `??` gets wrong. An empty string is PRESENT but useless, and `a ?? b`
	 * would return it — so `TERM=` exported blank would win over a perfectly good
	 * `COLORTERM`.
	 */
	it("treats an empty string as absent", () => {
		expect(firstNonEmpty("", "second")).toBe("second");
	});

	/**
	 * And whitespace is empty too, which no operator handles. A config field left as
	 * `"  "` is the same fact as one left blank, and a caller that had to remember to
	 * trim first would eventually forget.
	 */
	it("treats whitespace as absent", () => {
		expect(firstNonEmpty("   ", "\t\n", "second")).toBe("second");
	});

	/** `null` and `undefined` are both skipped, since callers get both from different APIs. */
	it("skips null and undefined alike", () => {
		expect(firstNonEmpty(null, undefined, "value")).toBe("value");
	});

	/**
	 * The returned value is trimmed, so a caller cannot receive a string it still has
	 * to clean. Trimming decides emptiness AND shapes the result; doing only the first
	 * would hand back `" xterm "` from an env var with a stray space.
	 */
	it("returns the value trimmed", () => {
		expect(firstNonEmpty("  xterm-256color  ")).toBe("xterm-256color");
		expect(firstNonEmpty(null, "\tvalue\n")).toBe("value");
	});

	/** Nothing set at all is `null`, distinct from the empty string a caller might store. */
	it("returns null when nothing has content", () => {
		expect(firstNonEmpty()).toBeNull();
		expect(firstNonEmpty(undefined, null, "", "   ")).toBeNull();
	});

	/** Content that is only punctuation or a zero digit is content, not emptiness. */
	it("does not confuse falsy-looking text with emptiness", () => {
		expect(firstNonEmpty("0", "second")).toBe("0");
		expect(firstNonEmpty("-", "second")).toBe("-");
	});
});

/**
 * `nonEmptyTrimmed` is `firstNonEmpty` over a whole list, and it has to agree with it.
 *
 * WHY THIS SUITE EXISTS. `gh.ts` wrote this loop twice, 145 lines apart, for a PR
 * identifier list and for search-query fragments, and `autoresearch/helpers.ts` had a
 * third copy with deduplication folded in. Nothing was wrong with any of them, which
 * is exactly why it was worth naming: the next copy is the one that forgets the trim,
 * or decides a whitespace-only entry counts, and then two parts of the product
 * disagree about whether `"  "` is a value.
 *
 * The last case below asserts that agreement directly rather than restating the rule,
 * so the two cannot drift apart.
 */
describe("nonEmptyTrimmed", () => {
	/** The ordinary case: everything real survives, trimmed, in order. */
	it("keeps every value that has content, trimmed and in order", () => {
		expect(nonEmptyTrimmed(["  one ", "two", "\tthree\n"])).toEqual(["one", "two", "three"]);
	});

	/** Blank in every spelling is dropped: unset, null, empty, whitespace. */
	it("drops values with no content", () => {
		expect(nonEmptyTrimmed(["keep", "", "   ", undefined, null, "also"])).toEqual(["keep", "also"]);
	});

	/**
	 * Duplicates SURVIVE. This answers "which of these are real values", not "which
	 * are distinct" — a caller that needs uniqueness says so, and silently deduping
	 * would corrupt a list where repetition is meaningful.
	 */
	it("keeps duplicates", () => {
		expect(nonEmptyTrimmed(["a", "a", " a "])).toEqual(["a", "a", "a"]);
	});

	/** Nothing real in means an empty array out, never a list of blanks. */
	it("returns an empty array when nothing has content", () => {
		expect(nonEmptyTrimmed([])).toEqual([]);
		expect(nonEmptyTrimmed(["", "  ", null, undefined])).toEqual([]);
	});

	/** It takes any iterable, since callers hold Sets and generators as well as arrays. */
	it("accepts any iterable", () => {
		expect(nonEmptyTrimmed(new Set([" a ", "", "b"]))).toEqual(["a", "b"]);
	});

	/**
	 * THE AGREEMENT. Whatever `firstNonEmpty` picks out of a list is exactly the first
	 * thing `nonEmptyTrimmed` keeps from it. Asserted over a table of the awkward
	 * inputs rather than restated in prose, so one definition of "empty" cannot quietly
	 * become two.
	 */
	it("agrees with firstNonEmpty on what counts as empty", () => {
		const cases: (string | undefined | null)[][] = [
			["", "  ", "value"],
			[null, undefined, "0"],
			["  spaced  ", "later"],
			["", "   ", null],
			[],
		];

		expect(cases.length).toBeGreaterThan(3);
		for (const values of cases) {
			const fromList: string | null = nonEmptyTrimmed(values)[0] ?? null;
			const fromFirst: string | null = firstNonEmpty(...values);
			// Compared as a boolean rather than through `toBe`, whose expected-value type
			// is narrowed from the receiver and would need a cast to accept the union.
			// The message carries both sides, so a failure still names what disagreed.
			expect(
				fromList === fromFirst,
				`disagreed on ${JSON.stringify(values)}: list gave ${JSON.stringify(fromList)}, first gave ${JSON.stringify(fromFirst)}`,
			).toBe(true);
		}
	});
});
