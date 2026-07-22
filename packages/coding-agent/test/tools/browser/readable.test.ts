import { describe, expect, it } from "bun:test";
import { extractReadableFromHtml } from "@veyyon/coding-agent/tools/browser/readable";

/**
 * extractReadableFromHtml turns a raw HTML page into the isolated article content the
 * browser/fetch tools show the model: Readability scoring first, a CSS selector chain
 * as a fallback, and null when neither yields usable text. It had no tests despite
 * being the boundary that decides what page text the model actually sees. Two contracts
 * matter and are pinned here against the pinned readability/linkedom versions:
 *
 *  - text format returns the article's plain text (no HTML) with title/excerpt/length
 *    metadata; markdown format returns converted markdown (headings become `##`,
 *    paragraphs separated by blank lines) and omits the plain-text field.
 *  - a page with no extractable content (empty or whitespace-only body) returns null,
 *    so the caller shows nothing rather than an empty shell.
 */

const ARTICLE = `<html><head><title>My Title</title></head><body><article><h1>Heading</h1><p>This is a reasonably long paragraph of article text so readability has something to score and isolate as the main content of the page.</p><p>A second paragraph adds more body text to help the article scorer pick this region.</p></article></body></html>`;

describe("extractReadableFromHtml text format", () => {
	it("returns the article plain text with title and metadata", async () => {
		const result = await extractReadableFromHtml(ARTICLE, "https://ex.com/a", "text");
		expect(result).not.toBeNull();
		expect(result?.url).toBe("https://ex.com/a");
		expect(result?.title).toBe("My Title");
		expect(result?.text).toBe(
			"HeadingThis is a reasonably long paragraph of article text so readability has something to score and isolate as the main content of the page.A second paragraph adds more body text to help the article scorer pick this region.",
		);
		// Plain text carries no markdown rendering.
		expect(result?.markdown).toBeUndefined();
		expect(result?.contentLength).toBe(224);
	});
});

describe("extractReadableFromHtml markdown format", () => {
	it("returns converted markdown and omits the plain-text field", async () => {
		const result = await extractReadableFromHtml(ARTICLE, "https://ex.com/a", "markdown");
		expect(result).not.toBeNull();
		expect(result?.title).toBe("My Title");
		expect(result?.markdown).toBe(
			"## Heading\n\nThis is a reasonably long paragraph of article text so readability has something to score and isolate as the main content of the page.\n\nA second paragraph adds more body text to help the article scorer pick this region.",
		);
		expect(result?.text).toBeUndefined();
	});
});

describe("extractReadableFromHtml short content", () => {
	it("extracts the visible text of a short main region", async () => {
		const html = "<html><body><main>Just some <b>main</b> content here that is fairly short.</main></body></html>";
		const result = await extractReadableFromHtml(html, "https://ex.com/b", "text");
		expect(result?.url).toBe("https://ex.com/b");
		expect(result?.text).toBe("Just some main content here that is fairly short.");
		expect(result?.contentLength).toBe(49);
	});
});

describe("extractReadableFromHtml no content", () => {
	it("returns null for an empty body", async () => {
		expect(await extractReadableFromHtml("<html><body></body></html>", "https://ex.com/c", "text")).toBeNull();
	});

	it("returns null for a whitespace-only body", async () => {
		expect(await extractReadableFromHtml("<html><body>   </body></html>", "https://ex.com/d", "text")).toBeNull();
	});
});
