import { describe, expect, it } from "bun:test";
import { levenshteinDistance } from "../src/levenshtein";

describe("levenshteinDistance", () => {
	it("returns 0 for identical strings and the other length for empty input", () => {
		expect(levenshteinDistance("", "")).toBe(0);
		expect(levenshteinDistance("same", "same")).toBe(0);
		expect(levenshteinDistance("", "abc")).toBe(3);
		expect(levenshteinDistance("abc", "")).toBe(3);
	});

	it("counts single-operation edits as 1", () => {
		expect(levenshteinDistance("cat", "cut")).toBe(1); // substitution
		expect(levenshteinDistance("cat", "cats")).toBe(1); // insertion
		expect(levenshteinDistance("cats", "cat")).toBe(1); // deletion
	});

	it("computes classic multi-edit distances", () => {
		expect(levenshteinDistance("kitten", "sitting")).toBe(3);
		expect(levenshteinDistance("flaw", "lawn")).toBe(2);
		expect(levenshteinDistance("intention", "execution")).toBe(5);
	});

	it("is symmetric", () => {
		expect(levenshteinDistance("sunday", "saturday")).toBe(levenshteinDistance("saturday", "sunday"));
		expect(levenshteinDistance("sunday", "saturday")).toBe(3);
	});

	it("measures astral characters in UTF-16 code units per the documented contract", () => {
		// "😀" is one surrogate pair = two code units, so replacing it with two
		// ASCII letters is two substitutions, and dropping it costs 2.
		expect(levenshteinDistance("😀", "ab")).toBe(2);
		expect(levenshteinDistance("a😀b", "ab")).toBe(2);
	});
});
