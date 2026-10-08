/**
 * WHY: the inline-token grammar (text, strong, em, codespan, del, link, html,
 * math) once existed as two hand-copied switches, one in the Markdown component
 * and one in the standalone `renderInlineMarkdown`, and the copies drifted. The
 * class this closes is the two renderers styling a shared inline construct
 * differently: every corpus row renders through both and must produce the same
 * bytes, apart from the ` (href)` tail the component appends to a link whose
 * text differs from its target. A second copy of the grammar that drifts in
 * either renderer fails the differential; a drift in the shared walker fails the
 * byte-identity rows.
 *
 * What it does not catch: constructs outside the corpus, and the component-only
 * features the standalone omits by design (color swatches, OSC-8 escapes,
 * paragraph and line-break cases, HTML list state).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { MarkdownTheme } from "../src/components/markdown";
import { clearRenderCache, Markdown, renderInlineMarkdown } from "../src/components/markdown";
import { TERMINAL } from "../src/terminal-capabilities";
import { defaultMarkdownTheme } from "./test-themes";

// A theme whose inline style functions wrap their argument in distinctive,
// ANSI-free markers. Rendering through it turns the styled output into a
// readable string we can assert byte-for-byte, so any drift in the inline-token
// grammar (a reordered case, a dropped `+ stylePrefix`, a second switch) changes
// these expectations. `baseColor` is identity, so the `stylePrefix`
// (= applyText("")) appended after each styled span is "".
const MARKER_THEME: MarkdownTheme = {
	...defaultMarkdownTheme,
	bold: (t: string) => `⟪b:${t}⟫`,
	italic: (t: string) => `⟪i:${t}⟫`,
	code: (t: string) => `⟪c:${t}⟫`,
	strikethrough: (t: string) => `⟪s:${t}⟫`,
	link: (t: string) => `⟪a:${t}⟫`,
	underline: (t: string) => `⟪u:${t}⟫`,
	linkUrl: (t: string) => `⟪url:${t}⟫`,
};

// Each row is an inline construct, the exact styled string the standalone inline
// renderer produces for it, and the tail the Markdown component appends after it
// (the ` (href)` of a link whose text is not its target), if any.
const CASES: Array<[input: string, expected: string, componentTail?: string]> = [
	["plain text", "plain text"],
	["**bold**", "⟪b:bold⟫"],
	["_em_", "⟪i:em⟫"],
	["`code`", "⟪c:code⟫"],
	["~~gone~~", "⟪s:gone⟫"],
	["**bold** _em_ `code`", "⟪b:bold⟫ ⟪i:em⟫ ⟪c:code⟫"],
	// Nested emphasis: strong holding em holding text.
	["**_x_**", "⟪b:⟪i:x⟫⟫"],
	// del holding strong.
	["~~**x**~~", "⟪s:⟪b:x⟫⟫"],
	// Inline link with explicit text — the standalone never appends the ` (href)`
	// tail (that is the component's link path) and never emits OSC-8 escapes.
	["[text](https://a.example)", "⟪a:⟪u:text⟫⟫", "⟪url: (https://a.example)⟫"],
	// Autolink whose text equals its href renders once, with no tail in either.
	["<https://a.example>", "⟪a:⟪u:https://a.example⟫⟫"],
	// A link whose label is itself styled.
	["[**b**](https://a.example)", "⟪a:⟪u:⟪b:b⟫⟫⟫", "⟪url: (https://a.example)⟫"],
	// HTML entities are decoded to their terminal glyphs.
	["a &amp; b &lt;c&gt;", "a & b <c>"],
];

describe("renderInlineMarkdown byte-identity corpus", () => {
	// Locked so the shared walker keeps the standalone's single-line subset (no
	// swatches, no OSC-8 links, no block cases).
	for (const [input, expected] of CASES) {
		it(`renders ${JSON.stringify(input)} exactly`, () => {
			expect(renderInlineMarkdown(input, MARKER_THEME)).toBe(expected);
		});
	}

	it("threads a base color through every emitted segment", () => {
		const braced = renderInlineMarkdown("**bold** and text", MARKER_THEME, t => `{${t}}`);
		// baseColor wraps every applied segment: the bold span's inner text becomes
		// {bold}, the reset (applyText("") = "{}") lands after it, and the trailing
		// text leaf is wrapped as { and text}.
		expect(braced).toBe("⟪b:{bold}⟫{}{ and text}");
	});
});

describe("the Markdown component styles the shared inline subset as renderInlineMarkdown does", () => {
	// OSC-8 escapes are the component's alone; with them off a link's bytes are
	// comparable. The render cache keys on TERMINAL.hyperlinks, so flipping the
	// bit invalidates entries.
	const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
	const originalHyperlinks = terminalState.hyperlinks;
	beforeAll(() => {
		terminalState.hyperlinks = false;
	});
	afterAll(() => {
		terminalState.hyperlinks = originalHyperlinks;
		clearRenderCache();
	});

	for (const [input, , componentTail = ""] of CASES) {
		it(`renders ${JSON.stringify(input)} as the standalone's one row`, () => {
			const standalone = renderInlineMarkdown(input, MARKER_THEME);
			expect(new Markdown(input, 0, 0, MARKER_THEME).render(200)).toEqual([standalone + componentTail]);
		});
	}
});
