import { describe, expect, it } from "bun:test";
import { resolveTableGrids } from "@veyyon/coding-agent/markit/converters/pdf/grid";
import type { Segment, TextBox } from "@veyyon/coding-agent/markit/converters/pdf/types";

/**
 * resolveTableGrids reconstructs table grids from a PDF page's vector line
 * segments and positioned text boxes (PDF coordinate space: origin bottom-left, Y
 * increases upward). It is 780 lines of pure geometry that had ZERO tests, so a
 * regression in the raycast placement, the Y-line grouping, the header-row lift,
 * the multi-line cell merge, or the diagram-vs-table filter would silently corrupt
 * every table extracted from a PDF. These build synthetic grids with exact
 * coordinates and assert the exact reconstructed cells:
 *
 *  - a full bordered grid places each text box in its cell by raycasting to the
 *    surrounding segments;
 *  - a text box just above the grid is lifted into a prepended header row;
 *  - two boxes in one cell at different Y merge into one cell joined by `<br>`;
 *  - an inferred-column table (horizontal lines with a single bridging vertical,
 *    no column borders) derives columns from the text X-gaps;
 *  - a grid with no placed text is rejected as a vector diagram, and its text box
 *    IDs are NOT consumed (they fall back to free text);
 *  - fewer than two horizontal lines, or no segments, yields no grid.
 */

const seg = (id: string, x1: number, y1: number, x2: number, y2: number): Segment => ({ id, x1, y1, x2, y2 });
const box = (id: string, text: string, left: number, right: number, top: number, bottom: number): TextBox => ({
	id,
	text,
	bounds: { left, right, top, bottom },
	pageNumber: 1,
	fontSize: 10,
	isBold: false,
});

// A 2x2 bordered grid: horizontal rules at Y=160/130/100, vertical rules at X=50/150/250.
const fullGridSegments: Segment[] = [
	seg("h1", 50, 160, 250, 160),
	seg("h2", 50, 130, 250, 130),
	seg("h3", 50, 100, 250, 100),
	seg("v1", 50, 100, 50, 160),
	seg("v2", 150, 100, 150, 160),
	seg("v3", 250, 100, 250, 160),
];

describe("resolveTableGrids — full bordered grid", () => {
	it("places every text box in its raycast cell of a 2x2 grid", () => {
		const boxes = [
			box("b1", "Alpha", 80, 120, 150, 140),
			box("b2", "Bravo", 180, 220, 150, 140),
			box("b3", "Charlie", 80, 120, 120, 110),
			box("b4", "Delta", 180, 220, 120, 110),
		];
		const { grids, consumedIds } = resolveTableGrids(1, boxes, fullGridSegments);
		expect(grids).toHaveLength(1);
		const g = grids[0];
		expect({ rows: g.rows, cols: g.cols, page: g.pageNumber, topY: g.topY }).toEqual({
			rows: 2,
			cols: 2,
			page: 1,
			topY: 160,
		});
		expect(g.cells.map(c => ({ r: c.row, c: c.col, t: c.text }))).toEqual([
			{ r: 0, c: 0, t: "Alpha" },
			{ r: 0, c: 1, t: "Bravo" },
			{ r: 1, c: 0, t: "Charlie" },
			{ r: 1, c: 1, t: "Delta" },
		]);
		expect([...consumedIds].sort()).toEqual(["b1", "b2", "b3", "b4"]);
	});

	it("lifts a text box just above the grid into a prepended header row", () => {
		const boxes = [
			box("hd", "Head", 80, 120, 175, 165),
			box("b1", "Alpha", 80, 120, 150, 140),
			box("b2", "Bravo", 180, 220, 150, 140),
			box("b3", "Charlie", 80, 120, 120, 110),
			box("b4", "Delta", 180, 220, 120, 110),
		];
		const g = resolveTableGrids(1, boxes, fullGridSegments).grids[0];
		expect({ rows: g.rows, cols: g.cols }).toEqual({ rows: 3, cols: 2 });
		expect(g.cells.find(c => c.row === 0 && c.col === 0)?.text).toBe("Head");
		expect(g.cells.find(c => c.row === 0 && c.col === 1)?.text).toBe("");
		expect(g.cells.find(c => c.row === 1 && c.col === 0)?.text).toBe("Alpha");
		expect(g.cells.find(c => c.row === 2 && c.col === 1)?.text).toBe("Delta");
	});

	it("merges two boxes in one cell at different Y into a <br>-joined cell", () => {
		const boxes = [
			box("b1", "Alpha", 80, 120, 150, 140),
			box("b2", "Bravo", 180, 220, 150, 140),
			box("c1", "Charlie", 80, 120, 122, 114),
			box("c2", "Extra", 80, 120, 110, 104),
			box("b4", "Delta", 180, 220, 120, 110),
		];
		const g = resolveTableGrids(1, boxes, fullGridSegments).grids[0];
		expect(g.cells.find(c => c.row === 1 && c.col === 0)?.text).toBe("Charlie<br>Extra");
	});
});

describe("resolveTableGrids — inferred columns (no vertical borders)", () => {
	it("derives columns from text X-gaps when only one vertical rule bridges the rows", () => {
		// Horizontal rules plus a single left-edge vertical: no column borders, so
		// columns are inferred from the two X-clusters of the text (~x100, ~x260).
		const segments = [
			seg("h1", 50, 160, 300, 160),
			seg("h2", 50, 130, 300, 130),
			seg("h3", 50, 100, 300, 100),
			seg("v1", 50, 100, 50, 160),
		];
		const boxes = [
			box("a1", "Name", 80, 120, 150, 140),
			box("a2", "Value", 240, 280, 150, 140),
			box("b1", "Foo", 80, 120, 120, 110),
			box("b2", "111", 240, 280, 120, 110),
		];
		const g = resolveTableGrids(1, boxes, segments).grids[0];
		expect({ rows: g.rows, cols: g.cols }).toEqual({ rows: 2, cols: 2 });
		expect(g.cells.map(c => ({ r: c.row, c: c.col, t: c.text }))).toEqual([
			{ r: 0, c: 0, t: "Name" },
			{ r: 0, c: 1, t: "Value" },
			{ r: 1, c: 0, t: "Foo" },
			{ r: 1, c: 1, t: "111" },
		]);
	});
});

describe("resolveTableGrids — rejection paths", () => {
	it("rejects a bordered grid with no placed text as a diagram and consumes nothing", () => {
		const boxes = [box("far", "Away", 80, 120, 505, 495)];
		const { grids, consumedIds } = resolveTableGrids(1, boxes, fullGridSegments);
		expect(grids).toHaveLength(0);
		expect(consumedIds).toHaveLength(0);
	});

	it("yields no grid when fewer than two horizontal lines exist", () => {
		const { grids } = resolveTableGrids(1, [box("x", "X", 80, 120, 150, 140)], [seg("h1", 50, 140, 250, 140)]);
		expect(grids).toHaveLength(0);
	});

	it("yields no grid and consumes nothing when there are no segments", () => {
		const { grids, consumedIds } = resolveTableGrids(1, [box("x", "X", 80, 120, 150, 140)], []);
		expect(grids).toHaveLength(0);
		expect(consumedIds).toHaveLength(0);
	});
});
