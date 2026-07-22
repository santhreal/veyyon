import { describe, expect, it } from "bun:test";
import { EditMatchError, findClosestSequenceMatch, similarity } from "@veyyon/coding-agent/edit/modes/replace";

/**
 * The edit tool's fuzzy-match engine (edit/modes/replace.ts) decides whether the
 * `old_text` a model supplied is present in a file and, on a miss, tells the model
 * exactly what the closest line looked like so it can retry. `findMatch`,
 * `seekSequence`, and `findContextLine` are exercised elsewhere, but three
 * load-bearing pieces had NO direct coverage:
 *
 *  - `similarity`, the Levenshtein-derived 0..1 score every fuzzy pass builds on. A
 *    regression in its normalization or the empty-string edge cases silently shifts
 *    every threshold decision in the module.
 *  - `findClosestSequenceMatch`, the "always return the best guess even below
 *    threshold" variant used to surface the nearest miss. It must honor the empty
 *    pattern, the pattern-longer-than-file guard, and the eof preference for the
 *    last candidate.
 *  - `EditMatchError.formatMessage`, the operator-facing error. Its wording is a
 *    contract the agent reads back: the no-match text differs by allowFuzzy, and
 *    when a closest line exists it must render the first differing line as a
 *    `-`/`+` pair and pick the right remediation hint (disabled vs below-threshold
 *    vs multiple-matches). A regression here misdirects every failed edit retry.
 *
 * These assert exact scores, indices, and message bytes.
 */

describe("similarity", () => {
	it("scores two empty strings as a perfect match", () => {
		expect(similarity("", "")).toBe(1);
	});

	it("scores identical strings as 1 and disjoint strings as 0", () => {
		expect(similarity("hello", "hello")).toBe(1);
		expect(similarity("abc", "xyz")).toBe(0);
	});

	it("scores one empty string against a non-empty one as 0", () => {
		expect(similarity("hello", "")).toBe(0);
		expect(similarity("", "hello")).toBe(0);
	});

	it("derives the score from the edit distance over the longer length", () => {
		// one substitution in five characters -> 1 - 1/5 = 0.8
		expect(similarity("hello", "hallo")).toBe(0.8);
	});
});

describe("findClosestSequenceMatch", () => {
	const lines = ["function foo() {", "  return 1;", "}", "const x = 2;"];

	it("returns the exact line index at full confidence", () => {
		expect(findClosestSequenceMatch(lines, ["  return 1;"])).toEqual({
			index: 1,
			confidence: 1,
			strategy: "fuzzy",
		});
	});

	it("returns the nearest line below a perfect score when nothing matches exactly", () => {
		const result = findClosestSequenceMatch(lines, ["  return 2;"]);
		expect(result.index).toBe(1);
		expect(result.confidence).toBeGreaterThan(0.85);
		expect(result.confidence).toBeLessThan(1);
		expect(result.strategy).toBe("fuzzy");
	});

	it("treats an empty pattern as an exact hit at the start position", () => {
		expect(findClosestSequenceMatch(lines, [])).toEqual({ index: 0, confidence: 1, strategy: "exact" });
	});

	it("returns no index when the pattern is longer than the file", () => {
		expect(findClosestSequenceMatch(lines, ["a", "b", "c", "d", "e"])).toEqual({
			index: undefined,
			confidence: 0,
			strategy: "fuzzy",
		});
	});

	it("prefers the last candidate when eof is set", () => {
		// three identical lines: eof must pick the final one, not the first.
		expect(findClosestSequenceMatch(["x", "x", "x"], ["x"], { eof: true }).index).toBe(2);
	});
});

describe("EditMatchError.formatMessage", () => {
	const closest = { actualText: "  return 2;", startIndex: 20, startLine: 5, confidence: 0.9 };

	it("reports a plain miss differently for fuzzy-enabled vs exact-only", () => {
		expect(EditMatchError.formatMessage("f.ts", "x", undefined, { allowFuzzy: true, threshold: 0.95 })).toBe(
			"Could not find a close enough match in f.ts.",
		);
		expect(EditMatchError.formatMessage("f.ts", "x", undefined, { allowFuzzy: false, threshold: 0.95 })).toBe(
			"Could not find the exact text in f.ts. The old text must match exactly including all whitespace and newlines.",
		);
	});

	it("renders the closest line as a -/+ diff and tells the user fuzzy is disabled", () => {
		expect(EditMatchError.formatMessage("f.ts", "  return 1;", closest, { allowFuzzy: false, threshold: 0.95 })).toBe(
			[
				"Could not find the exact text in f.ts.",
				"",
				"Closest match (90% similar) at line 5:",
				"  -   return 1;",
				"  +   return 2;",
				"Fuzzy matching is disabled. Enable 'Edit fuzzy match' in settings to accept high-confidence matches.",
			].join("\n"),
		);
	});

	it("hints about the similarity threshold for a single below-threshold match", () => {
		expect(EditMatchError.formatMessage("f.ts", "  return 1;", closest, { allowFuzzy: true, threshold: 0.95 })).toBe(
			[
				"Could not find a close enough match in f.ts.",
				"",
				"Closest match (90% similar) at line 5:",
				"  -   return 1;",
				"  +   return 2;",
				"Closest match was below the 95% similarity threshold.",
			].join("\n"),
		);
	});

	it("hints to add context when multiple high-confidence matches exist", () => {
		expect(
			EditMatchError.formatMessage("f.ts", "  return 1;", closest, {
				allowFuzzy: true,
				threshold: 0.95,
				fuzzyMatches: 3,
			}),
		).toBe(
			[
				"Could not find a close enough match in f.ts.",
				"",
				"Closest match (90% similar) at line 5:",
				"  -   return 1;",
				"  +   return 2;",
				"Found 3 high-confidence matches. Provide more context to make it unique.",
			].join("\n"),
		);
	});
});
