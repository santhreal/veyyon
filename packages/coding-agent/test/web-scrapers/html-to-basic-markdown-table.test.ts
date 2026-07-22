import { describe, expect, it } from "bun:test";
import { htmlToBasicMarkdown } from "@veyyon/coding-agent/web/scrapers/types";

/**
 * Locks FINDING-HTMLTOBASICMARKDOWN-SKIPS-TABLE-NORMALIZE. htmlToBasicMarkdown
 * backs every web scraper. It used to run turndown without normalizeTablesHtml,
 * so turndown-plugin-gfm (which only converts a table whose first row is a
 * heading row) left a real-world `<td>`-first table as a raw `<table>` HTML blob
 * in the scraped markdown. It now normalizes tables the same way the docx/epub
 * converters do. These assert the exact GFM output and that no raw table tag
 * survives, and that the tableCell escaping (FINDING-TURNDOWN-...) still applies.
 */
describe("htmlToBasicMarkdown table normalization", () => {
	it("renders a <td>-first table as a GFM table, not raw HTML", async () => {
		const html = "<table><tr><td>name</td><td>age</td></tr><tr><td>Alice</td><td>30</td></tr></table>";
		const md = await htmlToBasicMarkdown(html);
		expect(md).toBe("| name | age |\n| --- | --- |\n| Alice | 30 |");
		expect(md).not.toContain("<table");
		expect(md).not.toContain("<td");
	});

	it("still converts an explicit <thead> table", async () => {
		const html =
			"<table><thead><tr><th>k</th><th>v</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr></tbody></table>";
		expect(await htmlToBasicMarkdown(html)).toBe("| k | v |\n| --- | --- |\n| a | 1 |");
	});

	it("escapes a pipe inside a normalized table cell", async () => {
		// Proves the normalize step composes with the tableCell escaping fix.
		const html = "<table><tr><td>op</td><td>meaning</td></tr><tr><td>a | b</td><td>or</td></tr></table>";
		expect(await htmlToBasicMarkdown(html)).toBe("| op | meaning |\n| --- | --- |\n| a \\| b | or |");
	});

	it("leaves non-table HTML unchanged in behavior", async () => {
		expect(await htmlToBasicMarkdown("<p>hello <strong>world</strong></p>")).toBe("hello **world**");
	});
});
