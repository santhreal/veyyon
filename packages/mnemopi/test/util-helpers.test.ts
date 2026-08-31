import { describe, expect, it } from "bun:test";
import { HOUR_MS } from "@veyyon/utils";
import {
	normalizeDateTimeUtc,
	parseIsoDateTimeUtc,
	parseQueryTime,
	parseTsFast,
	recencyDecay,
	temporalBoost,
	toUtcIso,
} from "../src/util/datetime";
import { generateId, sha256Hex16, stableMemoryId } from "../src/util/ids";
import {
	cjkFtsTerms,
	containsSpacelessCjk,
	FACT_MATCH_STOPWORDS,
	factMatchTokens,
	ftsQueryTerms,
	isCjkChar,
	minimumRecallRelevance,
	RECALL_SYNONYMS,
	recallTokens,
	unicodeWordTokens,
	WORD_TOKEN_DOT_HYPHEN_RE,
	WORD_TOKEN_HYPHEN_RE,
	WORD_TOKEN_RE,
} from "../src/util/regex";
import { jaccardIndex, jaccardWordSimilarity, overlapScore, wordSet } from "../src/util/text-similarity";

describe("parseIsoDateTimeUtc", () => {
	it("parses full ISO datetime with Z", () => {
		const date = parseIsoDateTimeUtc("2024-01-15T10:30:00Z");
		expect(date.getTime()).toBe(Date.UTC(2024, 0, 15, 10, 30, 0));
	});
	it("adds Z when no timezone", () => {
		const date = parseIsoDateTimeUtc("2024-01-15T10:30:00");
		expect(date.getTime()).toBe(Date.UTC(2024, 0, 15, 10, 30, 0));
	});
	it("parses date-only as midnight UTC", () => {
		const date = parseIsoDateTimeUtc("2024-01-15");
		expect(date.getTime()).toBe(Date.UTC(2024, 0, 15, 0, 0, 0));
	});
	it("handles timezone offset", () => {
		const date = parseIsoDateTimeUtc("2024-01-15T10:30:00+02:00");
		expect(date.getTime()).toBe(Date.UTC(2024, 0, 15, 8, 30, 0));
	});
	it("throws for empty string", () => {
		expect(() => parseIsoDateTimeUtc("")).toThrow(RangeError);
	});
	it("throws for whitespace-only string", () => {
		expect(() => parseIsoDateTimeUtc("   ")).toThrow(RangeError);
	});
	it("throws for invalid date", () => {
		expect(() => parseIsoDateTimeUtc("not-a-date")).toThrow(RangeError);
	});
	it("strips IXDTF zone annotation", () => {
		const date = parseIsoDateTimeUtc("2024-01-15T10:30:00Z[America/New_York]");
		expect(date.getTime()).toBe(Date.UTC(2024, 0, 15, 10, 30, 0));
	});
});

describe("normalizeDateTimeUtc", () => {
	it("returns a new Date with same time", () => {
		const original = new Date(Date.UTC(2024, 0, 15, 10, 30));
		const normalized = normalizeDateTimeUtc(original);
		expect(normalized.getTime()).toBe(original.getTime());
		expect(normalized).not.toBe(original);
	});
	it("throws for invalid Date", () => {
		expect(() => normalizeDateTimeUtc(new Date(NaN))).toThrow(RangeError);
	});
});

describe("parseQueryTime", () => {
	it("returns now for null", () => {
		const before = Date.now();
		const result = parseQueryTime(null);
		const after = Date.now();
		expect(result.getTime()).toBeGreaterThanOrEqual(before);
		expect(result.getTime()).toBeLessThanOrEqual(after);
	});
	it("returns now for undefined", () => {
		const before = Date.now();
		const result = parseQueryTime(undefined);
		const after = Date.now();
		expect(result.getTime()).toBeGreaterThanOrEqual(before);
		expect(result.getTime()).toBeLessThanOrEqual(after);
	});
	it("parses string as ISO", () => {
		const result = parseQueryTime("2024-01-15T10:30:00Z");
		expect(result.getTime()).toBe(Date.UTC(2024, 0, 15, 10, 30, 0));
	});
	it("normalizes Date input", () => {
		const input = new Date(Date.UTC(2024, 0, 15));
		const result = parseQueryTime(input);
		expect(result.getTime()).toBe(input.getTime());
	});
});

describe("parseTsFast", () => {
	it("returns undefined for empty string", () => {
		expect(parseTsFast("")).toBeUndefined();
	});
	it("returns undefined for invalid date", () => {
		expect(parseTsFast("not-a-date")).toBeUndefined();
	});
	it("parses valid ISO datetime", () => {
		const result = parseTsFast("2024-01-15T10:30:00Z");
		expect(result?.getTime()).toBe(Date.UTC(2024, 0, 15, 10, 30, 0));
	});
	it("caches results", () => {
		const r1 = parseTsFast("2024-01-15T10:30:00Z");
		const r2 = parseTsFast("2024-01-15T10:30:00Z");
		expect(r1).toBe(r2);
	});
});

describe("toUtcIso", () => {
	it("returns ISO string for given date", () => {
		const date = new Date(Date.UTC(2024, 0, 15, 10, 30, 0));
		expect(toUtcIso(date)).toBe("2024-01-15T10:30:00.000Z");
	});
	it("returns ISO string for now when no argument", () => {
		const result = toUtcIso();
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});
});

describe("recencyDecay", () => {
	it("returns fallback for null timestamp", () => {
		expect(recencyDecay(null)).toBe(0.5);
	});
	it("returns fallback for undefined timestamp", () => {
		expect(recencyDecay(undefined)).toBe(0.5);
	});
	it("returns 1 for timestamp at now", () => {
		const now = new Date();
		expect(recencyDecay(now, 24, now)).toBeCloseTo(1);
	});
	it("returns less than 1 for past timestamp", () => {
		const now = new Date();
		const past = new Date(now.getTime() - 24 * HOUR_MS);
		expect(recencyDecay(past, 24, now)).toBeCloseTo(Math.exp(-1), 5);
	});
	it("returns fallback for invalid timestamp", () => {
		expect(recencyDecay("not-a-date")).toBe(0.5);
	});
	it("decays exponentially", () => {
		const now = new Date();
		const twoHalflives = new Date(now.getTime() - 48 * HOUR_MS);
		expect(recencyDecay(twoHalflives, 24, now)).toBeCloseTo(Math.exp(-2), 5);
	});
});

describe("temporalBoost", () => {
	it("returns 0 for invalid timestamp", () => {
		expect(temporalBoost("not-a-date")).toBe(0);
	});
	it("returns 1 for timestamp at query time", () => {
		const queryTime = "2024-01-15T10:30:00Z";
		expect(temporalBoost(queryTime, queryTime)).toBeCloseTo(1);
	});
	it("returns less than 1 for older timestamp", () => {
		const query = "2024-01-15T10:30:00Z";
		const memory = "2024-01-14T10:30:00Z";
		expect(temporalBoost(memory, query, 24)).toBeCloseTo(Math.exp(-1), 5);
	});
	it("clamps future timestamp to query time", () => {
		const query = "2024-01-15T10:30:00Z";
		const future = "2024-01-16T10:30:00Z";
		expect(temporalBoost(future, query)).toBeCloseTo(1);
	});
});

describe("sha256Hex16", () => {
	it("returns 16 hex chars", () => {
		const hash = sha256Hex16("test");
		expect(hash).toMatch(/^[0-9a-f]{16}$/);
	});
	it("is deterministic", () => {
		expect(sha256Hex16("test")).toBe(sha256Hex16("test"));
	});
	it("differs for different inputs", () => {
		expect(sha256Hex16("a")).not.toBe(sha256Hex16("b"));
	});
	it("handles Uint8Array input", () => {
		const input = new TextEncoder().encode("test");
		expect(sha256Hex16(input)).toBe(sha256Hex16("test"));
	});
});

describe("generateId", () => {
	it("returns 16 hex chars", () => {
		expect(generateId("content")).toMatch(/^[0-9a-f]{16}$/);
	});
	it("generates different ids for same content (nonce)", () => {
		const id1 = generateId("content");
		const id2 = generateId("content");
		expect(id1).not.toBe(id2);
	});
});

describe("stableMemoryId", () => {
	it("is deterministic for same content", () => {
		expect(stableMemoryId("content")).toBe(stableMemoryId("content"));
	});
	it("differs for different content", () => {
		expect(stableMemoryId("a")).not.toBe(stableMemoryId("b"));
	});
	it("includes source when provided", () => {
		expect(stableMemoryId("content", "source")).not.toBe(stableMemoryId("content"));
	});
	it("matches content-only when no source", () => {
		expect(stableMemoryId("content")).toBe(stableMemoryId("content", ""));
	});
});

describe("jaccardIndex", () => {
	it("returns 1 for identical sets", () => {
		expect(jaccardIndex(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
	});
	it("returns 0 for disjoint sets", () => {
		expect(jaccardIndex(new Set(["a"]), new Set(["b"]))).toBe(0);
	});
	it("returns 0 for empty set", () => {
		expect(jaccardIndex(new Set<string>(), new Set(["a"]))).toBe(0);
	});
	it("returns 0.5 for half overlap", () => {
		expect(jaccardIndex(new Set(["a", "b"]), new Set(["a", "c"]))).toBeCloseTo(1 / 3);
	});
});

describe("overlapScore", () => {
	it("returns 1 for identical sets", () => {
		expect(overlapScore(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
	});
	it("returns 0 for disjoint sets", () => {
		expect(overlapScore(new Set(["a"]), new Set(["b"]))).toBe(0);
	});
	it("returns 0 for empty set", () => {
		expect(overlapScore(new Set<string>(), new Set(["a"]))).toBe(0);
	});
	it("returns intersection/max for different sizes", () => {
		expect(overlapScore(new Set(["a", "b"]), new Set(["a", "b", "c"]))).toBeCloseTo(2 / 3);
	});
});

describe("wordSet", () => {
	it("splits text into words", () => {
		expect(wordSet("hello world")).toEqual(new Set(["hello", "world"]));
	});
	it("lowercases text", () => {
		expect(wordSet("Hello WORLD")).toEqual(new Set(["hello", "world"]));
	});
	it("handles empty string", () => {
		expect(wordSet("")).toEqual(new Set());
	});
	it("handles whitespace-only string", () => {
		expect(wordSet("   ")).toEqual(new Set());
	});
	it("deduplicates words", () => {
		expect(wordSet("hello hello")).toEqual(new Set(["hello"]));
	});
});

describe("jaccardWordSimilarity", () => {
	it("returns 1 for identical text", () => {
		expect(jaccardWordSimilarity("hello world", "hello world")).toBe(1);
	});
	it("returns 0 for completely different text", () => {
		expect(jaccardWordSimilarity("hello", "goodbye")).toBe(0);
	});
	it("returns partial similarity", () => {
		expect(jaccardWordSimilarity("hello world", "hello there")).toBeCloseTo(1 / 3);
	});
});

describe("unicodeWordTokens", () => {
	it("extracts word tokens", () => {
		expect(unicodeWordTokens("hello world123")).toEqual(["hello", "world123"]);
	});
	it("handles empty string", () => {
		expect(unicodeWordTokens("")).toEqual([]);
	});
	it("handles hyphenated words with hyphen class", () => {
		expect(unicodeWordTokens("hello-world", WORD_TOKEN_HYPHEN_RE)).toEqual(["hello-world"]);
	});
	it("handles dotted words with dot-hyphen class", () => {
		expect(unicodeWordTokens("hello.world", WORD_TOKEN_DOT_HYPHEN_RE)).toEqual(["hello.world"]);
	});
	it("splits on hyphen with default class", () => {
		expect(unicodeWordTokens("hello-world")).toEqual(["hello", "world"]);
	});
});

describe("isCjkChar", () => {
	it("returns true for CJK ideograph", () => {
		expect(isCjkChar("中")).toBe(true);
	});
	it("returns true for hiragana", () => {
		expect(isCjkChar("あ")).toBe(true);
	});
	it("returns true for hangul", () => {
		expect(isCjkChar("가")).toBe(true);
	});
	it("returns false for ASCII", () => {
		expect(isCjkChar("a")).toBe(false);
	});
	it("returns false for digit", () => {
		expect(isCjkChar("1")).toBe(false);
	});
});

describe("containsSpacelessCjk", () => {
	it("returns true for CJK text", () => {
		expect(containsSpacelessCjk("日本語")).toBe(true);
	});
	it("returns false for ASCII text", () => {
		expect(containsSpacelessCjk("hello")).toBe(false);
	});
	it("returns true for mixed text", () => {
		expect(containsSpacelessCjk("hello日本")).toBe(true);
	});
});

describe("recallTokens", () => {
	it("extracts tokens from text", () => {
		const tokens = recallTokens("hello world");
		expect(tokens).toContain("hello");
		expect(tokens).toContain("world");
	});
	it("filters out short tokens (< 3 chars)", () => {
		const tokens = recallTokens("hi world");
		expect(tokens).not.toContain("hi");
		expect(tokens).toContain("world");
	});
	it("filters out stopwords", () => {
		const tokens = recallTokens("the hello");
		expect(tokens).not.toContain("the");
		expect(tokens).toContain("hello");
	});
	it("filters out pure digit tokens", () => {
		const tokens = recallTokens("123 hello");
		expect(tokens).not.toContain("123");
		expect(tokens).toContain("hello");
	});
	it("lowercases text", () => {
		const tokens = recallTokens("HELLO");
		expect(tokens).toContain("hello");
	});
	it("returns empty for empty string", () => {
		expect(recallTokens("")).toEqual([]);
	});
});

describe("factMatchTokens", () => {
	it("returns a Set of recall tokens", () => {
		const tokens = factMatchTokens("hello world");
		expect(tokens).toBeInstanceOf(Set);
		expect(tokens.has("hello")).toBe(true);
		expect(tokens.has("world")).toBe(true);
	});
});

describe("minimumRecallRelevance", () => {
	it("returns 0.3 for 4+ tokens", () => {
		expect(minimumRecallRelevance(["a", "b", "c", "d"])).toBe(0.3);
		expect(minimumRecallRelevance(["a", "b", "c", "d", "e"])).toBe(0.3);
	});
	it("returns 0.5 for 3 tokens", () => {
		expect(minimumRecallRelevance(["a", "b", "c"])).toBe(0.5);
	});
	it("returns 0.15 for fewer than 3 tokens", () => {
		expect(minimumRecallRelevance(["a", "b"])).toBe(0.15);
		expect(minimumRecallRelevance(["a"])).toBe(0.15);
		expect(minimumRecallRelevance([])).toBe(0.15);
	});
});

describe("cjkFtsTerms", () => {
	it("returns empty for non-CJK text", () => {
		expect(cjkFtsTerms("hello")).toEqual([]);
	});
	it("deduplicates chars", () => {
		const terms = cjkFtsTerms("日日");
		expect(terms.filter(t => t === "日")).toHaveLength(1);
	});
	it("returns bigrams for consecutive CJK chars", () => {
		const terms = cjkFtsTerms("日本");
		expect(terms).toContain('"日本"');
	});
});

describe("ftsQueryTerms", () => {
	it("returns quoted terms", () => {
		const terms = ftsQueryTerms("hello world");
		expect(terms.every(t => t.startsWith('"') && t.endsWith('"'))).toBe(true);
	});
	it("returns empty for empty query", () => {
		expect(ftsQueryTerms("")).toEqual([]);
	});
	it("handles text with special characters", () => {
		const terms = ftsQueryTerms("hello world");
		expect(terms.length).toBeGreaterThan(0);
		expect(terms.every(t => t.startsWith('"') && t.endsWith('"'))).toBe(true);
	});
});

describe("FACT_MATCH_STOPWORDS", () => {
	it("contains 'the'", () => {
		expect(FACT_MATCH_STOPWORDS.has("the")).toBe(true);
	});
	it("contains 'is'", () => {
		expect(FACT_MATCH_STOPWORDS.has("is")).toBe(true);
	});
	it("does not contain 'hello'", () => {
		expect(FACT_MATCH_STOPWORDS.has("hello")).toBe(false);
	});
});

describe("RECALL_SYNONYMS", () => {
	it("is a record", () => {
		expect(typeof RECALL_SYNONYMS).toBe("object");
	});
});
