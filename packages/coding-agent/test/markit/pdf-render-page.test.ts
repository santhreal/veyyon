import { describe, expect, it } from "bun:test";
import { renderPageContent } from "@veyyon/coding-agent/markit/converters/pdf/render";
import type { TableCell, TableGrid, TextBox } from "@veyyon/coding-agent/markit/converters/pdf/types";

/**
 * renderPageContent assembles one PDF page's markdown by interleaving free-text
 * lines, resolved tables, and image blocks top-to-bottom (PDF coords: larger Y is
 * higher on the page, rendered first). It drives the previously untested free-text
 * pipeline — modal body-font detection, line grouping, font-ratio heading
 * detection, wrapped-paragraph reflow, and bottom page-number stripping. A
 * regression here silently corrupts the prose of every converted PDF (missing
 * headings, split paragraphs, tables out of order, stray page numbers). These pin
 * the exact rendered markdown for each contract.
 *
 * Coordinates are PDF-native (origin bottom-left, Y up). Each helper places a text
 * box centered at (cx, cy) with the given font size.
 */

const tb = (id: string, text: string, cx: number, cy: number, fontSize: number, isBold = false): TextBox => ({
	id,
	text,
	bounds: { left: cx - 20, right: cx + 20, top: cy + 5, bottom: cy - 5 },
	pageNumber: 1,
	fontSize,
	isBold,
});
const cell = (row: number, col: number, text: string): TableCell => ({ row, col, text, rowSpan: 1, colSpan: 1 });
const grid = (rows: number, cols: number, cells: TableCell[], topY: number): TableGrid => ({
	pageNumber: 1,
	rows,
	cols,
	cells,
	warnings: [],
	topY,
});

describe("renderPageContent", () => {
	it("returns an empty string when the page has no content", () => {
		expect(renderPageContent([], [])).toBe("");
	});

	it("marks a line >=2x the body font as an H1 and keeps sentence-ended lines separate", () => {
		const boxes = [
			tb("h", "Title", 100, 200, 20),
			tb("a", "First sentence.", 100, 180, 10),
			tb("b", "Second sentence.", 100, 150, 10),
		];
		expect(renderPageContent(boxes, [])).toBe("# Title\n\nFirst sentence.\n\nSecond sentence.");
	});

	it("assigns heading levels by font ratio: 1.5x -> H2, 1.1x bold -> H3", () => {
		// Three size-10 lines make 10 the modal body font; 15/10=1.5 -> ##,
		// 11/10=1.1 with bold -> ###.
		const boxes = [
			tb("b1", "body one.", 100, 200, 10),
			tb("b2", "body two.", 100, 190, 10),
			tb("b3", "body three.", 100, 180, 10),
			tb("m", "Medium head", 100, 160, 15),
			tb("s", "Small head", 100, 140, 11, true),
		];
		expect(renderPageContent(boxes, [])).toBe(
			"body one.\n\nbody two.\n\nbody three.\n\n## Medium head\n\n### Small head",
		);
	});

	it("interleaves a table between text lines by their vertical position", () => {
		const table = grid(2, 2, [cell(0, 0, "H1"), cell(0, 1, "H2"), cell(1, 0, "a"), cell(1, 1, "b")], 170);
		const boxes = [tb("t", "Above.", 100, 200, 10), tb("u", "Below.", 100, 120, 10)];
		expect(renderPageContent(boxes, [table])).toBe("Above.\n\n| H1 | H2 |\n| --- | --- |\n| a | b |\n\nBelow.");
	});

	it("interleaves an image block by its vertical position", () => {
		const boxes = [tb("t", "Above.", 100, 200, 10), tb("u", "Below.", 100, 120, 10)];
		expect(renderPageContent(boxes, [], [{ topY: 170, markdown: "![pic](x.png)" }])).toBe(
			"Above.\n\n![pic](x.png)\n\nBelow.",
		);
	});

	it("reflows a wrapped paragraph: a long non-sentence-ended line joins the next", () => {
		const boxes = [
			tb("a", "This is a longer wrapped line of prose that keeps going", 100, 180, 10),
			tb("b", "onto the next visual line.", 100, 164, 10),
		];
		expect(renderPageContent(boxes, [])).toBe(
			"This is a longer wrapped line of prose that keeps going onto the next visual line.",
		);
	});

	it("strips a bare page number at the bottom of the page", () => {
		const boxes = [tb("t", "Some body content here on the page.", 100, 300, 10), tb("p", "12", 100, 90, 10)];
		expect(renderPageContent(boxes, [])).toBe("Some body content here on the page.");
	});
});
