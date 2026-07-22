import { describe, expect, it } from "bun:test";
import { renderTableToMarkdown } from "@veyyon/coding-agent/markit/converters/pdf/render";
import type { TableCell, TableGrid } from "@veyyon/coding-agent/markit/converters/pdf/types";

/**
 * renderTableToMarkdown turns a resolved PDF TableGrid into a GFM markdown table.
 * It was untested despite carrying content-mangling subtleties: it must escape a
 * literal `|` (else it silently splits a cell into two columns), turn an embedded
 * newline into `<br>` (a raw newline breaks the single-line table row), trim each
 * cell, emit an empty string for a degenerate grid, and run two structural
 * rewrites — sub-header promotion (a row of parenthetical qualifiers under the
 * header is folded up into the header and dropped) and sparse-column
 * normalization. These pin the exact rendered bytes for each contract so a
 * regression in escaping or the rewrites is caught rather than shipping a corrupt
 * table.
 */

const cell = (row: number, col: number, text: string): TableCell => ({ row, col, text, rowSpan: 1, colSpan: 1 });
const grid = (rows: number, cols: number, cells: TableCell[]): TableGrid => ({
	pageNumber: 1,
	rows,
	cols,
	cells,
	warnings: [],
	topY: 0,
});

describe("renderTableToMarkdown", () => {
	it("renders a 2x2 grid as a header row, divider, and body row", () => {
		const md = renderTableToMarkdown(
			grid(2, 2, [cell(0, 0, "H1"), cell(0, 1, "H2"), cell(1, 0, "a"), cell(1, 1, "b")]),
		);
		expect(md).toBe("| H1 | H2 |\n| --- | --- |\n| a | b |");
	});

	it("returns an empty string for a grid with zero rows or zero columns", () => {
		expect(renderTableToMarkdown(grid(0, 2, []))).toBe("");
		expect(renderTableToMarkdown(grid(2, 0, []))).toBe("");
	});

	it("escapes a literal pipe so it does not split the cell into columns", () => {
		const md = renderTableToMarkdown(grid(2, 1, [cell(0, 0, "a|b"), cell(1, 0, "c")]));
		expect(md).toBe("| a\\|b |\n| --- |\n| c |");
	});

	it("converts an embedded newline to <br> so the row stays on one line", () => {
		const md = renderTableToMarkdown(grid(2, 1, [cell(0, 0, "H"), cell(1, 0, "x\ny")]));
		expect(md).toBe("| H |\n| --- |\n| x<br>y |");
	});

	it("trims leading and trailing whitespace in every cell", () => {
		const md = renderTableToMarkdown(grid(2, 1, [cell(0, 0, "  Head  "), cell(1, 0, "  v  ")]));
		expect(md).toBe("| Head |\n| --- |\n| v |");
	});

	it("promotes a parenthetical sub-header row into the header and drops it", () => {
		// Row 1 is two full-cell qualifiers under an empty first column: they fold
		// up into the header ("Price (USD)", "Weight (kg)") and the row is removed.
		const md = renderTableToMarkdown(
			grid(3, 3, [
				cell(0, 0, ""),
				cell(0, 1, "Price"),
				cell(0, 2, "Weight"),
				cell(1, 0, ""),
				cell(1, 1, "(USD)"),
				cell(1, 2, "(kg)"),
				cell(2, 0, "Item"),
				cell(2, 1, "10"),
				cell(2, 2, "5"),
			]),
		);
		expect(md).toBe("|  | Price (USD) | Weight (kg) |\n| --- | --- | --- |\n| Item | 10 | 5 |");
	});

	it("does not promote qualifiers when the row's first column has content", () => {
		// The non-empty first column marks this as a real data row, not a sub-header.
		const md = renderTableToMarkdown(
			grid(2, 3, [
				cell(0, 0, "A"),
				cell(0, 1, "Price"),
				cell(0, 2, "Weight"),
				cell(1, 0, "Row"),
				cell(1, 1, "(USD)"),
				cell(1, 2, "(kg)"),
			]),
		);
		expect(md).toBe("| A | Price | Weight |\n| --- | --- | --- |\n| Row | (USD) | (kg) |");
	});
});
