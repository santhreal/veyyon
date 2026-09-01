// WHY: these are the numbers every tool renderer slices against, and they are edited by hand while
// tuning one surface. Two things break silently when a number moves. A collapsed limit that meets
// or passes its expanded partner makes the expand affordance a no-op: the row still says there is
// more to see and shows the same lines. A non-positive or fractional limit reaches
// `truncateToWidth` and blanks or mangles the content instead of shortening it. Neither shows up as
// an error, and neither is visible in the diff that caused it, because a limit is edited in
// isolation from the partner that gives it meaning.
//
// The relations are swept from the exported objects rather than listed, so a limit added to either
// table is checked for positivity without anyone remembering to come back here.
//
// This also pins the module's stated reason to exist: it is a leaf so a status-line segment can
// read a limit without pulling in the renderer graph, and `render-utils` re-exports it so nothing
// else changed. A second copy behind that barrel is the drift this catches.
//
// Not covered: whether any given number is the right number. That is a judgement about how a
// surface looks, and it belongs to the capture that shows the surface.

import { describe, expect, it } from "bun:test";
import { DEFAULT_TERMINAL_PREVIEW_LINES, PREVIEW_LIMITS, TRUNCATE_LENGTHS } from "../../src/tools/render-limits";
import * as renderUtils from "../../src/tools/render-utils";

describe("expanding a preview always shows more than collapsing it", () => {
	const pairs = [
		["COLLAPSED_LINES", "EXPANDED_LINES"],
		["OUTPUT_COLLAPSED", "OUTPUT_EXPANDED"],
	] as const;

	for (const [collapsed, expanded] of pairs) {
		it(`${collapsed} is strictly below ${expanded}`, () => {
			expect(PREVIEW_LIMITS[collapsed]).toBeLessThan(PREVIEW_LIMITS[expanded]);
		});
	}

	it("orders the truncation lengths from the tightest chip to the fullest line", () => {
		// Each name is picked by how much room the surface has, so the order is the meaning of the
		// names. A CHIP wider than a TITLE would let the footline chip outgrow a heading.
		const { CHIP, SHORT, TITLE, CONTENT, LONG, LINE } = TRUNCATE_LENGTHS;
		const ordered = [CHIP, SHORT, TITLE, CONTENT, LONG, LINE];
		expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
		expect(new Set(ordered).size).toBe(ordered.length);
	});

	it("keeps every limit a positive whole number", () => {
		// Swept, so a limit added later is covered without editing this test. Zero blanks the
		// content and a fraction slices between characters.
		const every = [
			...Object.entries(PREVIEW_LIMITS),
			...Object.entries(TRUNCATE_LENGTHS),
			["DEFAULT_TERMINAL_PREVIEW_LINES", DEFAULT_TERMINAL_PREVIEW_LINES] as const,
		];
		expect(every.length).toBeGreaterThan(0);
		for (const [name, value] of every) {
			expect(Number.isInteger(value), name).toBe(true);
			expect(value, name).toBeGreaterThan(0);
		}
	});

	it("gives the recap far more room than a footline chip", () => {
		// The recap is a sentence and the chip shares one row with five other segments; they are
		// the two extremes of the table and must not converge.
		expect(TRUNCATE_LENGTHS.RECAP).toBeGreaterThan(TRUNCATE_LENGTHS.LINE);
		expect(TRUNCATE_LENGTHS.CHIP).toBeLessThan(TRUNCATE_LENGTHS.SHORT);
	});

	it("is the one owner render-utils re-exports", () => {
		// Same object, not an equal copy: a second table would drift from the relations above.
		expect(renderUtils.PREVIEW_LIMITS).toBe(PREVIEW_LIMITS);
		expect(renderUtils.TRUNCATE_LENGTHS).toBe(TRUNCATE_LENGTHS);
		expect(renderUtils.DEFAULT_TERMINAL_PREVIEW_LINES).toBe(DEFAULT_TERMINAL_PREVIEW_LINES);
	});
});
