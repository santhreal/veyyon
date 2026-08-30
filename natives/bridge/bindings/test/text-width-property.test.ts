import { describe, expect, it } from "bun:test";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../native/index.js";

/**
 * Natives width properties over many ASCII and CJK strings.
 */

const TAB = 4;

describe("natives text width property-style", () => {
	it("visibleWidth of pure ASCII equals string length", () => {
		for (let n = 0; n <= 100; n++) {
			const s = "a".repeat(n);
			expect(visibleWidth(s, TAB)).toBe(n);
		}
	});

	it("truncateToWidth never exceeds budget for pure ASCII", () => {
		const s = "abcdefghijklmnopqrstuvwxyz";
		for (let w = 0; w <= 26; w++) {
			const out = truncateToWidth(s, w, null, false, TAB);
			expect(visibleWidth(out, TAB)).toBeLessThanOrEqual(w);
		}
	});

	it("truncate under budget is identity for pure ASCII", () => {
		for (const s of ["", "a", "hello", "abcdefghijklmnopqrstuvwxyz"]) {
			expect(truncateToWidth(s, 1000, null, false, TAB)).toBe(s);
		}
	});

	it("CJK triple ideograph is width 6 and truncates to budget", () => {
		expect(visibleWidth("日本語", TAB)).toBe(6);
		for (let w = 0; w <= 6; w++) {
			const out = truncateToWidth("日本語", w, null, false, TAB);
			expect(visibleWidth(out, TAB)).toBeLessThanOrEqual(w);
		}
	});

	it("wrapTextWithAnsi preserves all source characters for ASCII", () => {
		const src = "abcdefghijklmnopqrstuvwxyz0123456789";
		for (const width of [5, 10, 15, 20]) {
			const wrapped = wrapTextWithAnsi(src, width, TAB);
			const joined = wrapped.join("");
			for (const ch of src) {
				expect(joined.includes(ch)).toBe(true);
			}
		}
	});
});
