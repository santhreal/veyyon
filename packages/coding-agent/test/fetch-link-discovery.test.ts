import { describe, expect, it } from "bun:test";
import { extractDocumentLinks, parseAlternateLinks } from "@veyyon/coding-agent/tools/fetch";

/**
 * Both link scanners used to wrap their entire loop in `try { ... } catch {}`
 * and return whatever they had collected so far. A truncated result is
 * indistinguishable from a page that genuinely has no links, so a parse failure
 * showed up as the fetch tool quietly missing content rather than as an error.
 *
 * `extractDocumentLinks` was the damaging one. Resolving a relative href throws
 * on a malformed href, and the catch was outside the loop, so a single broken
 * anchor ended the scan and dropped every document link after it. On a page
 * listing twenty PDFs, one bad anchor could hide nineteen.
 */
describe("extractDocumentLinks", () => {
	const BASE = "https://example.test/docs/index.html";

	it("keeps scanning past a malformed href instead of stopping there", () => {
		// REGRESSION. A protocol-relative href with an unclosed IPv6 bracket is a
		// genuine URL parse failure (verified: `new URL("//[bad/x.pdf", base)`
		// throws), and it carries a convertible extension so it reaches the resolve
		// rather than being filtered out earlier. Before the per-href catch, the two
		// links after it were never seen.
		const html = [
			'<a href="first.pdf">one</a>',
			'<a href="//[bad/broken.pdf">broken</a>',
			'<a href="second.pdf">two</a>',
			'<a href="third.docx">three</a>',
		].join("\n");

		expect(extractDocumentLinks(html, BASE)).toEqual([
			"https://example.test/docs/first.pdf",
			"https://example.test/docs/second.pdf",
			"https://example.test/docs/third.docx",
		]);
	});

	it("resolves relative hrefs against the page URL", () => {
		const html = '<a href="../reports/q1.pdf">q1</a><a href="/absolute.pdf">abs</a>';

		expect(extractDocumentLinks(html, BASE)).toEqual([
			"https://example.test/reports/q1.pdf",
			"https://example.test/absolute.pdf",
		]);
	});

	it("passes absolute http hrefs through untouched", () => {
		const html = '<a href="https://other.test/a.pdf">a</a>';

		expect(extractDocumentLinks(html, BASE)).toEqual(["https://other.test/a.pdf"]);
	});

	it("ignores anchors whose extension is not convertible", () => {
		const html = '<a href="page.html">page</a><a href="image.png">img</a><a href="real.pdf">real</a>';

		expect(extractDocumentLinks(html, BASE)).toEqual(["https://example.test/docs/real.pdf"]);
	});

	it("returns each document once even when the page links it repeatedly", () => {
		const html = '<a href="a.pdf">1</a><a href="a.pdf">2</a><a href="./a.pdf">3</a>';

		expect(extractDocumentLinks(html, BASE)).toEqual(["https://example.test/docs/a.pdf"]);
	});

	it("stops at twenty links", () => {
		// The cap is a real contract: it bounds how much a wrapper page can fan out.
		const html = Array.from({ length: 30 }, (_, i) => `<a href="doc${i}.pdf">d</a>`).join("");

		const links = extractDocumentLinks(html, BASE);

		expect(links.length).toBe(20);
		expect(links[0]).toBe("https://example.test/docs/doc0.pdf");
		expect(links[19]).toBe("https://example.test/docs/doc19.pdf");
	});

	it("returns nothing for a page with no anchors at all", () => {
		expect(extractDocumentLinks("<p>no links here</p>", BASE)).toEqual([]);
	});
});

describe("parseAlternateLinks", () => {
	const PAGE = "https://example.test/blog/post-1";

	it("returns nothing when the page URL is not a URL, rather than throwing", () => {
		// The one genuine throw site. It now returns early instead of taking the
		// whole loop down with it.
		const html = '<head><link rel="alternate" type="text/markdown" href="/post-1.md"></head>';

		expect(parseAlternateLinks(html, "not a url")).toEqual([]);
	});

	it("finds a markdown alternate regardless of the page path", () => {
		const html = '<head><link rel="alternate" type="text/markdown" href="/post-1.md"></head>';

		expect(parseAlternateLinks(html, PAGE)).toEqual(["/post-1.md"]);
	});

	it("takes a feed only when it belongs to this page", () => {
		// A site-wide feed is not an alternate rendering of the article, so it is
		// matched against the page path.
		const html = [
			"<head>",
			'<link rel="alternate" type="application/rss+xml" href="/blog/post-1/feed.xml">',
			'<link rel="alternate" type="application/rss+xml" href="/site-wide.xml">',
			"</head>",
		].join("");

		expect(parseAlternateLinks(html, PAGE)).toEqual(["/blog/post-1/feed.xml"]);
	});

	it("skips the wiki and site-feed patterns", () => {
		const html = [
			"<head>",
			'<link rel="alternate" type="application/atom+xml" href="/blog/post-1/RecentChanges">',
			'<link rel="alternate" type="application/atom+xml" href="/Special:Feed/blog/post-1">',
			'<link rel="alternate" type="application/atom+xml" href="/feed/blog/post-1">',
			'<link rel="alternate" type="application/atom+xml" href="/x?action=feed&page=/blog/post-1">',
			"</head>",
		].join("");

		expect(parseAlternateLinks(html, PAGE)).toEqual([]);
	});

	it("ignores link tags that are not alternates", () => {
		const html = [
			"<head>",
			'<link rel="stylesheet" type="text/markdown" href="/not-an-alternate.md">',
			'<link rel="canonical" href="/blog/post-1">',
			"</head>",
		].join("");

		expect(parseAlternateLinks(html, PAGE)).toEqual([]);
	});

	it("accepts alternate among several rel tokens", () => {
		const html = '<head><link rel="alternate stylesheet" type="text/markdown" href="/post-1.md"></head>';

		expect(parseAlternateLinks(html, PAGE)).toEqual(["/post-1.md"]);
	});
});
