import { describe, expect, it } from "bun:test";
import { applyResultLimit, sanitizeResultLimit } from "../../src/web/search/utils";

/**
 * applyResultLimit is the single owner of "apply a caller-supplied result limit
 * to a source list" for the no-default web-search providers (anthropic, codex,
 * jina, synthetic). Before it existed, those four providers each re-expressed
 * the same rule inline (two as a `undefined ? all : slice` ternary that always
 * copied, two as a length-guarded `if`), free to drift. This suite locks the
 * unified behavior so a future edit to one provider cannot silently change how
 * another caps its results.
 *
 * Contracts, all delegated to {@link sanitizeResultLimit} for the value:
 *   - no cap (undefined / NaN / Infinity / zero / negative / below one) returns
 *     the WHOLE list, and returns the SAME array reference (no needless copy);
 *   - a list already within the cap is returned unchanged (same reference too);
 *   - a list longer than the cap is sliced from the FRONT to exactly `limit`;
 *   - a fractional limit is floored (matching sanitizeResultLimit);
 *   - a negative limit does NOT reach `slice(0, negative)` (which would drop from
 *     the END): it is treated as "no cap" and returns everything.
 */

const list = () => ["a", "b", "c", "d", "e"];

describe("applyResultLimit", () => {
	it("returns the whole list, same reference, when the limit is undefined", () => {
		const input = list();
		const out = applyResultLimit(input, undefined);
		expect(out).toBe(input);
		expect(out).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("returns the same reference when the list is already within the cap", () => {
		const input = list();
		const out = applyResultLimit(input, 5);
		expect(out).toBe(input);
	});

	it("returns the same reference when the cap exceeds the list length", () => {
		const input = list();
		const out = applyResultLimit(input, 99);
		expect(out).toBe(input);
	});

	it("slices from the front to exactly the limit when the list is longer", () => {
		const input = list();
		const out = applyResultLimit(input, 2);
		expect(out).toEqual(["a", "b"]);
		expect(out).not.toBe(input);
	});

	it("floors a fractional limit before slicing", () => {
		expect(applyResultLimit(list(), 2.9)).toEqual(["a", "b"]);
	});

	it("treats a negative limit as no cap and returns everything", () => {
		// The bug sanitizeResultLimit closes: slice(0, -1) would drop the LAST
		// element. A negative limit must mean "no explicit cap" instead.
		const input = list();
		const out = applyResultLimit(input, -1);
		expect(out).toBe(input);
		expect(out).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("treats zero as no cap (returns everything, not an empty list)", () => {
		expect(applyResultLimit(list(), 0)).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("treats NaN and Infinity as no cap", () => {
		expect(applyResultLimit(list(), Number.NaN)).toEqual(["a", "b", "c", "d", "e"]);
		expect(applyResultLimit(list(), Number.POSITIVE_INFINITY)).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("handles an empty list without slicing", () => {
		const input: string[] = [];
		expect(applyResultLimit(input, 3)).toBe(input);
	});

	it("agrees with sanitizeResultLimit on the cap boundary", () => {
		// A limit of exactly the list length is within-cap (same reference); one
		// less slices. This pins the `<=` boundary against `sanitizeResultLimit`.
		expect(sanitizeResultLimit(5)).toBe(5);
		expect(applyResultLimit(list(), 5)).toEqual(["a", "b", "c", "d", "e"]);
		expect(applyResultLimit(list(), 4)).toEqual(["a", "b", "c", "d"]);
	});
});
