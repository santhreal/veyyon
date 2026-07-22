import { describe, expect, it } from "bun:test";
import { createTurndown, normalizeTablesHtml } from "@veyyon/coding-agent/utils/turndown";

/**
 * Locks FINDING-TURNDOWN-TABLE-CELL-UNESCAPED-PIPE-NEWLINE. createTurndown()
 * drives docx, epub, and the web scrapers. turndown-plugin-gfm's stock tableCell
 * rule emits cell content verbatim, and turndown core's escaper does not touch
 * `|`, so a cell holding a literal pipe opened a phantom column and a `<br>`
 * newline broke the row. createTurndown now overrides tableCell to run the body
 * through the canonical escapeMarkdownTableCell. These assert the exact rendered
 * bytes so any regression to the unescaped plugin behavior fails loudly.
 */
describe("createTurndown table cell escaping", () => {
	const render = (html: string) => createTurndown().turndown(normalizeTablesHtml(html));

	it("escapes a literal pipe in a body cell instead of splitting the column", () => {
		// Before the fix this rendered "| a | b | ... |" — three data columns from a
		// two-column table, corrupting every downstream cell.
		const html = "<table><tr><td>op</td><td>meaning</td></tr><tr><td>a | b</td><td>bitwise or</td></tr></table>";
		expect(render(html)).toBe("| op | meaning |\n| --- | --- |\n| a \\| b | bitwise or |");
	});

	it("collapses a <br>-derived newline so the row stays on one line", () => {
		// A `<br>` becomes a raw newline in the plugin output, which terminates the
		// table row mid-cell. The escaper collapses newline runs to a space.
		const html = "<table><tr><td>note</td></tr><tr><td>first<br>second</td></tr></table>";
		expect(render(html)).toBe("| note |\n| --- |\n| first   second |");
	});

	it("escapes a pipe that appears in the header cell too", () => {
		const html = "<table><tr><td>a | b</td><td>right</td></tr><tr><td>1</td><td>2</td></tr></table>";
		expect(render(html)).toBe("| a \\| b | right |\n| --- | --- |\n| 1 | 2 |");
	});

	it("leaves an ordinary table unchanged", () => {
		const html = "<table><tr><td>name</td><td>age</td></tr><tr><td>Alice</td><td>30</td></tr></table>";
		expect(render(html)).toBe("| name | age |\n| --- | --- |\n| Alice | 30 |");
	});

	it("escapes multiple pipes in a single cell", () => {
		const html = "<table><tr><td>expr</td></tr><tr><td>a|b|c</td></tr></table>";
		expect(render(html)).toBe("| expr |\n| --- |\n| a\\|b\\|c |");
	});
});
