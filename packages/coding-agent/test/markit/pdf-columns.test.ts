import { describe, expect, it } from "bun:test";
import { detectColumns } from "@veyyon/coding-agent/markit/converters/pdf/columns";
import type { TextBox } from "@veyyon/coding-agent/markit/converters/pdf/types";

/**
 * detectColumns splits a PDF page's text boxes into reading-order columns so a
 * two-column layout (legal docs, papers, datasheets) is not linearized into
 * interleaved left/right lines. It is pure geometry with three independent gates
 * and ZERO tests, so a regression silently either shreds two-column prose or
 * false-splits a single column. These pin each gate at its boundary:
 *
 *  - fewer than 8 boxes, or a single distinct left edge, is never multi-column;
 *  - the largest left-edge gap must be BOTH >= 15% of the text width AND >= 40pt;
 *  - after assigning boxes by center-X to the gap midpoint, each column must still
 *    hold >= 4 boxes or the page collapses back to one column.
 *
 * A clean two-column page returns columnCount 2, the split X, and the boxes
 * partitioned left/right.
 */

const box = (id: string, left: number, right: number, top: number): TextBox => ({
	id,
	text: id,
	bounds: { left, right, top, bottom: top - 10 },
	pageNumber: 1,
	fontSize: 10,
	isBold: false,
});

/** n left-column + n right-column boxes with the given edges, stacked down the page. */
const layout = (n: number, l: [number, number], r: [number, number]): TextBox[] => {
	const boxes: TextBox[] = [];
	for (let i = 0; i < n; i++) boxes.push(box(`L${i}`, l[0], l[1], 500 - i * 20));
	for (let i = 0; i < n; i++) boxes.push(box(`R${i}`, r[0], r[1], 500 - i * 20));
	return boxes;
};

describe("detectColumns multi-column detection", () => {
	it("splits a clean two-column page at the gap midpoint and partitions the boxes", () => {
		const result = detectColumns(layout(5, [50, 250], [300, 500]));
		expect(result.columnCount).toBe(2);
		expect(result.boundaries).toEqual([175]);
		expect(result.columns[0].map(b => b.id)).toEqual(["L0", "L1", "L2", "L3", "L4"]);
		expect(result.columns[1].map(b => b.id)).toEqual(["R0", "R1", "R2", "R3", "R4"]);
	});
});

describe("detectColumns single-column fallbacks", () => {
	it("returns one column when there are fewer than 8 boxes", () => {
		const result = detectColumns(layout(3, [50, 250], [300, 500]));
		expect(result.columnCount).toBe(1);
		expect(result.columns).toHaveLength(1);
		expect(result.boundaries).toEqual([]);
	});

	it("returns one column when every box shares a single left edge", () => {
		const boxes: TextBox[] = [];
		for (let i = 0; i < 10; i++) boxes.push(box(`A${i}`, 50, 500, 500 - i * 15));
		expect(detectColumns(boxes).columnCount).toBe(1);
	});

	it("does not split when the gap is >= 15% of width but under the 40pt absolute floor", () => {
		// left edges 50 and 80 (gap 30), width 150 -> ratio 0.20 passes but 30 < 40.
		expect(detectColumns(layout(5, [50, 110], [80, 200])).columnCount).toBe(1);
	});

	it("does not split when the gap is >= 40pt but under the 15% width ratio", () => {
		// left edges 50 and 100 (gap 50), width 400 -> 50 >= 40 but ratio 0.125 < 0.15.
		expect(detectColumns(layout(5, [50, 120], [100, 450])).columnCount).toBe(1);
	});

	it("collapses to one column when a side has fewer than 4 boxes after the center-X split", () => {
		const boxes = [
			...Array.from({ length: 5 }, (_, i) => box(`L${i}`, 50, 250, 500 - i * 20)),
			...Array.from({ length: 3 }, (_, i) => box(`R${i}`, 300, 500, 500 - i * 20)),
		];
		expect(detectColumns(boxes).columnCount).toBe(1);
	});
});
