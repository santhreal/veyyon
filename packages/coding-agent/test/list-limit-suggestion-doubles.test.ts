/**
 * applyListLimit meta suggestion is 2× reached for result and head limits.
 */
import { describe, expect, it } from "bun:test";
import { applyListLimit } from "../src/tools/list-limit";

describe("applyListLimit suggestion doubles reached", () => {
	it("resultLimit suggestion", () => {
		const r = applyListLimit([1, 2, 3, 4], { limit: 2 });
		expect(r.meta.resultLimit?.reached).toBe(2);
		expect(r.meta.resultLimit?.suggestion).toBe(4);
	});

	it("headLimit suggestion", () => {
		const r = applyListLimit([1, 2, 3, 4], { headLimit: 3 });
		expect(r.meta.headLimit?.reached).toBe(3);
		expect(r.meta.headLimit?.suggestion).toBe(6);
	});

	it("matchLimit suggestion", () => {
		const r = applyListLimit([1, 2, 3], { limit: 3, limitType: "match" });
		expect(r.meta.matchLimit?.reached).toBe(3);
		expect(r.meta.matchLimit?.suggestion).toBe(6);
	});
});
