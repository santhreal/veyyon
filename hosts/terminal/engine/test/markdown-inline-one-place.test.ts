import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { MarkdownTheme } from "../src/components/markdown";
import { renderInlineMarkdown } from "../src/components/markdown";

// A theme whose style functions wrap their argument in distinctive, ANSI-free
// markers. Rendering through it turns the styled output into a readable string
// we can assert byte-for-byte, so any drift in the inline-token grammar (a
// reordered case, a dropped `+ stylePrefix`, a re-inlined second switch) changes
// these expectations and fails the lock. `baseColor` is identity, so the
// `stylePrefix` (= applyText("")) appended after each styled span is "".
const MARKER_THEME = {
	bold: (t: string) => `⟪b:${t}⟫`,
	italic: (t: string) => `⟪i:${t}⟫`,
	code: (t: string) => `⟪c:${t}⟫`,
	strikethrough: (t: string) => `⟪s:${t}⟫`,
	link: (t: string) => `⟪a:${t}⟫`,
	underline: (t: string) => `⟪u:${t}⟫`,
	linkUrl: (t: string) => `⟪url:${t}⟫`,
} as unknown as MarkdownTheme;

describe("renderInlineMarkdown byte-identity corpus", () => {
	// Each row is the exact styled string the standalone inline renderer produces
	// for a representative inline construct. Locked so the shared walker keeps the
	// standalone's single-line subset (no swatches, no OSC-8 links, no block cases).
	const CASES: Array<[string, string]> = [
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
		// tail (that is the rich hyperlink path) and never emits OSC-8 escapes.
		["[text](https://a.example)", "⟪a:⟪u:text⟫⟫"],
		// Autolink whose text equals its href renders once, still with no tail.
		["<https://a.example>", "⟪a:⟪u:https://a.example⟫⟫"],
		// A link whose label is itself styled.
		["[**b**](https://a.example)", "⟪a:⟪u:⟪b:b⟫⟫⟫"],
		// HTML entities are decoded to their terminal glyphs.
		["a &amp; b &lt;c&gt;", "a & b <c>"],
	];

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

describe("inline-token grammar one-place lock", () => {
	it("keeps a single styled inline-token switch, with both renderers delegating to it", async () => {
		const source = await readFile(path.join(import.meta.dir, "../src/components/markdown.ts"), "utf8");

		// The styled inline grammar uses block-form `case "…": {` labels inside
		// walkInlineTokens. The plain-text projection (plainInlineTokens) uses the
		// bare `case "…":` form and is a legitimately separate concern, so counting
		// the braced form pins exactly the styled dispatch.
		const countBraced = (label: string): number => source.split(`case "${label}": {`).length - 1;
		expect(countBraced("strong"), "styled `strong` case must live in exactly one switch").toBe(1);
		expect(countBraced("em"), "styled `em` case must live in exactly one switch").toBe(1);
		expect(countBraced("codespan"), "styled `codespan` case must live in exactly one switch").toBe(1);
		expect(countBraced("del"), "styled `del` case must live in exactly one switch").toBe(1);

		// Both the component renderer and the standalone must route through the
		// shared walker rather than re-implement the switch.
		const walkerCalls = source.split("walkInlineTokens(tokens, {").length - 1;
		expect(walkerCalls, "#renderInlineTokensInner and renderInlineTokens must both call walkInlineTokens").toBe(2);
	});
});
