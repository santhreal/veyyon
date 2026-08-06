/**
 * WHY: the exported and shared session viewer rendered transcript markdown through
 * `marked.parse` with overrides for `text`, `codespan` and `code` only. Raw `html` tokens and
 * link hrefs fell through to marked's defaults, which emit them verbatim, while the function
 * doing it was named `safeMarkedParse`.
 *
 * Anyone who can land text in a transcript reached that sink: a page the fetch tool pulled in, a
 * README in a cloned repo, an MCP tool result, a subagent return, or prompt-injected model text.
 * On `/share` the payload executed on the share origin, which is also the default collab web
 * base, so same-origin script could read a live session's room key and write token out of the URL
 * fragment. On `/export` it executed when the operator opened the file.
 *
 * These tests drive the REAL renderer against the REAL vendored parser the export ships, so they
 * fail if either the overrides or the vendored `marked` stop holding the line.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "bun:test";

const HTML_DIR = path.join(import.meta.dirname, "../../src/export/html");
const markdownRendererSource = fs.readFileSync(path.join(HTML_DIR, "markdown-renderer.js"), "utf8");
const vendoredMarked = fs.readFileSync(path.join(HTML_DIR, "vendor/marked.min.js"), "utf8");

function escapeHtml(value: string): string {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Load the vendored parser and the shipped renderer exactly as the template inlines them. */
function loadViewerParser(): (text: string) => string {
	const sandbox: Record<string, unknown> = {};
	const marked = new Function(
		"root",
		`const window = root, self = root, module = { exports: {} }, exports = module.exports;
		${vendoredMarked};
		return root.marked || module.exports.marked || module.exports;`,
	)(sandbox) as { use: (config: unknown) => void; parse: (text: string) => string };

	const install = new Function(
		`${markdownRendererSource};
		return installMarkdownRenderer;`,
	)() as (marked: unknown, deps: unknown) => (text: string) => string;
	// The viewer passes highlight.js here; escaping is the honest stand-in, and it keeps this test
	// about sanitization rather than about syntax colours.
	return install(marked, { escapeHtml, highlight: (code: string) => escapeHtml(code) });
}

const parse = loadViewerParser();

/** A tag that the browser would actually execute or fetch, as opposed to escaped text. */
function livesInTheDom(html: string): boolean {
	const withoutSafeMarkup = html.replace(/<\/?(?:p|strong|em|code|pre|ul|ol|li|br|h[1-6])\b[^>]*>/gi, "");
	return /<(?:script|img|iframe|svg|object|embed|style|div|span)\b/i.test(withoutSafeMarkup);
}

describe("the exported viewer's markdown renderer", () => {
	it("escapes a script block instead of emitting it", () => {
		const html = parse("<script>alert(1)</script>");
		expect(html).not.toContain("<script");
		expect(html).toContain("&lt;script&gt;");
	});

	it.each([
		["inline event handler", "hello <img src=x onerror=alert(1)>"],
		["block element with a handler", '<div onclick="alert(1)">x</div>'],
		["inline frame", '<iframe src="https://evil.example"></iframe>'],
		["svg payload", "<svg><script>alert(1)</script></svg>"],
		["style block", "<style>body{display:none}</style>"],
	])("renders %s as inert text", (_label, payload) => {
		const html = parse(payload);
		expect(livesInTheDom(html)).toBe(false);
	});

	it.each([
		["javascript", "[click](javascript:alert(1))"],
		["data", "[click](data:text/html,<script>alert(1)</script>)"],
		["vbscript", "[click](vbscript:msgbox)"],
	])("refuses a %s: href and keeps the link text", (_label, markdown) => {
		const html = parse(markdown);
		expect(html).not.toContain("href=");
		expect(html).toContain("click");
	});

	it("keeps http, mailto and relative links working", () => {
		expect(parse("[a](https://example.com)")).toContain('href="https://example.com"');
		expect(parse("[b](mailto:x@example.com)")).toContain('href="mailto:x@example.com"');
		expect(parse("[c](./docs/a.md)")).toContain('href="./docs/a.md"');
	});

	it("marks outbound links noopener so a share viewer cannot be reverse-navigated", () => {
		expect(parse("[a](https://example.com)")).toContain('rel="noopener"');
	});

	it("still renders ordinary markdown", () => {
		const html = parse("**bold** and _italic_ and `code <b>`");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<em>italic</em>");
		expect(html).toContain("<code>code &lt;b&gt;</code>");
	});

	it("escapes markup inside a fenced code block", () => {
		const html = parse("```\n<script>alert(1)</script>\n```");
		expect(html).toContain("<pre><code");
		expect(html).not.toContain("<script");
	});
});
