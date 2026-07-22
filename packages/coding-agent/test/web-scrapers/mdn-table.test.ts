import { describe, expect, it } from "bun:test";
import { buildMarkdownTableFromHtmlRows } from "@veyyon/coding-agent/web/scrapers/mdn";

/**
 * Locks FINDING-MDN-SCRAPER-TABLE-UNESCAPED-CELLS. The MDN scraper used to join
 * each row's rendered-Markdown cells with " | " and no escaping, so a cell whose
 * content contained a `|` (MDN reference tables routinely show operators like
 * `a | b`) or spanned multiple paragraphs (a newline) broke out of its cell and
 * shifted every later column against the header. The builder now routes each
 * rendered cell through the canonical escaper. These assert the exact bytes so a
 * regression that drops escaping fails loudly.
 */
describe("buildMarkdownTableFromHtmlRows", () => {
	it("escapes a pipe in a body cell so the row keeps its two columns", async () => {
		const lines = await buildMarkdownTableFromHtmlRows([
			["Name", "Expr"],
			["bitwise or", "a | b"],
		]);
		expect(lines[0]).toBe("| Name | Expr |");
		expect(lines[1]).toBe("| --- | --- |");
		// The pipe is escaped; without the fix this row would have three columns.
		expect(lines[2]).toBe("| bitwise or | a \\| b |");
	});

	it("collapses a multi-paragraph cell to one line so it cannot end the row early", async () => {
		const lines = await buildMarkdownTableFromHtmlRows([
			["Key", "Detail"],
			["note", "<p>first</p><p>second</p>"],
		]);
		expect(lines[2]).toBe("| note | first second |");
	});

	it("escapes a pipe that appears in the header row as well", async () => {
		const lines = await buildMarkdownTableFromHtmlRows([["a | b", "plain"]]);
		expect(lines[0]).toBe("| a \\| b | plain |");
		expect(lines[1]).toBe("| --- | --- |");
	});

	it("emits header and separator only when there are no body rows", async () => {
		const lines = await buildMarkdownTableFromHtmlRows([["One", "Two"]]);
		expect(lines).toEqual(["| One | Two |", "| --- | --- |"]);
	});

	// A body row with more cells than the header (a rowspan/colspan artifact in
	// MDN source tables) used to overflow the delimiter row, and GFM renderers
	// silently drop the surplus cell. The builder now squares the grid off to the
	// widest row so the extra cell survives in a real column.
	it("keeps a body cell that is wider than the header instead of dropping it", async () => {
		const lines = await buildMarkdownTableFromHtmlRows([
			["Name", "Value"],
			["extra", "b", "c"],
		]);
		expect(lines).toEqual(["| Name | Value |  |", "| --- | --- | --- |", "| extra | b | c |"]);
	});

	it("returns no lines for an empty table", async () => {
		expect(await buildMarkdownTableFromHtmlRows([])).toEqual([]);
	});
});
