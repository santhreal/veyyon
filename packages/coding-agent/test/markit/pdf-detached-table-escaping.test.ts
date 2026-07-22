import { describe, expect, it } from "bun:test";
import { normalizeDetachedFirstColumnTables } from "@veyyon/coding-agent/markit/converters/pdf/render";
import type { ContentBlock } from "@veyyon/coding-agent/markit/converters/pdf/types";

/**
 * normalizeDetachedFirstColumnTables reconstructs a table whose first column the
 * PDF extractor emitted as free-text blocks around a markdown table that holds
 * only the right-hand columns. It builds each row as `| <label> | <cells> |` and
 * a header line from plain-text tokens above the table.
 *
 * The right-hand cells arrive already escaped (they come through parsePipeRow,
 * which preserves the `\|` that escapePipes wrote), but the reconstructed header
 * tokens and the first-column labels are RAW PDF text. A `|` in a header token
 * (a column titled "Price|USD") or in a label ("Rev|A") therefore used to end its
 * cell early and shift every following column against the header, corrupting the
 * whole reconstructed table. Both are now routed through escapePipes, the same
 * escaper the table cells use.
 *
 * These assert the exact reconstructed bytes and the column count so a revert to
 * raw interpolation fails loudly. A pipe-carrying block still passes isPlainBlock
 * (which only rejects a block whose first character is `|`), so the reconstruction
 * genuinely fires on this input.
 */
describe("normalizeDetachedFirstColumnTables cell escaping", () => {
	const block = (content: string, topY: number): ContentBlock => ({ topY, content });

	// A three-token header ("Item", "Price|USD", "Qty") sits above a two-column
	// markdown table, with two short first-column labels below it (one carrying a
	// pipe). That matches the (cols + 1) header-token rule and the label-count rule
	// the reconstruction requires.
	const buildBlocks = (): ContentBlock[] => [
		block("Item Price|USD Qty", 0),
		block("| 10 | 20 |\n| --- | --- |\n| 30 | 40 |", 1),
		block("Rev|A", 2),
		block("RevB", 3),
	];

	const reconstructedTable = (): string[] => {
		const out = normalizeDetachedFirstColumnTables(buildBlocks());
		// The table block (index 1) is replaced in place with the reconstruction.
		const table = out.find(b => b.content.includes("Item"));
		expect(table).toBeDefined();
		return (table as ContentBlock).content.split("\n");
	};

	// Split a rendered row on unescaped pipes; a three-column row `| a | b | c |`
	// yields 5 segments (leading + trailing empty + three cells).
	const columns = (row: string): number => row.split(/(?<!\\)\|/).length;

	it("escapes a pipe in a reconstructed header token", () => {
		const lines = reconstructedTable();
		expect(lines[0]).toBe("| Item | Price\\|USD | Qty |");
		expect(columns(lines[0])).toBe(5);
	});

	it("emits a three-column divider matching the (N+1)-column header", () => {
		const lines = reconstructedTable();
		expect(lines[1]).toBe("| --- | --- | --- |");
	});

	it("escapes a pipe in a first-column label so the data row keeps three columns", () => {
		const lines = reconstructedTable();
		expect(lines[2]).toBe("| Rev\\|A | 10 | 20 |");
		expect(columns(lines[2])).toBe(5);
	});

	it("leaves an already-clean label and the pre-escaped right cells intact", () => {
		const lines = reconstructedTable();
		expect(lines[3]).toBe("| RevB | 30 | 40 |");
	});

	it("removes the detached header and label blocks from the output", () => {
		const out = normalizeDetachedFirstColumnTables(buildBlocks());
		// Only the reconstructed table block survives; the free-text header and the
		// two label blocks are folded into it and dropped.
		expect(out.length).toBe(1);
		expect(out[0].content).toContain("Price\\|USD");
	});
});
