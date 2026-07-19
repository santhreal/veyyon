import { describe, expect, it } from "bun:test";
import {
	ENTITY_EXTRACTION_STOP_WORDS,
	entityExtractionPerformance,
	extractEntitiesRegex,
	findSimilarEntities,
	levenshteinDistance,
	REGEX_EXTRACTION_MAX_INPUT_CHARS,
	similarity,
} from "@veyyon/mnemopi/core/entities";

describe("entity utilities", () => {
	it("computes edit distance with empty and unicode strings", () => {
		expect(levenshteinDistance("hello", "hello")).toBe(0);
		expect(levenshteinDistance("cat", "cats")).toBe(1);
		expect(levenshteinDistance("cats", "cat")).toBe(1);
		expect(levenshteinDistance("cat", "cut")).toBe(1);
		expect(levenshteinDistance("", "abc")).toBe(3);
		expect(levenshteinDistance("café", "cafe")).toBe(1);
		expect(levenshteinDistance("日本", "日本語")).toBe(1);
	});

	it("scores entity names with case-insensitive prefix and substring bonuses", () => {
		expect(similarity("ABDIAS", "abdias")).toBe(1.0);
		expect(similarity("Abdias", "Abdias J.")).toBeGreaterThan(0.8);
		expect(similarity("Abdias", "Abdias Moya")).toBeGreaterThan(0.7);
		expect(similarity("Abdias", "Abdul")).toBeLessThan(0.8);
		expect(similarity("Abdias", "Abdul")).toBeGreaterThan(0.3);
		expect(similarity("Abdias", "Zebra")).toBeLessThan(0.3);
		expect(similarity("A", "B")).toBe(0.0);
		expect(similarity("", "abc")).toBe(0.0);
	});

	it("extracts names, phrases, mentions, hashtags, and filters contaminated stop-word phrases", () => {
		const result = extractEntitiesRegex(
			"Abdias said: 'The Mnemopi project is #Awesome. Contact @support or visit New York.' Maya agreed.",
		);
		expect(result).toContain("Abdias");
		expect(result).toContain("Maya");
		expect(result).toContain("New York");
		expect(result).toContain("Awesome");
		expect(result).toContain("support");
		expect(result).not.toContain("The Mnemopi");
	});

	it("drops lowercase prose, pure numbers, and substring duplicate capitalized terms", () => {
		expect(extractEntitiesRegex("the quick brown fox jumps")).toEqual([]);
		expect(extractEntitiesRegex("The Quick Brown Fox 123 1,234")).toEqual(["Brown", "Fox", "Quick"]);
		expect(extractEntitiesRegex("I visited New York with Abdias yesterday.")).toEqual(["Abdias", "New York"]);
	});

	it("skips regex extraction for oversized raw transcripts", () => {
		const text = "Project Alpha progress ".repeat(Math.ceil((REGEX_EXTRACTION_MAX_INPUT_CHARS + 1) / 23));

		expect(extractEntitiesRegex(text)).toEqual([]);
	});

	it("scores a mid-string substring (not a prefix) with the 0.5 base bonus", () => {
		// "abdias" is contained in "dr abdias" but neither is a prefix of the
		// other, so the includes branch fires: 0.5 + (6/9) * 0.3.
		expect(similarity("Abdias", "Dr Abdias")).toBeCloseTo(0.5 + (6 / 9) * 0.3, 10);
	});

	it("returns 0 for a prefix match whose shorter side is under 30% of the longer", () => {
		// "a" is a prefix of the longer string but only 1/10 of its length.
		expect(similarity("A", "Abcdefghij")).toBe(0.0);
	});

	it("finds similar entities above threshold sorted by score", () => {
		const result = findSimilarEntities("Abdias", ["Maya", "Abdias Moya", "Abdias J.", "Zebra"], 0.7);
		expect(result.map(([name]) => name)).toEqual(["Abdias J.", "Abdias Moya"]);
		expect(findSimilarEntities("Zebra", ["Abdias", "Maya"], 0.8)).toEqual([]);
	});

	it("scores an exact match as 1.0 and ranks it first", () => {
		const result = findSimilarEntities("Abdias", ["Abdias J.", "Abdias"], 0.7);
		expect(result[0]).toEqual(["Abdias", 1.0]);
		expect(result.map(([, score]) => score)).toEqual([1.0, expect.any(Number)]);
		expect(result[1]?.[1]).toBeLessThan(1.0);
	});

	it("measures per-iteration extraction time as a finite non-negative number", () => {
		const perIteration = entityExtractionPerformance("Abdias visited New York", 5);
		expect(perIteration).toBeGreaterThanOrEqual(0);
		expect(Number.isFinite(perIteration)).toBe(true);
	});

	it("exports the stop-word set used by extraction", () => {
		expect(ENTITY_EXTRACTION_STOP_WORDS.has("the")).toBe(true);
		expect(ENTITY_EXTRACTION_STOP_WORDS.has("and")).toBe(true);
		expect(ENTITY_EXTRACTION_STOP_WORDS.has("for")).toBe(true);
	});
});
