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
import { truncateForLog } from "../src/util/log-format";
import { jaccardIndex, jaccardWordSimilarity, overlapScore, wordSet } from "../src/util/text-similarity";

describe("jaccardIndex", () => {
	it("returns 1 for identical sets", () => {
		expect(jaccardIndex(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
	});

	it("returns 0 for disjoint sets", () => {
		expect(jaccardIndex(new Set(["a"]), new Set(["b"]))).toBe(0);
	});

	it("returns 0 for empty set a", () => {
		expect(jaccardIndex(new Set<string>(), new Set(["a"]))).toBe(0);
	});

	it("returns 0 for empty set b", () => {
		expect(jaccardIndex(new Set(["a"]), new Set<string>())).toBe(0);
	});

	it("returns 0 for both empty", () => {
		expect(jaccardIndex(new Set<string>(), new Set<string>())).toBe(0);
	});

	it("computes partial overlap", () => {
		expect(jaccardIndex(new Set(["a", "b", "c"]), new Set(["a", "b", "d"]))).toBeCloseTo(2 / 4);
	});

	it("returns 1 for single element identical", () => {
		expect(jaccardIndex(new Set(["x"]), new Set(["x"]))).toBe(1);
	});
});

describe("overlapScore", () => {
	it("returns 1 for identical sets", () => {
		expect(overlapScore(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
	});

	it("returns 0 for disjoint sets", () => {
		expect(overlapScore(new Set(["a"]), new Set(["b"]))).toBe(0);
	});

	it("returns 0 for empty sets", () => {
		expect(overlapScore(new Set<string>(), new Set(["a"]))).toBe(0);
	});

	it("computes overlap relative to larger set", () => {
		expect(overlapScore(new Set(["a"]), new Set(["a", "b", "c"]))).toBeCloseTo(1 / 3);
	});

	it("computes overlap when first set is larger", () => {
		expect(overlapScore(new Set(["a", "b", "c"]), new Set(["a"]))).toBeCloseTo(1 / 3);
	});
});

describe("wordSet", () => {
	it("creates set from space-separated words", () => {
		expect(wordSet("hello world")).toEqual(new Set(["hello", "world"]));
	});

	it("lowercases words", () => {
		expect(wordSet("Hello WORLD")).toEqual(new Set(["hello", "world"]));
	});

	it("handles empty string", () => {
		expect(wordSet("").size).toBe(0);
	});

	it("handles whitespace-only string", () => {
		expect(wordSet("   ").size).toBe(0);
	});

	it("handles multiple spaces", () => {
		expect(wordSet("a   b   c")).toEqual(new Set(["a", "b", "c"]));
	});

	it("handles tabs and newlines", () => {
		expect(wordSet("a\tb\nc")).toEqual(new Set(["a", "b", "c"]));
	});

	it("deduplicates words", () => {
		expect(wordSet("a a a").size).toBe(1);
	});
});

describe("jaccardWordSimilarity", () => {
	it("returns 1 for identical text", () => {
		expect(jaccardWordSimilarity("hello world", "hello world")).toBe(1);
	});

	it("returns 0 for completely different text", () => {
		expect(jaccardWordSimilarity("foo bar", "baz qux")).toBe(0);
	});

	it("returns 0 for empty strings", () => {
		expect(jaccardWordSimilarity("", "")).toBe(0);
	});

	it("computes partial similarity", () => {
		const score = jaccardWordSimilarity("the quick brown fox", "the quick red fox");
		expect(score).toBeCloseTo(3 / 5);
	});

	it("is case-insensitive", () => {
		expect(jaccardWordSimilarity("Hello World", "hello world")).toBe(1);
	});
});

describe("truncateForLog", () => {
	it("returns string unchanged when under max", () => {
		expect(truncateForLog("hello", 10)).toBe("hello");
	});

	it("returns string unchanged when equal to max", () => {
		expect(truncateForLog("hello", 5)).toBe("hello");
	});

	it("truncates and adds suffix when over max", () => {
		const result = truncateForLog("hello world", 5);
		expect(result).toBe("hello...[truncated]");
	});

	it("handles empty string", () => {
		expect(truncateForLog("", 10)).toBe("");
	});

	it("handles maxLen of 0", () => {
		expect(truncateForLog("hello", 0)).toBe("...[truncated]");
	});
});

describe("sha256Hex16", () => {
	it("returns 16-char hex string", () => {
		const result = sha256Hex16("test");
		expect(result).toHaveLength(16);
		expect(result).toMatch(/^[0-9a-f]{16}$/);
	});

	it("is deterministic for same input", () => {
		expect(sha256Hex16("test")).toBe(sha256Hex16("test"));
	});

	it("differs for different inputs", () => {
		expect(sha256Hex16("a")).not.toBe(sha256Hex16("b"));
	});

	it("accepts Uint8Array", () => {
		const bytes = new TextEncoder().encode("test");
		expect(sha256Hex16(bytes)).toBe(sha256Hex16("test"));
	});

	it("handles empty string", () => {
		const result = sha256Hex16("");
		expect(result).toHaveLength(16);
	});
});

describe("stableMemoryId", () => {
	it("returns deterministic id for same content", () => {
		expect(stableMemoryId("hello")).toBe(stableMemoryId("hello"));
	});

	it("differs for different content", () => {
		expect(stableMemoryId("hello")).not.toBe(stableMemoryId("world"));
	});

	it("includes source in hash when provided", () => {
		expect(stableMemoryId("hello", "source1")).not.toBe(stableMemoryId("hello", "source2"));
	});

	it("differs with and without source", () => {
		expect(stableMemoryId("hello")).not.toBe(stableMemoryId("hello", "source"));
	});

	it("returns 16-char hex", () => {
		expect(stableMemoryId("test")).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("generateId", () => {
	it("returns 16-char hex string", () => {
		expect(generateId("test")).toMatch(/^[0-9a-f]{16}$/);
	});

	it("generates different ids for same content (nonce)", () => {
		const id1 = generateId("test");
		const id2 = generateId("test");
		expect(id1).not.toBe(id2);
	});

	it("generates different ids for different content", () => {
		expect(generateId("a")).not.toBe(generateId("b"));
	});
});

describe("parseIsoDateTimeUtc", () => {
	it("parses full ISO datetime", () => {
		const date = parseIsoDateTimeUtc("2024-01-15T10:30:00Z");
		expect(date.getTime()).toBe(Date.UTC(2024, 0, 15, 10, 30, 0));
	});

	it("parses date-only as midnight UTC", () => {
		const date = parseIsoDateTimeUtc("2024-01-15");
		expect(date.getTime()).toBe(Date.UTC(2024, 0, 15, 0, 0, 0));
	});

	it("parses datetime without timezone as UTC", () => {
		const date = parseIsoDateTimeUtc("2024-01-15T10:30:00");
		expect(date.getTime()).toBe(Date.UTC(2024, 0, 15, 10, 30, 0));
	});

	it("parses with timezone offset", () => {
		const date = parseIsoDateTimeUtc("2024-01-15T10:30:00+02:00");
		expect(date.getTime()).toBe(Date.UTC(2024, 0, 15, 8, 30, 0));
	});

	it("throws on empty string", () => {
		expect(() => parseIsoDateTimeUtc("")).toThrow(RangeError);
	});

	it("throws on whitespace-only string", () => {
		expect(() => parseIsoDateTimeUtc("   ")).toThrow(RangeError);
	});

	it("throws on invalid date", () => {
		expect(() => parseIsoDateTimeUtc("not-a-date")).toThrow(RangeError);
	});

	it("strips IXDTF zone bracket notation", () => {
		const date = parseIsoDateTimeUtc("2024-01-15T10:30:00Z[America/New_York]");
		expect(date.getTime()).toBe(Date.UTC(2024, 0, 15, 10, 30, 0));
	});
});

describe("normalizeDateTimeUtc", () => {
	it("returns a new Date with same time", () => {
		const original = new Date("2024-01-15T10:30:00Z");
		const result = normalizeDateTimeUtc(original);
		expect(result.getTime()).toBe(original.getTime());
		expect(result).not.toBe(original);
	});

	it("throws on invalid Date", () => {
		expect(() => normalizeDateTimeUtc(new Date("invalid"))).toThrow(RangeError);
	});
});

describe("parseQueryTime", () => {
	it("returns current time for null", () => {
		const before = Date.now();
		const result = parseQueryTime(null);
		const after = Date.now();
		expect(result.getTime()).toBeGreaterThanOrEqual(before);
		expect(result.getTime()).toBeLessThanOrEqual(after);
	});

	it("returns current time for undefined", () => {
		const before = Date.now();
		const result = parseQueryTime(undefined);
		const after = Date.now();
		expect(result.getTime()).toBeGreaterThanOrEqual(before);
		expect(result.getTime()).toBeLessThanOrEqual(after);
	});

	it("parses string as ISO datetime", () => {
		const result = parseQueryTime("2024-01-15T10:30:00Z");
		expect(result.getTime()).toBe(Date.UTC(2024, 0, 15, 10, 30, 0));
	});

	it("normalizes Date input", () => {
		const input = new Date("2024-01-15T10:30:00Z");
		const result = parseQueryTime(input);
		expect(result.getTime()).toBe(input.getTime());
	});
});

describe("parseTsFast", () => {
	it("returns undefined for empty string", () => {
		expect(parseTsFast("")).toBeUndefined();
	});

	it("parses valid timestamp", () => {
		const result = parseTsFast("2024-01-15T10:30:00Z");
		expect(result).toBeDefined();
		expect(result?.getTime()).toBe(Date.UTC(2024, 0, 15, 10, 30, 0));
	});

	it("returns undefined for invalid timestamp", () => {
		expect(parseTsFast("not-a-date")).toBeUndefined();
	});

	it("caches results", () => {
		const r1 = parseTsFast("2024-01-15T10:30:00Z");
		const r2 = parseTsFast("2024-01-15T10:30:00Z");
		expect(r1).toBe(r2);
	});
});

describe("toUtcIso", () => {
	it("returns ISO string for given date", () => {
		const date = new Date("2024-01-15T10:30:00Z");
		expect(toUtcIso(date)).toBe("2024-01-15T10:30:00.000Z");
	});

	it("returns ISO string for current time when no argument", () => {
		const result = toUtcIso();
		expect(() => new Date(result)).not.toThrow();
	});
});

describe("recencyDecay", () => {
	it("returns fallback for null timestamp", () => {
		expect(recencyDecay(null, 24, new Date(), 0.5)).toBe(0.5);
	});

	it("returns fallback for undefined timestamp", () => {
		expect(recencyDecay(undefined, 24, new Date(), 0.5)).toBe(0.5);
	});

	it("returns 1 for timestamp equal to now", () => {
		const now = new Date("2024-01-15T10:30:00Z");
		expect(recencyDecay(now, 24, now)).toBeCloseTo(1);
	});

	it("decays exponentially", () => {
		const now = new Date("2024-01-15T10:30:00Z");
		const ts = new Date(now.getTime() - 24 * HOUR_MS);
		expect(recencyDecay(ts, 24, now)).toBeCloseTo(Math.exp(-1));
	});

	it("returns fallback for invalid timestamp string", () => {
		expect(recencyDecay("invalid", 24, new Date(), 0.5)).toBe(0.5);
	});

	it("does not go above 1 for future timestamps", () => {
		const now = new Date("2024-01-15T10:30:00Z");
		const future = new Date(now.getTime() + 24 * HOUR_MS);
		expect(recencyDecay(future, 24, now)).toBeCloseTo(1);
	});
});

describe("temporalBoost", () => {
	it("returns 0 for invalid timestamp", () => {
		expect(temporalBoost("invalid")).toBe(0);
	});

	it("returns 1 for timestamp equal to query", () => {
		const ts = "2024-01-15T10:30:00Z";
		expect(temporalBoost(ts, ts)).toBeCloseTo(1);
	});

	it("decays with time difference", () => {
		const query = "2024-01-15T10:30:00Z";
		const queryDate = new Date(query);
		const ts = new Date(queryDate.getTime() - 24 * HOUR_MS).toISOString();
		expect(temporalBoost(ts, query, 24)).toBeCloseTo(Math.exp(-1));
	});

	it("clamps future timestamp to query time", () => {
		const query = "2024-01-15T10:30:00Z";
		const future = new Date(new Date(query).getTime() + 24 * HOUR_MS).toISOString();
		expect(temporalBoost(future, query)).toBeCloseTo(1);
	});
});
