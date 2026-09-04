/**
 * Spacer reserves N blank lines via `new Array(N)`, which throws RangeError for a
 * negative, fractional, NaN, or out-of-range N. Spacer is a public component, so
 * a consumer passing a computed height (e.g. `availableRows - usedRows` gone
 * negative) would crash the render. These assert the count is coerced to a safe
 * non-negative integer at both entry points, and that valid counts still work.
 */
import { describe, expect, it } from "bun:test";
import { Spacer } from "@veyyon/tui/components/spacer";

describe("Spacer", () => {
	it("renders exactly N blank lines for valid counts", () => {
		expect(new Spacer(0).render(10)).toEqual([]);
		expect(new Spacer(1).render(10)).toEqual([""]);
		expect(new Spacer(3).render(10)).toEqual(["", "", ""]);
		// Blank lines carry no width-dependent content.
		expect(new Spacer(2).render(0)).toEqual(["", ""]);
	});

	it("coerces adversarial line counts instead of throwing RangeError", () => {
		for (const bad of [-1, -0.5, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 1e12, -Infinity]) {
			let lines: readonly string[];
			expect(() => {
				lines = new Spacer(bad).render(10);
			}).not.toThrow();
			// Whatever the coercion, the result is a valid string array of blanks.
			lines = new Spacer(bad).render(10);
			expect(Array.isArray(lines)).toBe(true);
			for (const l of lines) expect(l).toBe("");
		}
		// Negative / fractional / NaN collapse to zero lines.
		expect(new Spacer(-5).render(10)).toEqual([]);
		expect(new Spacer(2.9).render(10)).toEqual(["", ""]); // truncated, not rounded
		expect(new Spacer(Number.NaN).render(10)).toEqual([]);
	});

	it("setLines coerces too and refreshes the cache on a real change", () => {
		const s = new Spacer(2);
		expect(s.render(10)).toEqual(["", ""]);
		expect(() => s.setLines(-3)).not.toThrow();
		expect(s.render(10)).toEqual([]); // clamped to 0
		s.setLines(4);
		expect(s.render(10)).toEqual(["", "", "", ""]);
	});
});
