/**
 * applyListLimit stacking limit then headLimit exact meta.
 */
import { describe, expect, it } from "bun:test";
import { applyListLimit } from "../src/tools/list-limit";

describe("applyListLimit stack limit+head", () => {
	it("limit 5 head 2 on 6 items", () => {
		const items = ["a", "b", "c", "d", "e", "f"];
		const r = applyListLimit(items, { limit: 5, headLimit: 2 });
		expect(r.items).toEqual(["a", "b"]);
		expect(r.limitReached).toBe(5);
		expect(r.meta.resultLimit?.reached).toBe(5);
		expect(r.meta.headLimit?.reached).toBe(2);
	});

	it("match limitType stacks matchLimit", () => {
		const r = applyListLimit([1, 2, 3, 4, 5, 6], {
			limit: 5,
			limitType: "match",
			headLimit: 2,
		});
		expect(r.items).toEqual([1, 2]);
		expect(r.meta.matchLimit?.reached).toBe(5);
		expect(r.meta.resultLimit).toBeUndefined();
		expect(r.meta.headLimit?.reached).toBe(2);
	});

	it("limit alone without head", () => {
		const r = applyListLimit(["x", "y", "z"], { limit: 2 });
		expect(r.items).toEqual(["x", "y"]);
		expect(r.meta.headLimit).toBeUndefined();
	});
});
