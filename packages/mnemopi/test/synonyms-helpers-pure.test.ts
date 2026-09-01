import { describe, expect, it } from "bun:test";
import {
	CORE_QUERY_STOP_WORDS,
	expandQuery,
	getSynonyms,
	normalizeQuery,
	STOP_WORDS,
	SYNONYM_GROUPS,
} from "../src/core/synonyms";

describe("SYNONYM_GROUPS", () => {
	it("contains database group", () => {
		expect(SYNONYM_GROUPS.database).toContain("db");
		expect(SYNONYM_GROUPS.database).toContain("datastore");
	});
	it("contains password group", () => {
		expect(SYNONYM_GROUPS.password).toContain("pwd");
		expect(SYNONYM_GROUPS.password).toContain("credential");
	});
	it("all groups are arrays", () => {
		for (const key in SYNONYM_GROUPS) {
			expect(Array.isArray(SYNONYM_GROUPS[key as keyof typeof SYNONYM_GROUPS])).toBe(true);
		}
	});
});

describe("normalizeQuery", () => {
	it("lowercases input", () => {
		expect(normalizeQuery("Database Query")).toBe(normalizeQuery("database query"));
	});
	it("removes stop words", () => {
		const result = normalizeQuery("the database is a good thing");
		expect(result).not.toContain("the");
		expect(result).not.toContain("is");
		expect(result).toContain("database");
		expect(result).toContain("good");
		expect(result).toContain("thing");
	});
	it("returns sorted unique words", () => {
		const result = normalizeQuery("db database");
		const words = result.split(" ");
		expect(words.length).toBe(1);
		expect(words[0]).toBe("database");
	});
	it("handles empty string", () => {
		expect(normalizeQuery("")).toBe("");
	});
	it("handles whitespace-only string", () => {
		expect(normalizeQuery("   ")).toBe("");
	});
	it("preserves unknown words", () => {
		const result = normalizeQuery("xyzzy plugh");
		expect(result).toContain("xyzzy");
		expect(result).toContain("plugh");
	});
	it("canonicalizes multiple synonyms to same canonical", () => {
		const result = normalizeQuery("db datastore data_store");
		const words = result.split(" ");
		expect(words.length).toBe(1);
		expect(words[0]).toBe("database");
	});
});

describe("expandQuery", () => {
	it("expands known words into groups", () => {
		const result = expandQuery("db");
		expect(result).toContain("database");
		expect(result).toContain("db");
		expect(result).toContain("datastore");
		expect(result).toContain("(");
		expect(result).toContain(")");
	});
	it("preserves unknown words as-is", () => {
		const result = expandQuery("xyzzy");
		expect(result).toBe("xyzzy");
	});
	it("passes through stop words without expansion", () => {
		const result = expandQuery("the");
		expect(result).toContain("the");
		expect(result).not.toContain("(");
	});
	it("handles empty string", () => {
		expect(expandQuery("")).toBe("");
	});
	it("handles mixed known and unknown words", () => {
		const result = expandQuery("db xyzzy");
		expect(result).toContain("database");
		expect(result).toContain("xyzzy");
	});
	it("lowercases input", () => {
		expect(expandQuery("DB")).toBe(expandQuery("db"));
	});
	it("joins expanded parts with spaces", () => {
		const result = expandQuery("db error");
		expect(result).toContain(" ");
		expect(result).toContain("database");
		expect(result).toContain("error");
	});
});

describe("getSynonyms", () => {
	it("returns canonical and synonyms for known word", () => {
		const result = getSynonyms("db");
		expect(result[0]).toBe("database");
		expect(result).toContain("db");
		expect(result).toContain("datastore");
	});
	it("returns canonical and synonyms for canonical word itself", () => {
		const result = getSynonyms("database");
		expect(result[0]).toBe("database");
		expect(result).toContain("db");
	});
	it("returns [word] for unknown word", () => {
		const result = getSynonyms("xyzzy");
		expect(result).toEqual(["xyzzy"]);
	});
	it("lowercases input", () => {
		expect(getSynonyms("DB")).toEqual(getSynonyms("db"));
	});
	it("handles empty string", () => {
		expect(getSynonyms("")).toEqual([""]);
	});
});

describe("STOP_WORDS", () => {
	it("contains common function words", () => {
		expect(STOP_WORDS.has("the")).toBe(true);
		expect(STOP_WORDS.has("is")).toBe(true);
		expect(STOP_WORDS.has("a")).toBe(true);
	});
	it("is a superset of CORE_QUERY_STOP_WORDS", () => {
		for (const word of CORE_QUERY_STOP_WORDS) {
			expect(STOP_WORDS.has(word)).toBe(true);
		}
	});
});
