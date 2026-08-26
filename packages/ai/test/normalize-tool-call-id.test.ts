import { describe, expect, it } from "bun:test";
import { normalizeToolCallId } from "../src/utils";

describe("normalizeToolCallId", () => {
	it("returns the same reference for already-safe IDs within the length limit", () => {
		const id = "call_abc-123_def";
		expect(normalizeToolCallId(id)).toBe(id);
	});

	it("returns the same reference for a short alphanumeric ID", () => {
		const id = "abc123";
		expect(normalizeToolCallId(id)).toBe(id);
	});

	it("replaces unsafe characters with underscores", () => {
		expect(normalizeToolCallId("call.abc!def")).toBe("call_abc_def");
	});

	it("replaces spaces with underscores", () => {
		expect(normalizeToolCallId("call abc def")).toBe("call_abc_def");
	});

	it("truncates IDs longer than 64 characters", () => {
		const long = "a".repeat(80);
		const result = normalizeToolCallId(long);
		expect(result.length).toBe(64);
		expect(result).toBe("a".repeat(64));
	});

	it("preserves IDs with underscores and hyphens", () => {
		const id = "call_abc-123";
		expect(normalizeToolCallId(id)).toBe(id);
	});

	it("handles empty string", () => {
		expect(normalizeToolCallId("")).toBe("");
	});

	it("sanitizes special chars in IDs that do not exceed 64 chars", () => {
		const long = `${"a".repeat(60)}.!`;
		const result = normalizeToolCallId(long);
		expect(result.length).toBe(62);
		expect(result).toBe(`${"a".repeat(60)}__`);
	});
});
