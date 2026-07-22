import { describe, expect, it } from "bun:test";
import { escapeMarkdownTableCell, renderMarkdownTable } from "@veyyon/coding-agent/utils/markdown-table";

/**
 * escapeMarkdownTableCell is the single owner of Markdown-table cell escaping,
 * created for FINDING-MD-TABLE-CELL-ESCAPER-DIVERGENT-DUPLICATES. Before it, four
 * call sites carried their own copies that disagreed: some escaped only `|` and
 * `\n`, missing a bare `\r` (which several Markdown renderers treat as a line
 * break) and a `\t`; the PPTX converter escaped nothing at all, so a `|` or
 * newline inside a slide-table cell silently split the row and corrupted every
 * column after it. These tests pin the unified contract: `|` becomes `\|`, and
 * any run of `\r`, `\n`, or `\t` collapses to one space, so a value can never
 * break out of its cell or its row.
 */
describe("escapeMarkdownTableCell", () => {
	it("escapes a pipe so the value stays a single cell", () => {
		expect(escapeMarkdownTableCell("a|b")).toBe("a\\|b");
	});

	it("escapes every pipe in the value, not just the first", () => {
		expect(escapeMarkdownTableCell("a|b|c")).toBe("a\\|b\\|c");
	});

	it("collapses a newline so the value cannot end the row early", () => {
		expect(escapeMarkdownTableCell("line1\nline2")).toBe("line1 line2");
	});

	it("collapses a bare carriage return, which the old \\r?\\n+ copies missed", () => {
		expect(escapeMarkdownTableCell("line1\rline2")).toBe("line1 line2");
	});

	it("collapses a tab, which the mnemopi and tools-markdown copies left raw", () => {
		expect(escapeMarkdownTableCell("a\tb")).toBe("a b");
	});

	it("collapses a mixed run of \\r\\n\\t to exactly one space", () => {
		expect(escapeMarkdownTableCell("a\r\n\t b")).toBe("a  b");
	});

	it("handles a value that both breaks the row and the cell", () => {
		expect(escapeMarkdownTableCell("x|y\nz")).toBe("x\\|y z");
	});

	it("leaves plain text and interior spaces untouched", () => {
		expect(escapeMarkdownTableCell("Alice Smith")).toBe("Alice Smith");
	});

	it("returns an empty string for an empty value", () => {
		expect(escapeMarkdownTableCell("")).toBe("");
	});
});

/**
 * renderMarkdownTable is the single owner of table *layout* (the
 * header/delimiter/body shape and column normalization) shared by the XLSX and
 * PPTX converters and the MDN scraper. It was extracted after those call sites
 * built the identical structure inline and had drifted: the XLSX converter
 * normalized ragged rows to the widest row while the PPTX converter and the MDN
 * builder keyed the table width off the header alone. A body row wider than the
 * header therefore overflowed the delimiter row, and every GFM renderer silently
 * drops the surplus cells, losing that data with no trace. These lock the shape,
 * the escaping delegation, and the ragged-row normalization in both directions.
 */
describe("renderMarkdownTable", () => {
	it("emits header, delimiter, and body rows with each cell escaped", () => {
		expect(
			renderMarkdownTable([
				["Name", "Expr"],
				["bitwise or", "a | b"],
			]),
		).toBe("| Name | Expr |\n| --- | --- |\n| bitwise or | a \\| b |");
	});

	it("pads the header when a body row is WIDER, so the surplus cell is not dropped", () => {
		// The body row's third cell "z" would overflow a two-column header and be
		// silently discarded by GFM renderers; padding the header to three columns
		// keeps it in a real (empty-header) third column.
		expect(
			renderMarkdownTable([
				["A", "B"],
				["x", "y", "z"],
			]),
		).toBe("| A | B |  |\n| --- | --- | --- |\n| x | y | z |");
	});

	it("pads a body row that is NARROWER than the header with empty cells", () => {
		expect(
			renderMarkdownTable([
				["A", "B", "C"],
				["x", "y"],
			]),
		).toBe("| A | B | C |\n| --- | --- | --- |\n| x | y |  |");
	});

	it("renders a header-only grid as just the header and delimiter", () => {
		expect(renderMarkdownTable([["One", "Two"]])).toBe("| One | Two |\n| --- | --- |");
	});

	it("returns an empty string for an empty grid or one whose rows hold no cells", () => {
		expect(renderMarkdownTable([])).toBe("");
		expect(renderMarkdownTable([[], []])).toBe("");
	});

	// Regression: the widest-row search used `Math.max(...rows.map(r => r.length))`.
	// Spreading an array into a call throws RangeError once it passes the engine
	// argument limit (~1e6 in Bun/JSC). An XLSX worksheet holds up to 1,048,576
	// rows, so a large spreadsheet drove renderMarkdownTable past the ceiling and
	// crashed the whole conversion with "Maximum call stack size exceeded" instead
	// of producing a table. The fold has no such ceiling.
	it("renders a row count past the argument-spread ceiling without throwing", () => {
		const rows: string[][] = [["H1", "H2"]];
		// 1.1M body rows: above the ~1e6 spread limit, below any real memory wall.
		for (let i = 0; i < 1_100_000; i++) rows.push(["a", "b"]);

		const out = renderMarkdownTable(rows);
		const lines = out.split("\n");
		// Header + delimiter + one line per body row, all present, none dropped.
		expect(lines.length).toBe(rows.length + 1);
		expect(lines[0]).toBe("| H1 | H2 |");
		expect(lines[1]).toBe("| --- | --- |");
		expect(lines[2]).toBe("| a | b |");
		expect(lines[lines.length - 1]).toBe("| a | b |");
	});
});
