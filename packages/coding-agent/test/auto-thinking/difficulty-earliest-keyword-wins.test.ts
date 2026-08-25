/**
 * `parseDifficultyLevel` / `parseDifficultyBucket` take the FIRST keyword in
 * the classifier's prose, not the last and not a substring inside a larger word.
 *
 * Existing `auto-thinking-classifier.test.ts` only pins isolated labels
 * ("high", "x-high", "trivial"). A real classifier answer is a sentence:
 *
 *   "This is nontrivial; treat it as high rather than xhigh."
 *
 * Two defects the isolated-label suite cannot see:
 *
 *   1. SUBSTRING FALSE POSITIVES. `\btrivial\b` must not fire inside
 *      `nontrivial`. `/x[\s_-]?high/` must not steal `high` from `xhigh`,
 *      but `extremely high` is ordinary `high` (the `x` in `extremely` is
 *      not adjacent to `high`).
 *   2. EARLIEST WINS. When both `high` and `xhigh` appear, the index of the
 *      first match decides. A model that hedges ("not xhigh, just high")
 *      must not be classified as XHigh because XHigh was probed first in
 *      source order.
 *
 * The contract is Effort, not a string. Stay red if a hyphenated English
 * word (`hard-coded`) is treated as the local `hard` bucket: `\b` treats
 * `-` as a boundary.
 */
import { describe, expect, it } from "bun:test";
import { Effort } from "@veyyon/catalog/effort";
import {
	parseDifficultyBucket,
	parseDifficultyLevel,
} from "@veyyon/coding-agent/auto-thinking/classifier";

describe("parseDifficultyLevel does not treat a substring as a label", () => {
	it("does not classify lowercase as a difficulty (the online schema has no 'lower')", () => {
		expect(parseDifficultyLevel("lowercase identifiers only")).toBeUndefined();
	});

	it("does not classify 'lowest' via the `low` word", () => {
		expect(parseDifficultyLevel("pick the lowest hanging fruit")).toBeUndefined();
	});

	it("does not classify 'highest' via the `high` word", () => {
		expect(parseDifficultyLevel("the highest priority is docs")).toBeUndefined();
	});

	it("does not classify 'mediums' as medium", () => {
		expect(parseDifficultyLevel("swap the mediums")).toBeUndefined();
	});

	it("does not treat the 'x' in 'extremely high' as an xhigh token", () => {
		expect(parseDifficultyLevel("extremely high complexity")).toBe(Effort.High);
	});

	it("does not treat 'maxhigh' as xhigh (no separator, no leading x-token)", () => {
		expect(parseDifficultyLevel("maxhigh")).toBeUndefined();
	});

	it("still sees 'x high' with a space as xhigh, not high", () => {
		expect(parseDifficultyLevel("answer: x high")).toBe(Effort.XHigh);
	});

	it("still sees 'x_high' as xhigh", () => {
		expect(parseDifficultyLevel("x_high")).toBe(Effort.XHigh);
	});

	it("still sees 'XHIGH' case-insensitively as xhigh", () => {
		expect(parseDifficultyLevel("XHIGH")).toBe(Effort.XHigh);
	});
});

describe("parseDifficultyLevel earliest keyword in the sentence wins", () => {
	it("picks high when high appears before xhigh", () => {
		expect(parseDifficultyLevel("high, not xhigh")).toBe(Effort.High);
	});

	it("picks xhigh when xhigh appears before high", () => {
		expect(parseDifficultyLevel("xhigh rather than high")).toBe(Effort.XHigh);
	});

	it("picks low when the hedge lists low first", () => {
		expect(parseDifficultyLevel("low (maybe medium, never high)")).toBe(Effort.Low);
	});

	it("picks medium when 'med' precedes 'high'", () => {
		expect(parseDifficultyLevel("med, not high")).toBe(Effort.Medium);
	});

	it("picks medium for 'medium' before a later 'low' recant", () => {
		expect(parseDifficultyLevel("medium — ignore the trailing low")).toBe(Effort.Medium);
	});

	it("does not let a later x-high override an earlier low", () => {
		expect(parseDifficultyLevel("low effort. appendix: x-high for experts")).toBe(Effort.Low);
	});

	it("treats a JSON-ish wrapper the same as prose (earliest still wins)", () => {
		expect(parseDifficultyLevel('{"label":"high","also":"xhigh"}')).toBe(Effort.High);
	});

	it("ignores punctuation glued after the first keyword", () => {
		expect(parseDifficultyLevel("high.")).toBe(Effort.High);
		expect(parseDifficultyLevel("high,")).toBe(Effort.High);
		expect(parseDifficultyLevel("high;")).toBe(Effort.High);
	});

	it("does not match high inside a snake_case identifier that is not a label", () => {
		expect(parseDifficultyLevel("use effort_high_watermark")).toBeUndefined();
	});
});

describe("parseDifficultyBucket does not fire inside a larger English word", () => {
	it("does not classify 'nontrivial' as trivial", () => {
		expect(parseDifficultyBucket("this is nontrivial")).toBeUndefined();
	});

	it("does not classify 'triviality' as trivial", () => {
		expect(parseDifficultyBucket("a matter of triviality")).toBeUndefined();
	});

	it("does not classify 'moderately' as moderate", () => {
		expect(parseDifficultyBucket("moderately sized change")).toBeUndefined();
	});

	it("does not classify 'hardly' as hard", () => {
		expect(parseDifficultyBucket("hardly any work")).toBeUndefined();
	});

	it("does not classify 'hardware' as hard", () => {
		expect(parseDifficultyBucket("hardware register map")).toBeUndefined();
	});

	it("still classifies a standalone 'trivial' after a comma", () => {
		expect(parseDifficultyBucket("nontrivial? no, trivial")).toBe(Effort.Low);
	});
});

describe("parseDifficultyBucket hyphenated English is a word-boundary trap", () => {
	it("must not treat 'hard-coded' as the hard bucket", () => {
		expect(parseDifficultyBucket("a hard-coded constant")).toBeUndefined();
	});

	it("must not treat 'moderate-sized' as the moderate bucket", () => {
		expect(parseDifficultyBucket("a moderate-sized refactor")).toBeUndefined();
	});

	it("must not treat 'trivial-looking' as the trivial bucket", () => {
		expect(parseDifficultyBucket("a trivial-looking rename")).toBeUndefined();
	});

	it("still classifies 'hard' when it is a real token before a hyphenated word", () => {
		expect(parseDifficultyBucket("hard, not hard-coded")).toBe(Effort.XHigh);
	});
});

describe("parseDifficultyBucket earliest keyword wins", () => {
	it("picks trivial when it appears before hard", () => {
		expect(parseDifficultyBucket("trivial, not hard")).toBe(Effort.Low);
	});

	it("picks hard when it appears before trivial", () => {
		expect(parseDifficultyBucket("hard rather than trivial")).toBe(Effort.XHigh);
	});

	it("picks moderate when it appears before hard", () => {
		expect(parseDifficultyBucket("moderate; ignore later hard")).toBe(Effort.High);
	});

	it("does not let a recant after a newline override the first token", () => {
		expect(parseDifficultyBucket("trivial\nhard")).toBe(Effort.Low);
	});
});

describe("empty and non-label classifier output is undefined, not Low", () => {
	it("returns undefined for the empty string", () => {
		expect(parseDifficultyLevel("")).toBeUndefined();
		expect(parseDifficultyBucket("")).toBeUndefined();
	});

	it("returns undefined for whitespace", () => {
		expect(parseDifficultyLevel("   \n\t")).toBeUndefined();
		expect(parseDifficultyBucket("   \n\t")).toBeUndefined();
	});

	it("returns undefined for a numeric Likert that is not a keyword", () => {
		expect(parseDifficultyLevel("3")).toBeUndefined();
		expect(parseDifficultyBucket("3")).toBeUndefined();
	});

	it("returns undefined for the online labels on the local parser and vice versa", () => {
		expect(parseDifficultyBucket("xhigh")).toBeUndefined();
		expect(parseDifficultyBucket("medium")).toBeUndefined();
		expect(parseDifficultyBucket("low")).toBeUndefined();
		expect(parseDifficultyLevel("trivial")).toBeUndefined();
		expect(parseDifficultyLevel("moderate")).toBeUndefined();
		expect(parseDifficultyLevel("hard")).toBeUndefined();
	});
});
