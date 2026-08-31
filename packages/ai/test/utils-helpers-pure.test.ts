import { describe, expect, it } from "bun:test";
import {
	normalizeResponsesToolCallId,
	normalizeSystemPrompts,
	normalizeToolCallId,
	resolveCacheRetention,
	truncateResponseItemId,
} from "../src/utils";

describe("normalizeSystemPrompts", () => {
	it("returns empty array for undefined", () => {
		expect(normalizeSystemPrompts(undefined)).toEqual([]);
	});
	it("returns empty array for null", () => {
		expect(normalizeSystemPrompts(null)).toEqual([]);
	});
	it("wraps single string in array", () => {
		expect(normalizeSystemPrompts("hello")).toEqual(["hello"]);
	});
	it("returns array as-is (well-formed)", () => {
		expect(normalizeSystemPrompts(["hello", "world"])).toEqual(["hello", "world"]);
	});
	it("filters out empty strings", () => {
		expect(normalizeSystemPrompts(["hello", "", "world"])).toEqual(["hello", "world"]);
	});
	it("filters out whitespace-only strings", () => {
		expect(normalizeSystemPrompts(["hello", "   ", "world"])).toEqual(["hello", "world"]);
	});
	it("returns empty array for non-string non-array", () => {
		expect(normalizeSystemPrompts(42 as unknown as string)).toEqual([]);
	});
});

describe("normalizeToolCallId", () => {
	it("returns alphanumeric id as-is", () => {
		expect(normalizeToolCallId("call_abc123")).toBe("call_abc123");
	});
	it("replaces special characters with underscore", () => {
		expect(normalizeToolCallId("call.abc!def")).toBe("call_abc_def");
	});
	it("preserves hyphens and underscores", () => {
		expect(normalizeToolCallId("call-abc_def")).toBe("call-abc_def");
	});
	it("truncates to 64 characters", () => {
		const long = "a".repeat(100);
		const result = normalizeToolCallId(long);
		expect(result.length).toBe(64);
	});
	it("does not truncate short ids", () => {
		expect(normalizeToolCallId("short")).toBe("short");
	});
	it("handles empty string", () => {
		expect(normalizeToolCallId("")).toBe("");
	});
});

describe("normalizeResponsesToolCallId", () => {
	it("splits callId|itemId format", () => {
		const result = normalizeResponsesToolCallId("call_abc|fc_xyz");
		expect(result.callId).toContain("abc");
		expect(result.itemId).toContain("xyz");
	});
	it("generates callId and itemId for plain id", () => {
		const result = normalizeResponsesToolCallId("plainid");
		expect(result.callId).toBeTruthy();
		expect(result.itemId).toBeTruthy();
		expect(result.itemId.startsWith("fc_")).toBe(true);
	});
	it("uses ctc prefix when specified", () => {
		const result = normalizeResponsesToolCallId("plainid", "ctc");
		expect(result.itemId.startsWith("ctc_")).toBe(true);
	});
	it("preserves call_ prefix", () => {
		const result = normalizeResponsesToolCallId("call_abc");
		expect(result.callId).toContain("call_");
		expect(result.callId).toContain("abc");
	});
});

describe("truncateResponseItemId", () => {
	it("returns short id as-is", () => {
		expect(truncateResponseItemId("short_id", "short")).toBe("short_id");
	});
	it("truncates long id with hash", () => {
		const long = "a".repeat(100);
		const result = truncateResponseItemId(long, "prefix");
		expect(result.length).toBeLessThan(64);
		expect(result.startsWith("prefix_")).toBe(true);
	});
	it("returns id of exactly 64 chars as-is", () => {
		const exact = "a".repeat(64);
		expect(truncateResponseItemId(exact, "prefix")).toBe(exact);
	});
});

describe("resolveCacheRetention", () => {
	it("returns provided value when set", () => {
		expect(resolveCacheRetention("long")).toBe("long");
		expect(resolveCacheRetention("short")).toBe("short");
	});
	it("returns short as default when no env var", () => {
		// VEYYON_CACHE_RETENTION is not set in test env
		expect(resolveCacheRetention(undefined)).toBe("short");
	});
});
