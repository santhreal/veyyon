/**
 * WHY THIS EXISTS.
 *
 * A diff row is a gutter and a body: `-315│const x = 1`. Wrapped the way prose wraps, the tail of a
 * long line lands back in the gutter column, where it reads as one more changed line instead of the
 * rest of the line above it. The terminal owns the break, because the width is the terminal's.
 *
 * The class this closes is every gutter shape the diff renderer produces reaching a narrow window:
 * the numbered `│` forms, the deduplicated forms whose repeated number is blanked, the canonical
 * ASCII `|` form, and the marker-only row of a change computed before the edit landed. A fix that
 * handled one of them and dropped the rest is the defect, so each shape is asserted here, together
 * with the two negatives -- a body that merely starts with `|`, and error text like `123|…` -- that
 * must keep wrapping as prose.
 *
 * WHAT IT DOES NOT CATCH. Where the wrap points fall inside the body: that is the shared ANSI
 * wrapper's, and this suite asserts the gutter and the preserved content rather than the column of
 * each break. It also says nothing about the colours the row arrives in.
 */

import { describe, expect, it } from "bun:test";
import { wrapDiffRow } from "@veyyon/coding-agent/modes/terminal/draw/wrap-diff-row";
import { stripAnsi } from "@veyyon/utils/strip-ansi";

/** Every row's visible text, which is what a reader sees. */
const visible = (rows: readonly string[]): string[] => rows.map(row => stripAnsi(row));

/** The body of each row with its gutter removed, joined without the spaces the wrap consumed. */
const packedBody = (rows: readonly string[], gutterWidth: number): string =>
	visible(rows)
		.map(row => row.slice(gutterWidth))
		.join("")
		.replaceAll(" ", "");

describe("a wrapped diff row opens in a blank gutter", () => {
	it("keeps the number on the first row and blanks it on every row after", () => {
		const rows = wrapDiffRow("-315│alpha beta gamma delta", 12);
		const seen = visible(rows);

		expect(seen.length).toBeGreaterThan(1);
		expect(seen[0]?.startsWith("-315│")).toBe(true);
		for (const row of seen.slice(1)) expect(row.startsWith("    │")).toBe(true);
		expect(packedBody(rows, 5)).toBe("alphabetagammadelta");
	});

	it("keeps a deduplicated gutter's width when its number is already blank", () => {
		const rows = wrapDiffRow("   +│alpha beta gamma delta", 12);
		const seen = visible(rows);

		expect(seen.length).toBeGreaterThan(1);
		expect(seen[0]?.startsWith("   +│")).toBe(true);
		for (const row of seen.slice(1)) expect(row.startsWith("    │")).toBe(true);
	});

	it("wraps the canonical ascii gutter into a gutter of the same width", () => {
		const rows = wrapDiffRow("-42|alpha beta gamma delta", 11);
		const seen = visible(rows);

		expect(seen.length).toBeGreaterThan(1);
		expect(seen[0]?.startsWith("-42|")).toBe(true);
		for (const row of seen.slice(1)) expect(row.startsWith("   |")).toBe(true);
		expect(packedBody(rows, 4)).toBe("alphabetagammadelta");
	});

	it("indents a marker-only row by one column so its tail is not a second change", () => {
		const rows = wrapDiffRow("+alpha beta gamma delta", 10);
		const seen = visible(rows);

		expect(seen.length).toBeGreaterThan(1);
		expect(seen[0]?.startsWith("+")).toBe(true);
		for (const row of seen.slice(1)) {
			expect(row.startsWith(" ")).toBe(true);
			expect(row.startsWith("+")).toBe(false);
		}
	});

	it("closes inverse video on every row it emits", () => {
		const rows = wrapDiffRow("-315│alpha beta gamma delta", 12);

		for (const row of rows) expect(row.endsWith("\x1b[27m\x1b[39m")).toBe(true);
	});

	it("wraps a body that merely starts with a pipe as prose", () => {
		const rows = wrapDiffRow("|alpha beta gamma delta", 10);

		for (const row of rows) expect(row.includes("\x1b[27m")).toBe(false);
		expect(visible(rows).some(row => row.startsWith(" |"))).toBe(false);
	});

	it("wraps numbered error text as prose, because a diff row carries a marker column", () => {
		const rows = wrapDiffRow("123|alpha beta gamma delta", 10);

		for (const row of rows) expect(row.includes("\x1b[27m")).toBe(false);
	});

	it("returns the row untouched when there is no width to wrap into", () => {
		expect(wrapDiffRow("-315│alpha beta", 0)).toEqual(["-315│alpha beta"]);
		expect(wrapDiffRow("", 40)).toEqual([""]);
	});
});
