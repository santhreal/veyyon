import { describe, expect, it } from "bun:test";
import { htmlToBasicMarkdown } from "@veyyon/utils/html-markdown";

/**
 * WHY THIS EXISTS. `htmlToBasicMarkdown` is the one converter every page reader calls: the browser
 * tool's readable extraction, the Python eval display for a `text/html` result, and the site
 * handlers in `@veyyon/web`. It does three things a caller depends on and none of which turndown
 * does on its own — it removes script and style bodies before conversion, it runs the table
 * normalization so a `<td>`-first table becomes a GFM table instead of a raw `<table>` blob, and it
 * trims. A converter that emitted the text of a `<script>` would paste an analytics payload into a
 * transcript, and one that skipped normalization would paste raw HTML.
 *
 * WHAT IT DOES NOT CATCH. The escaping inside a table cell, which `turndown-table.test.ts` owns, and
 * every element rule turndown itself provides.
 */
describe("a page converted to markdown", () => {
	it("drops a script body instead of emitting it as text", async () => {
		const html = "<p>before</p><script>const token = 'secret';</script><p>after</p>";
		expect(await htmlToBasicMarkdown(html)).toBe("before\n\nafter");
	});

	it("drops a style body instead of emitting it as text", async () => {
		const html = "<style>.a { color: red }</style><p>body</p>";
		expect(await htmlToBasicMarkdown(html)).toBe("body");
	});

	it("renders a table with no thead as a GFM table", async () => {
		const html = "<table><tr><td>name</td><td>age</td></tr><tr><td>Alice</td><td>30</td></tr></table>";
		expect(await htmlToBasicMarkdown(html)).toBe("| name | age |\n| --- | --- |\n| Alice | 30 |");
	});

	it("trims the surrounding whitespace a block element leaves behind", async () => {
		expect(await htmlToBasicMarkdown("\n\n<p>only</p>\n\n")).toBe("only");
	});

	it("returns an empty string for markup that carries no text", async () => {
		expect(await htmlToBasicMarkdown("<script>ignored()</script>")).toBe("");
	});
});
