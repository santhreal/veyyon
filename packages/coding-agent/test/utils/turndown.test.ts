import { describe, expect, it } from "bun:test";
import { createTurndown, normalizeTablesHtml } from "@veyyon/coding-agent/utils/turndown";

/**
 * createTurndown carries veyyon's specific HTML-to-markdown fixes and its rule set
 * "must stay identical across both call sites" (web scrapers and the markit engine),
 * yet had no test. A silent regression in these rules changes scraper and document
 * output everywhere. These tests pin each custom rule's observable markdown and the
 * table-normalization transforms (values verified against the live converter).
 */

describe("createTurndown custom rules", () => {
	const td = createTurndown();

	it("renders strikethrough with double tildes per the GFM spec", () => {
		expect(td.turndown("<del>gone</del>")).toBe("~~gone~~");
		expect(td.turndown("<s>gone</s>")).toBe("~~gone~~");
	});

	it("does not escape the period in a numbered heading", () => {
		expect(td.turndown("<h2>1. Intro</h2>")).toBe("## 1. Intro");
	});

	it("numbers an ordered list from its start attribute plus index", () => {
		expect(td.turndown('<ol start="3"><li>a</li><li>b</li></ol>')).toBe("3. a\n4. b");
	});

	it("numbers an ordered list from 1 when start is absent", () => {
		expect(td.turndown("<ol><li>a</li><li>b</li></ol>")).toBe("1. a\n2. b");
	});

	it("uses a single space after an unordered list marker", () => {
		expect(td.turndown("<ul><li>x</li><li>y</li></ul>")).toBe("- x\n- y");
	});
});

describe("normalizeTablesHtml", () => {
	it("wraps the first row in thead and promotes its cells to th", () => {
		expect(normalizeTablesHtml("<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>")).toBe(
			"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
		);
	});

	it("promotes the first row of a tbody-wrapped table", () => {
		expect(normalizeTablesHtml("<table><tbody><tr><td>A</td></tr><tr><td>1</td></tr></tbody></table>")).toBe(
			"<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>",
		);
	});

	it("leaves a table that already has a thead unchanged", () => {
		const html = "<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>";
		expect(normalizeTablesHtml(html)).toBe(html);
	});

	it("strips paragraph tags inside a cell and joins them with a space", () => {
		expect(normalizeTablesHtml("<table><tr><td><p>A</p><p>B</p></td></tr></table>")).toBe(
			"<table><thead><tr><th>A B</th></tr></thead><tbody></tbody></table>",
		);
	});
});
