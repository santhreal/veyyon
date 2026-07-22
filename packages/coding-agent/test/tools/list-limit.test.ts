import { describe, expect, it } from "bun:test";
import { applyListLimit } from "@veyyon/coding-agent/tools/list-limit";

/**
 * Locks applyListLimit truncation metadata: hosts and renderers depend on
 * exact `reached` / `suggestion` numbers and which meta key is set (match vs
 * result). Wrong meta makes UIs claim "showing all" when results were cut.
 */
describe("applyListLimit", () => {
	const items = ["a", "b", "c", "d", "e"];

	it("returns all items unchanged when no limits are set", () => {
		const result = applyListLimit(items, {});
		expect(result.items).toEqual(items);
		expect(result.limitReached).toBeUndefined();
		expect(result.meta).toEqual({});
	});

	it("treats non-positive limit and headLimit as absent", () => {
		expect(applyListLimit(items, { limit: 0 }).items).toEqual(items);
		expect(applyListLimit(items, { limit: -3 }).items).toEqual(items);
		expect(applyListLimit(items, { headLimit: 0 }).items).toEqual(items);
		expect(applyListLimit(items, { headLimit: -1 }).meta).toEqual({});
	});

	it("slices at limit and sets resultLimit meta with 2x suggestion", () => {
		const result = applyListLimit(items, { limit: 3 });
		expect(result.items).toEqual(["a", "b", "c"]);
		expect(result.limitReached).toBe(3);
		expect(result.meta).toEqual({
			resultLimit: { reached: 3, suggestion: 6 },
		});
	});

	it("uses matchLimit meta when limitType is match", () => {
		const result = applyListLimit(items, { limit: 2, limitType: "match" });
		expect(result.items).toEqual(["a", "b"]);
		expect(result.limitReached).toBe(2);
		expect(result.meta).toEqual({
			matchLimit: { reached: 2, suggestion: 4 },
		});
		expect(result.meta.resultLimit).toBeUndefined();
	});

	it("applies limit first then headLimit on the already-sliced list", () => {
		// limit 4 → a,b,c,d; headLimit 2 → a,b with both metas set.
		const result = applyListLimit(items, { limit: 4, headLimit: 2 });
		expect(result.items).toEqual(["a", "b"]);
		expect(result.limitReached).toBe(4);
		expect(result.meta).toEqual({
			resultLimit: { reached: 4, suggestion: 8 },
			headLimit: { reached: 2, suggestion: 4 },
		});
	});

	it("headLimit alone truncates without setting limitReached", () => {
		const result = applyListLimit(items, { headLimit: 2 });
		expect(result.items).toEqual(["a", "b"]);
		expect(result.limitReached).toBeUndefined();
		expect(result.meta).toEqual({
			headLimit: { reached: 2, suggestion: 4 },
		});
	});

	it("does not mark limitReached when length is strictly below limit", () => {
		const result = applyListLimit(["x", "y"], { limit: 5 });
		expect(result.items).toEqual(["x", "y"]);
		expect(result.limitReached).toBeUndefined();
		expect(result.meta).toEqual({});
	});

	it("marks limitReached when length equals limit (inclusive ceiling)", () => {
		// Contract: `>= limit` fires so "exactly N matches" still reports the cap.
		const result = applyListLimit(["a", "b", "c"], { limit: 3 });
		expect(result.items).toEqual(["a", "b", "c"]);
		expect(result.limitReached).toBe(3);
		expect(result.meta.resultLimit).toEqual({ reached: 3, suggestion: 6 });
	});

	it("empty input stays empty under any limit combination", () => {
		const result = applyListLimit([], { limit: 10, headLimit: 5, limitType: "match" });
		expect(result.items).toEqual([]);
		expect(result.limitReached).toBeUndefined();
		expect(result.meta).toEqual({});
	});
});
