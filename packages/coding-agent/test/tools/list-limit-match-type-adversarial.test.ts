import { describe, expect, it } from "bun:test";
import { applyListLimit } from "@veyyon/coding-agent/tools/list-limit";

/**
 * applyListLimit limitType match vs result meta fields.
 */

describe("applyListLimit limitType meta", () => {
	it("limitType result populates resultLimit meta when truncated", () => {
		const items = Array.from({ length: 10 }, (_, i) => i);
		const result = applyListLimit(items, { limit: 3, limitType: "result" });
		expect(result.items).toEqual([0, 1, 2]);
		expect(result.limitReached).toBe(3);
		expect(result.meta.resultLimit?.reached).toBe(3);
		expect(result.meta.matchLimit).toBeUndefined();
	});

	it("limitType match populates matchLimit meta when truncated", () => {
		const items = Array.from({ length: 10 }, (_, i) => i);
		const result = applyListLimit(items, { limit: 4, limitType: "match" });
		expect(result.items).toEqual([0, 1, 2, 3]);
		expect(result.meta.matchLimit?.reached).toBe(4);
		expect(result.meta.resultLimit).toBeUndefined();
	});

	it("under limit leaves both meta limit fields empty", () => {
		const result = applyListLimit([1, 2], { limit: 10, limitType: "match" });
		expect(result.items).toEqual([1, 2]);
		expect(result.meta.matchLimit).toBeUndefined();
		expect(result.meta.resultLimit).toBeUndefined();
	});
});
