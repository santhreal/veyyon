/**
 * applyListLimit property: limit fires at length>=limit (inclusive);
 * headLimit only when limited.length > headLimit; suggestion always 2x;
 * limitType match vs result meta keys.
 */
import { describe, expect, it } from "bun:test";
import { applyListLimit } from "@veyyon/coding-agent/tools/list-limit";

describe("applyListLimit head/limit interaction property", () => {
	for (const n of [0, 1, 2, 5, 10]) {
		for (const limit of [undefined, 0, -1, 1, 3, 5, 10, 20]) {
			for (const head of [undefined, 0, -1, 1, 2, 5]) {
				it(`n=${n} limit=${limit} head=${head}`, () => {
					const items = Array.from({ length: n }, (_, i) => i);
					const r = applyListLimit(items, {
						limit: limit as number | undefined,
						headLimit: head as number | undefined,
					});
					const effectiveLimit =
						limit !== undefined && limit > 0 ? limit : undefined;
					const effectiveHead =
						head !== undefined && head > 0 ? head : undefined;

					let expected = items;
					let limitReached: number | undefined;
					if (effectiveLimit !== undefined && n >= effectiveLimit) {
						expected = items.slice(0, effectiveLimit);
						limitReached = effectiveLimit;
					}
					if (effectiveHead !== undefined && expected.length > effectiveHead) {
						expected = expected.slice(0, effectiveHead);
					}
					expect(r.items).toEqual(expected);
					expect(r.limitReached).toBe(limitReached);

					if (limitReached !== undefined) {
						expect(r.meta.resultLimit).toEqual({
							reached: limitReached,
							suggestion: limitReached * 2,
						});
					} else {
						expect(r.meta.resultLimit).toBeUndefined();
					}
					if (
						effectiveHead !== undefined &&
						(limitReached !== undefined
							? Math.min(n, limitReached)
							: n) > effectiveHead
					) {
						expect(r.meta.headLimit).toEqual({
							reached: effectiveHead,
							suggestion: effectiveHead * 2,
						});
					}
				});
			}
		}
	}

	it("match limitType writes matchLimit", () => {
		const r = applyListLimit(["a", "b", "c", "d"], { limit: 2, limitType: "match" });
		expect(r.meta.matchLimit).toEqual({ reached: 2, suggestion: 4 });
		expect(r.meta.resultLimit).toBeUndefined();
	});
});
