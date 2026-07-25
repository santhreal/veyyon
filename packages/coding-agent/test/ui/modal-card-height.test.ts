/**
 * How tall a modal card is.
 *
 * The card used to be exactly the height the vertical margins allowed, whatever
 * it had to put in it. A seven-row version list on a 40-row terminal therefore
 * painted seven rows of content above roughly ten blank rows inside the same
 * border, which reads as a list that failed to load the rest rather than as a
 * list that is simply short. It is shared chrome, so every picker in the product
 * inherited it.
 *
 * The fix is a caller-supplied `preferredBodyRows`, and the two properties worth
 * locking pull against each other:
 *
 *   - The card shrinks to the content, so short lists stop looking broken.
 *   - It shrinks to the content the CALLER names, not to the rows currently
 *     drawn. Sizing to the live body would resize the card on every filter
 *     keystroke, which is a worse defect than the empty space it fixes.
 *
 * Plus the invariants a height change is most likely to break silently: the
 * bottom border must survive, the geometry the mouse hit-tests with must match
 * the rows actually painted, and a caller that asks for nothing must get exactly
 * the card it got before.
 */
import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	computeModalDims,
	MODAL_SIZING_MEDIUM,
	type ModalShellInput,
	minModalChromeRows,
	renderModalShell,
	SELECT_LIST_SHORTCUTS,
} from "@veyyon/coding-agent/modes/components/modal-shell";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

await initTheme(false, "unicode", false, "titanium", "titanium");

const AREA_WIDTH = 100;
const AREA_HEIGHT = 40;

function shell(overrides: Partial<ModalShellInput> = {}) {
	return renderModalShell({
		title: "Version",
		sizing: MODAL_SIZING_MEDIUM,
		areaWidth: AREA_WIDTH,
		areaHeight: AREA_HEIGHT,
		body: Array.from({ length: 7 }, (_, i) => `1.${i}.0`),
		shortcuts: SELECT_LIST_SHORTCUTS,
		...overrides,
	});
}

/**
 * The card itself: the frame rows it occupies, cropped to its columns.
 *
 * Each frame line is a full-width screen row, so it carries the left pad before
 * the border. Cropping matters: without it every row starts with twenty spaces
 * and a test for "this row is blank" quietly matches nothing.
 */
function cardRows(result: ReturnType<typeof renderModalShell>): string[] {
	const geo = result.geometry;
	if (!geo) throw new Error("expected geometry");
	return result.lines
		.slice(geo.cardRowStart, geo.cardRowEnd)
		.map(line => stripVTControlCharacters(line).slice(geo.cardColStart, geo.cardColEnd).trimEnd());
}

describe("without preferredBodyRows", () => {
	it("keeps the full-height card, so nothing changes for a caller that says nothing", () => {
		// The option is opt-in. Every existing surface renders exactly as before.
		const dims = computeModalDims(AREA_WIDTH, AREA_HEIGHT, MODAL_SIZING_MEDIUM);

		expect(shell().geometry?.modalHeight).toBe(dims!.modalHeight);
	});

	it("pads the short body out to that height", () => {
		const rows = cardRows(shell());
		// A blank card row is still bordered, so "empty" means nothing between the
		// two vertical rules rather than an empty string.
		const blanks = rows.filter(line => /^[│|]\s*[│|]$/.test(line)).length;

		// The exact defect being fixed: seven rows of content, and the card is
		// still 32 rows tall, so most of it is empty.
		expect(rows.length).toBe(MODAL_SIZING_MEDIUM ? 40 - 2 * MODAL_SIZING_MEDIUM.vMargin : 0);
		expect(blanks).toBeGreaterThan(10);
	});
});

describe("with preferredBodyRows", () => {
	it("draws a card sized for the rows asked for", () => {
		const full = shell().geometry!.modalHeight;
		const sized = shell({ preferredBodyRows: 7 }).geometry!.modalHeight;

		expect(sized).toBeLessThan(full);
		// Chrome is the top border, a vPad row above AND below the body, the footer
		// divider, the two footer lines and the bottom border, around seven rows of
		// content. `minModalChromeRows` owns that sum; restating it here would be
		// the second copy the shell's own doc warns about.
		expect(sized).toBe(7 + minModalChromeRows(MODAL_SIZING_MEDIUM));
	});

	it("leaves no blank filler below the content", () => {
		// This is what the operator actually sees, and the reason the row count
		// above matters at all.
		const rows = cardRows(shell({ preferredBodyRows: 7 }));
		const bodyStart = 1 + MODAL_SIZING_MEDIUM.vPad;

		for (let i = bodyStart; i < bodyStart + 7; i++) expect(rows[i]).toContain("1.");
	});

	it("still paints the bottom border", () => {
		// A height change that sheared the frame would be invisible in a row count
		// and obvious on screen.
		const rows = cardRows(shell({ preferredBodyRows: 7 }));

		expect(rows.at(-1)).toMatch(/[└┘─]/);
	});

	it("re-centres the smaller card instead of leaving it high", () => {
		const full = shell().geometry!;
		const sized = shell({ preferredBodyRows: 7 }).geometry!;

		expect(sized.topPad).toBeGreaterThan(full.topPad);
		expect(sized.topPad * 2 + sized.modalHeight).toBeLessThanOrEqual(AREA_HEIGHT + 1);
	});

	it("reports geometry that matches the rows it painted", () => {
		// The mouse hit-tests against this geometry. If it described the old,
		// taller card, clicks would land one row off everywhere below the body.
		const result = shell({ preferredBodyRows: 7 });
		const geo = result.geometry!;

		expect(geo.cardRowEnd - geo.cardRowStart).toBe(geo.modalHeight);
		expect(geo.bodyRowCount).toBe(7);
		expect(stripVTControlCharacters(result.lines[geo.bodyRowStart]!)).toContain("1.0.0");
		expect(result.lines.length).toBe(AREA_HEIGHT);
	});

	it("never grows the card past what the terminal allows", () => {
		// A caller may honestly want 200 rows. The margins still win.
		const capped = shell({ preferredBodyRows: 200 }).geometry!;

		expect(capped.modalHeight).toBe(shell().geometry!.modalHeight);
	});

	it("keeps a body row even when asked for none", () => {
		// A zero-row card would be a border with a footer in it and no way to see
		// that the list is empty.
		const geo = shell({ preferredBodyRows: 0, body: [] }).geometry!;

		expect(geo.bodyRowCount).toBeGreaterThanOrEqual(1);
	});

	it("does not shrink when the body it is given is shorter than the request", () => {
		// The whole point of the caller naming a number: a filtered list draws two
		// rows this frame and the card must not jump to two rows tall.
		const geo = shell({ preferredBodyRows: 7, body: ["1.5.0", "1.5.1"] }).geometry!;

		expect(geo.bodyRowCount).toBe(7);
	});
});

describe("on a terminal too short for the request", () => {
	it("still drops the droppable chrome first", () => {
		// The shrink order (tip gap, tip, vPad, reserved footer padding) is what
		// keeps the bottom border on a 24-row terminal, and asking for a body
		// height must not route around it.
		const tight = renderModalShell({
			title: "Version",
			sizing: MODAL_SIZING_MEDIUM,
			areaWidth: AREA_WIDTH,
			areaHeight: 16,
			body: Array.from({ length: 12 }, (_, i) => `1.${i}.0`),
			preferredBodyRows: 12,
			tipCandidates: ["a tip long enough to matter"],
			shortcuts: SELECT_LIST_SHORTCUTS,
		});
		const geo = tight.geometry!;
		const rows = cardRows(tight);

		expect(geo.cardRowEnd).toBeLessThanOrEqual(16);
		expect(rows.at(-1)).toMatch(/[└┘─]/);
	});
});
