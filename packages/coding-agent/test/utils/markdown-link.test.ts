import { describe, expect, it } from "bun:test";
import { markdownLink, markdownLinkText, markdownLinkUrl } from "@veyyon/coding-agent/utils/markdown-link";

/**
 * Locks the canonical Markdown-link builder used by the web scrapers. Before it
 * existed, each scraper hand-rolled `` `[${text}](${url})` ``, so a `)` in a
 * destination URL (a Wikipedia `_(disambiguation)` page, an OSV advisory
 * reference, an arbitrary embed-card URL) closed the link at the first `)` and
 * dumped the rest as literal text, and a `]` in free-text link labels (Bluesky
 * external-card titles that open with a bracket tag) truncated the label.
 *
 * These assert the exact rendered bytes so a revert to raw interpolation fails
 * loudly, and prove the escaped forms are still real, resolvable links: the
 * percent-encoded destination round-trips to the original URL, and the escaped
 * label round-trips to the original text.
 */
describe("markdownLinkText", () => {
	it("backslash-escapes square brackets so a bracket tag cannot truncate the label", () => {
		// A Bluesky/HN-style "[2024] Annual Report" title: the `]` would end the
		// label early, so it must be escaped.
		expect(markdownLinkText("[2024] Annual Report")).toBe("\\[2024\\] Annual Report");
	});

	it("escapes a lone backslash before it can escape a following bracket", () => {
		// `\` is escaped first so the brackets it precedes still get their own
		// escape rather than being consumed by the label's own backslash.
		expect(markdownLinkText("a\\b[c]")).toBe("a\\\\b\\[c\\]");
	});

	it("collapses newlines to a single space", () => {
		expect(markdownLinkText("line one\nline two")).toBe("line one line two");
	});

	it("leaves parentheses in the label alone (they are only unsafe in the destination)", () => {
		expect(markdownLinkText("Foo (bar) baz")).toBe("Foo (bar) baz");
	});
});

describe("markdownLinkUrl", () => {
	it("percent-encodes a closing paren so a disambiguation URL is not truncated", () => {
		expect(markdownLinkUrl("https://en.wikipedia.org/wiki/Mercury_(planet)")).toBe(
			"https://en.wikipedia.org/wiki/Mercury_%28planet%29",
		);
	});

	it("percent-encodes both parens and spaces", () => {
		expect(markdownLinkUrl("https://x.test/a (b) c")).toBe("https://x.test/a%20%28b%29%20c");
	});

	it("strips newlines and tabs that would break a bare destination", () => {
		expect(markdownLinkUrl("https://x.test/a\n\tb")).toBe("https://x.test/ab");
	});

	it("leaves an already-clean URL byte-for-byte unchanged", () => {
		const url = "https://github.com/owner/repo/blob/main/src/index.ts";
		expect(markdownLinkUrl(url)).toBe(url);
	});

	it("does not double-encode a URL that already carries percent-escapes", () => {
		// The wikidata scraper pre-encodes titles with encodeURIComponent (which
		// leaves ( ) alone) and then routes through markdownLink. The existing %XX
		// escapes must survive untouched while the bare parens get encoded, so the
		// destination still decodes back to the original title.
		const preEncoded = "https://en.wikipedia.org/wiki/Mercury%20(planet)";
		expect(markdownLinkUrl(preEncoded)).toBe("https://en.wikipedia.org/wiki/Mercury%20%28planet%29");
		expect(decodeURIComponent(markdownLinkUrl(preEncoded))).toBe("https://en.wikipedia.org/wiki/Mercury (planet)");
	});
});

describe("markdownLink", () => {
	it("produces a link whose destination resolves back to the original paren URL", () => {
		const url = "https://en.wikipedia.org/wiki/Mercury_(planet)";
		const link = markdownLink("Mercury", url);
		expect(link).toBe("[Mercury](https://en.wikipedia.org/wiki/Mercury_%28planet%29)");
		// The rendered destination decodes back to exactly the source URL.
		const dest = link.slice(link.indexOf("](") + 2, -1);
		expect(decodeURIComponent(dest)).toBe(url);
	});

	it("escapes a bracketed label and a paren URL in the same link", () => {
		expect(markdownLink("[PDF] Paper", "https://ex.test/p(1).pdf")).toBe(
			"[\\[PDF\\] Paper](https://ex.test/p%281%29.pdf)",
		);
	});

	it("is a no-op wrapper for already-safe text and URL", () => {
		expect(markdownLink("Website", "https://project.test")).toBe("[Website](https://project.test)");
	});

	it("keeps a DOI resolver URL with parentheses resolvable", () => {
		// DOIs legitimately contain parentheses, e.g. 10.1002/(SICI)1097-0258, and
		// the biorxiv/semantic-scholar scrapers build `https://doi.org/${doi}` links
		// from raw API values. The bare parens must encode so the link is not cut
		// off at the first `(`, and the destination must decode back to the DOI.
		const doi = "10.1002/(SICI)1097-0258(199601)18:1<43::AID-JOB767>3.0.CO;2-M";
		const link = markdownLink("DOI", `https://doi.org/${doi}`);
		expect(link).toBe(`[DOI](https://doi.org/10.1002/%28SICI%291097-0258%28199601%2918:1<43::AID-JOB767>3.0.CO;2-M)`);
		const dest = link.slice(link.indexOf("](") + 2, -1);
		expect(decodeURIComponent(dest)).toBe(`https://doi.org/${doi}`);
	});
});
