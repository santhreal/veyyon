import { describe, expect, it } from "bun:test";
import { applyListLimit } from "@veyyon/coding-agent/tools/list-limit";

/**
 * applyListLimit exact truncation, meta, and boundary contracts.
 */

describe("applyListLimit adversarial", () => {
	it("returns all items when under limit", () => {
		const items = ["a", "b", "c"];
		const result = applyListLimit(items, { limit: 10 });
		expect(result.items).toEqual(["a", "b", "c"]);
		expect(result.limitReached ?? null).toBeNull();
	});

	it("truncates to exact limit and reports limitReached", () => {
		const items = Array.from({ length: 20 }, (_, i) => `i${i}`);
		const result = applyListLimit(items, { limit: 5 });
		expect(result.items).toEqual(["i0", "i1", "i2", "i3", "i4"]);
		expect(result.limitReached).toBe(5);
	});

	it("limit 0 is treated as unlimited (only positive limits bind)", () => {
		// applyListLimit only applies limit when limit > 0.
		const result = applyListLimit(["a", "b"], { limit: 0 });
		expect(result.items).toEqual(["a", "b"]);
		expect(result.limitReached ?? null).toBeNull();
	});

	it("headLimit further trims after limit", () => {
		const items = ["a", "b", "c", "d", "e"];
		const result = applyListLimit(items, { limit: 4, headLimit: 2 });
		expect(result.items).toEqual(["a", "b"]);
		expect(result.meta.headLimit?.reached).toBe(2);
	});

	it("limit 1 keeps only the first item", () => {
		const result = applyListLimit(["first", "second"], { limit: 1 });
		expect(result.items).toEqual(["first"]);
		expect(result.limitReached).toBe(1);
	});

	it("empty input stays empty with no limitReached", () => {
		const result = applyListLimit([], { limit: 5 });
		expect(result.items).toEqual([]);
		expect(result.limitReached ?? null).toBeNull();
	});

	it("does not mutate the original array", () => {
		const items = ["a", "b", "c", "d"];
		const snapshot = [...items];
		applyListLimit(items, { limit: 2 });
		expect(items).toEqual(snapshot);
	});

	it("preserves object identity of kept item references", () => {
		const a = { id: 1 };
		const b = { id: 2 };
		const result = applyListLimit([a, b], { limit: 1 });
		expect(result.items[0]).toBe(a);
	});
});
