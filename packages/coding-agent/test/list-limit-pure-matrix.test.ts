/**
 * applyListLimit pure matrix: exact items, limitReached, meta keys.
 */
import { describe, expect, it } from "bun:test";
import { applyListLimit } from "../src/tools/list-limit";

describe("applyListLimit pure matrix", () => {
	it("no options returns all", () => {
		const r = applyListLimit(["a", "b", "c"], {});
		expect(r.items).toEqual(["a", "b", "c"]);
		expect(r.limitReached).toBeUndefined();
		expect(r.meta).toEqual({});
	});

	it("limit equal length marks limitReached", () => {
		const r = applyListLimit([1, 2, 3], { limit: 3 });
		expect(r.items).toEqual([1, 2, 3]);
		expect(r.limitReached).toBe(3);
		expect(r.meta.resultLimit?.reached).toBe(3);
	});

	it("limit below length truncates", () => {
		const r = applyListLimit(["a", "b", "c", "d"], { limit: 2 });
		expect(r.items).toEqual(["a", "b"]);
		expect(r.limitReached).toBe(2);
	});

	it("headLimit truncates without limitReached", () => {
		const r = applyListLimit(["a", "b", "c"], { headLimit: 1 });
		expect(r.items).toEqual(["a"]);
		expect(r.limitReached).toBeUndefined();
		expect(r.meta.headLimit?.reached).toBe(1);
	});

	it("limitType match writes matchLimit", () => {
		const r = applyListLimit([1, 2, 3], { limit: 3, limitType: "match" });
		expect(r.meta.matchLimit?.reached).toBe(3);
		expect(r.meta.resultLimit).toBeUndefined();
	});

	it("non-positive limits ignored", () => {
		const r = applyListLimit(["a", "b"], { limit: 0, headLimit: -1 });
		expect(r.items).toEqual(["a", "b"]);
		expect(r.meta).toEqual({});
	});

	it("empty items", () => {
		const r = applyListLimit([], { limit: 10 });
		expect(r.items).toEqual([]);
		expect(r.meta).toEqual({});
	});
});
