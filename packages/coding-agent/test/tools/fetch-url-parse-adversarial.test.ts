import { describe, expect, it } from "bun:test";
import {
	extractDocumentLinks,
	htmlNestingExceeds,
	parseAlternateLinks,
	parseReadUrlTarget,
} from "@veyyon/coding-agent/tools/fetch";

/**
 * Fetch/read-url pure parsers: URL target extraction, nesting DoS guard,
 * alternate/document link harvest. Exact values, no network.
 */

describe("parseReadUrlTarget", () => {
	it("parses a bare https URL", () => {
		const parsed = parseReadUrlTarget("https://example.com/path");
		expect(parsed).not.toBeNull();
		const text = JSON.stringify(parsed);
		expect(text).toContain("example.com");
		expect(text).toContain("https");
	});

	it("returns null for a plain filesystem path", () => {
		expect(parseReadUrlTarget("src/a.ts")).toBeNull();
		expect(parseReadUrlTarget("/etc/passwd")).toBeNull();
	});

	it("parses http as well as https", () => {
		const parsed = parseReadUrlTarget("http://example.com/");
		expect(parsed).not.toBeNull();
		expect(JSON.stringify(parsed)).toContain("example.com");
	});

	it("rejects empty string", () => {
		expect(parseReadUrlTarget("")).toBeNull();
	});
});

describe("htmlNestingExceeds", () => {
	it("returns false for shallow html", () => {
		expect(htmlNestingExceeds("<div><p>hi</p></div>", 50)).toBe(false);
	});

	it("returns true when nesting exceeds the limit", () => {
		let html = "";
		for (let i = 0; i < 100; i++) html += "<div>";
		html += "x";
		for (let i = 0; i < 100; i++) html += "</div>";
		expect(htmlNestingExceeds(html, 20)).toBe(true);
	});

	it("empty html does not exceed", () => {
		expect(htmlNestingExceeds("", 1)).toBe(false);
	});
});

describe("link extractors", () => {
	it("parseAlternateLinks skips stylesheets and only keeps markdown/rss-like alternates", () => {
		const html = `<html><head>
			<link rel="alternate" type="text/markdown" href="/page.md">
			<link rel="stylesheet" href="/style.css">
			<link rel="alternate" type="application/rss+xml" href="/feed/">
		</head></html>`;
		const links = parseAlternateLinks(html, "https://example.com/page");
		// Markdown alternate is accepted; stylesheet never; site-wide /feed/ is skipped.
		expect(links.some(l => l.includes("page.md"))).toBe(true);
		expect(links.some(l => l.includes("style.css"))).toBe(false);
		expect(links.some(l => l.includes("/feed/"))).toBe(false);
	});

	it("parseAlternateLinks returns [] for a non-URL pageUrl", () => {
		expect(parseAlternateLinks("<link rel='alternate' href='/x.md'>", "not-a-url")).toEqual([]);
	});

	it("extractDocumentLinks only returns convertible document extensions", () => {
		// Product filters to CONVERTIBLE_EXTENSIONS (pdf/docx/…), not every anchor.
		const html = `
			<a href="/docs/a.pdf">PDF</a>
			<a href="/docs/note.docx">DOCX</a>
			<a href="/docs/page.html">HTML</a>
			<a href="https://other.test/file.pdf">remote</a>
		`;
		const links = extractDocumentLinks(html, "https://example.com/");
		expect(links.some(l => l.includes(".pdf"))).toBe(true);
		expect(links.some(l => l.includes(".docx"))).toBe(true);
		expect(links.some(l => l.includes(".html"))).toBe(false);
		expect(links.some(l => l.includes("other.test/file.pdf"))).toBe(true);
	});

	it("extractDocumentLinks ignores javascript: empty hrefs and non-document anchors", () => {
		const html = `
			<a href="javascript:alert(1)">x</a>
			<a href="">y</a>
			<a href="/ok">z</a>
			<a href="/report.pdf">doc</a>
		`;
		const links = extractDocumentLinks(html, "https://example.com/");
		expect(links.every(l => !l.startsWith("javascript:"))).toBe(true);
		expect(links.every(l => l.length > 0)).toBe(true);
		expect(links.some(l => l.includes("report.pdf"))).toBe(true);
		expect(links.some(l => l.endsWith("/ok"))).toBe(false);
	});

	it("extractDocumentLinks caps at 20 results", () => {
		const anchors = Array.from({ length: 30 }, (_, i) => `<a href="/f${i}.pdf">f</a>`).join("");
		const links = extractDocumentLinks(anchors, "https://example.com/");
		expect(links.length).toBeLessThanOrEqual(20);
		expect(links.length).toBe(20);
	});
});
