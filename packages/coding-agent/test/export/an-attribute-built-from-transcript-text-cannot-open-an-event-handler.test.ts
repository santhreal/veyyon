/**
 * A value interpolated into an attribute must not be able to close it.
 *
 * WHY THIS SUITE EXISTS. The exported and shared session viewer builds its HTML
 * by string concatenation, and `escapeHtml` is the one function standing between
 * transcript content and markup. It was:
 *
 *     function escapeHtml(text) {
 *       const div = document.createElement('div');
 *       div.textContent = text;
 *       return div.innerHTML;
 *     }
 *
 * Serializing a text node escapes `&`, `<` and `>` and nothing else. The
 * serializer quotes an attribute value it writes itself, so a `"` inside a TEXT
 * node comes back verbatim. Every attribute built from it — the markdown
 * renderer's `href="..."` and `title="..."`, the viewer's `src="data:..."` —
 * therefore accepted a quote, and a transcript carrying
 * `https://x" onmouseover="alert(1)` produced a live event handler. Confirmed in
 * a real DOM before the fix: the parsed anchor reported `hasAttribute
 * ('onmouseover') === true`.
 *
 * Anyone who can land text in a transcript reaches this: a fetched page, a
 * README in a cloned repo, an MCP tool result, a subagent return, or
 * prompt-injected model text. On `/share` the payload runs on the share origin,
 * which is also the collab web base, so same-origin script can read a live
 * session's room key out of the URL fragment.
 *
 * THE CLASS, AND WHY THE OLD SUITE MISSED IT.
 * `markdown-renderer-keeps-a-transcript-inert.test.ts` covers the renderer, and
 * it was green throughout, because it passed the renderer its OWN `escapeHtml`
 * stand-in — one that did escape `"`. The test double was stricter than the
 * shipped function in exactly the property under test, so the suite proved a
 * sanitizer that was never deployed. The class is therefore two things at once:
 * an attribute that can be closed, and a double that flatters production.
 *
 * This suite closes both by extracting the SHIPPED `escapeHtml` out of
 * `template.js` and executing it, the way
 * `export-html-keyboard-shortcuts.test.ts` executes the shipped keydown handler.
 * Nothing here asserts on source text; the real function runs.
 *
 * WHAT THIS SUITE DOES NOT CATCH. It proves the escaper and the renderer that
 * consumes it. It does not evaluate the whole viewer, so an attribute somewhere
 * in `template.js` that interpolates a value WITHOUT calling `escapeHtml` is
 * invisible here; the sweep below pins the known attribute-position callers by
 * exact equality instead, and a new raw interpolation is caught only by review.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const HTML_DIR = path.join(import.meta.dirname, "../../src/export/html");
const templateSource = fs.readFileSync(path.join(HTML_DIR, "template.js"), "utf8");
const markdownRendererSource = fs.readFileSync(path.join(HTML_DIR, "markdown-renderer.js"), "utf8");
const vendoredMarked = fs.readFileSync(path.join(HTML_DIR, "vendor/marked.min.js"), "utf8");

/** Lift a whole `function <name>(...) { ... }` declaration out of the viewer script. */
function extractFunction(source: string, name: string): string {
	const start = source.indexOf(`function ${name}(`);
	if (start < 0) throw new Error(`${name} is no longer declared in template.js`);
	const bodyStart = source.indexOf("{", start);
	let depth = 0;
	for (let i = bodyStart; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
	}
	throw new Error(`${name} does not close`);
}

/**
 * The escaper the viewer actually ships, executed. It runs with no `document` in
 * scope, which is itself part of the contract: a DOM-dependent escaper cannot be
 * checked without a browser, and that is how the quote hole survived.
 */
const escapeHtml = new Function(`${extractFunction(templateSource, "escapeHtml")}; return escapeHtml;`)() as (
	value: unknown,
) => string;

/** The shipped renderer, driven by the shipped escaper rather than a stand-in. */
function loadViewerParser(): (text: string) => string {
	const sandbox: Record<string, unknown> = {};
	const marked = new Function(
		"root",
		`const window = root, self = root, module = { exports: {} }, exports = module.exports;
		${vendoredMarked};
		return root.marked || module.exports.marked || module.exports;`,
	)(sandbox) as { use: (config: unknown) => void; parse: (text: string) => string };
	const install = new Function(`${markdownRendererSource};
		return installMarkdownRenderer;`)() as (marked: unknown, deps: unknown) => (text: string) => string;
	return install(marked, { escapeHtml, highlight: (code: string) => escapeHtml(code) });
}

const parse = loadViewerParser();

/** Every character that changes meaning in markup, with the entity it must become. */
const MUST_ESCAPE: Array<[name: string, raw: string, entity: string]> = [
	["ampersand", "&", "&amp;"],
	["less-than", "<", "&lt;"],
	["greater-than", ">", "&gt;"],
	["double quote", '"', "&quot;"],
	["single quote", "'", "&#39;"],
];

describe("the shipped escaper", () => {
	it.each(MUST_ESCAPE)("turns a %s into its entity", (_name, raw, entity) => {
		expect(escapeHtml(raw)).toBe(entity);
	});

	it("escapes the ampersand first, so an entity is not double-decoded", () => {
		// `&lt;` must survive as literal text, not come back as a working `<`.
		expect(escapeHtml("&lt;script&gt;")).toBe("&amp;lt;script&amp;gt;");
	});

	it("leaves an attribute-shaped payload with no way to close the attribute", () => {
		const attribute = `<a href="${escapeHtml('https://x" onmouseover="alert(1)')}">t</a>`;
		// The value contains no raw quote, so the attribute the parser sees is the
		// whole payload and no second attribute is created.
		expect(attribute.match(/href="([^"]*)"/)?.[1]).toBe("https://x&quot; onmouseover=&quot;alert(1)");
		// `href` is the only attribute a parser builds; the rest of the payload
		// stays inside its value.
		expect(tagAttributeNames(attribute)).toEqual([["href"]]);
	});

	it("does not depend on a DOM", () => {
		// A `document` reference here would throw, since none is in scope above.
		expect(escapeHtml('a"b<c&d')).toBe("a&quot;b&lt;c&amp;d");
	});

	it("renders a non-string without throwing", () => {
		expect(escapeHtml(undefined)).toBe("");
		expect(escapeHtml(null)).toBe("");
		expect(escapeHtml(42)).toBe("42");
	});
});

/** The complete set of attributes the shipped link renderer emits. */
const ATTRIBUTES_THE_RENDERER_WRITES = new Set(["href", "title", "target", "rel"]);

/**
 * The attribute names a parser would build for each tag in `html`.
 *
 * A value is read as `name="..."` up to the next quote, which is exactly the
 * greedy rule an HTML parser applies: if an escaped value still held a raw `"`,
 * the remainder of the payload is read as further attributes and shows up here.
 */
function tagAttributeNames(html: string): string[][] {
	return [...html.matchAll(/<([a-z]+)((?:\s+[a-zA-Z-]+="[^"]*")*)\s*\/?>/g)].map(tag =>
		[...tag[2]!.matchAll(/([a-zA-Z-]+)="[^"]*"/g)].map(attr => attr[1]!),
	);
}

describe("a link whose target carries a quote, through the shipped renderer", () => {
	// The renderer accepts `https:` and then interpolates the target into an
	// attribute, so the scheme check alone never prevented the breakout.
	const BREAKOUTS: Array<[name: string, markdown: string]> = [
		["a quote in an http target", '[t](https://x" onmouseover="alert\\(1\\))'],
		["a quote in a link title", '[t](https://x "a\\" onmouseover=\\"alert(1)")'],
		["a quote in the link text", '[a" onmouseover="alert(1)](https://example.com)'],
	];

	it.each(BREAKOUTS)("keeps %s inert", (_name, markdown) => {
		// Asserting on the rendered TEXT would pass for the wrong reason: an
		// escaped `onmouseover=&quot;` sitting in element content is inert and
		// still reads as the payload. What matters is the attributes a parser
		// would build, so each tag is split into name/value pairs and the names
		// are pinned.
		for (const names of tagAttributeNames(parse(markdown))) {
			expect(names.filter(n => n.startsWith("on"))).toEqual([]);
			expect(names).toEqual(names.filter(n => ATTRIBUTES_THE_RENDERER_WRITES.has(n)));
		}
	});

	it("still refuses a javascript: target", () => {
		expect(parse("[t](javascript:alert(1))")).not.toContain("javascript:");
	});

	it("still renders an ordinary link", () => {
		const html = parse("[example](https://example.com)");
		expect(html).toContain('href="https://example.com"');
		expect(html).toContain("example");
	});
});

describe("the viewer's attribute-position callers", () => {
	it("escapes every value it interpolates into an attribute", () => {
		// Pinned by exact equality: an attribute built from a value that is not
		// escaped turns this red rather than being counted as covered.
		const rawAttributeInterpolations = [
			...templateSource.matchAll(/(?:src|href|title|alt)="[^"\n]*\$\{([^}]*)\}/g),
		].map(m => m[1]!.trim());
		const unescaped = rawAttributeInterpolations.filter(expr => !expr.includes("escapeHtml("));
		expect(unescaped).toEqual([]);
	});
});
