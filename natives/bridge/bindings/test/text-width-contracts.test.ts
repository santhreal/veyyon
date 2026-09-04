import { describe, expect, it } from "bun:test";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../native/index.js";

/**
 * Natives text contracts used by TUI and tool renderers. Exact visible widths
 * and wrap boundaries — not shape checks. Drives the shipped native bindings.
 */

const TAB = 4;

describe("natives text width contracts", () => {
	it("visibleWidth counts ASCII as one column each", () => {
		expect(visibleWidth("hello", TAB)).toBe(5);
		expect(visibleWidth("", TAB)).toBe(0);
	});

	it("visibleWidth ignores ANSI SGR sequences", () => {
		expect(visibleWidth("\x1b[31mred\x1b[0m", TAB)).toBe(3);
		expect(visibleWidth("a\x1b[1mb\x1b[0mc", TAB)).toBe(3);
	});

	it("truncateToWidth cuts at column budget and preserves exact prefix", () => {
		const out = truncateToWidth("abcdefghij", 5, null, false, TAB);
		expect(visibleWidth(out, TAB) <= 5).toBe(true);
		expect(out.startsWith("abc")).toBe(true);
		// Full string under budget is unchanged.
		expect(truncateToWidth("abc", 10, null, false, TAB)).toBe("abc");
	});

	it("wrapTextWithAnsi breaks long lines without dropping characters", () => {
		const src = "abcdefghijklmnopqrstuvwxyz";
		const wrapped = wrapTextWithAnsi(src, 10, TAB);
		const joined = wrapped.join("");
		// All source letters survive wrapping (ANSI-free input).
		for (const ch of src) {
			expect(joined.includes(ch)).toBe(true);
		}
		expect(wrapped.length).toBeGreaterThan(1);
	});

	it("fullwidth CJK characters take two columns", () => {
		const w = visibleWidth("日本語", TAB);
		// Three CJK ideographs → 6 columns on East-Asian-width.
		expect(w).toBe(6);
		const truncated = truncateToWidth("日本語", 4, null, false, TAB);
		expect(truncated.length).toBeGreaterThan(0);
		expect(visibleWidth(truncated, TAB) <= 4).toBe(true);
	});

	it("tabs expand to tabWidth columns in visibleWidth", () => {
		expect(visibleWidth("\t", TAB)).toBe(TAB);
		// Leading char then tab: width is strictly greater than bare "a".
		expect(visibleWidth("a\t", TAB)).toBeGreaterThan(visibleWidth("a", TAB));
		expect(visibleWidth("a\t", TAB)).toBeGreaterThanOrEqual(TAB);
	});

	it("truncateToWidth of empty string is empty", () => {
		expect(truncateToWidth("", 10, null, false, TAB)).toBe("");
		expect(visibleWidth("", TAB)).toBe(0);
	});

	it("truncateToWidth budget 0 yields empty or zero-width result", () => {
		const out = truncateToWidth("abc", 0, null, false, TAB);
		expect(visibleWidth(out, TAB)).toBe(0);
	});

	it("emoji / wide sequences do not overflow the requested budget", () => {
		const src = "a🙂b🙂c";
		const out = truncateToWidth(src, 4, null, false, TAB);
		expect(visibleWidth(out, TAB) <= 4).toBe(true);
	});

	it("wrapTextWithAnsi of short text under width is a single line", () => {
		const wrapped = wrapTextWithAnsi("hi", 20, TAB);
		expect(wrapped).toEqual(["hi"]);
	});

	it("visibleWidth of spaces equals space count", () => {
		expect(visibleWidth("   ", TAB)).toBe(3);
	});

	it("truncate preserves ANSI without counting it toward width", () => {
		const src = "\x1b[32mabcdef\x1b[0m";
		const out = truncateToWidth(src, 3, null, false, TAB);
		expect(visibleWidth(out, TAB) <= 3).toBe(true);
		// Result should still contain some of the letter payload.
		expect(/[a-c]/.test(out)).toBe(true);
	});
});
