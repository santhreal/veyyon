/**
 * Fuzz test for the syntax highlighter. `highlightCode` wraps the native
 * (Rust) highlighter and runs on every fenced code block in model output —
 * arbitrary, frequently-malformed source in any language, or none. A native
 * panic surfaces as a JS throw that would crash the transcript render, so it
 * must never throw and must always honor its contract of returning a string
 * array (falling back to the raw code split on newlines).
 *
 * Deterministic LCG so a failing (code, lang) pair reproduces from the seed.
 */
import { describe, expect, it } from "bun:test";
import { getThemeByName, highlightCode } from "@veyyon/coding-agent/modes/theme/theme";

// Minimal LCG (kept local; this package has no shared adversarial-string helper).
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x1_0000_0000;
	};
}

// Code-flavored adversarial fragments: unbalanced delimiters, unterminated
// strings/comments, keywords, operators, unicode/wide/emoji identifiers, control
// bytes, lone surrogates, deep nesting seeds, and newlines.
const FRAGMENTS: readonly string[] = [
	"function ",
	"const x =",
	"{",
	"}",
	"(",
	")",
	"[",
	"]",
	'"unterminated',
	"'",
	"`${",
	"/* unclosed",
	"// comment",
	"<div>",
	"</",
	"=>",
	"::",
	"async ",
	"await ",
	"return;",
	"\n",
	"\t",
	"    ",
	"日本語",
	"\u{1f600}",
	"\x00",
	"\x1b[31m",
	String.fromCharCode(0xd800),
	"0x",
	"1e999",
	";;;;",
	"\\",
	"#include",
	"def f():",
	"SELECT * FROM",
];

const LANGS = [
	undefined,
	"typescript",
	"javascript",
	"python",
	"rust",
	"json",
	"html",
	"sql",
	"bash",
	"not-a-language",
	"",
];

function buildCode(rand: () => number): string {
	const n = Math.floor(rand() * 50);
	let out = "";
	for (let i = 0; i < n; i++) out += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)];
	return out;
}

describe("highlightCode fuzz", () => {
	it("never throws and always returns a string array on adversarial code", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const rand = lcg(0x11_9c_0de);
		for (let iter = 0; iter < 6000; iter++) {
			const code = buildCode(rand);
			const lang = LANGS[Math.floor(rand() * LANGS.length)];
			let lines: string[];
			try {
				lines = highlightCode(code, lang, theme!);
			} catch (e) {
				throw new Error(`highlightCode(${JSON.stringify(code)}, ${lang}) threw: ${e}`);
			}
			expect(Array.isArray(lines)).toBe(true);
			for (const line of lines) expect(typeof line).toBe("string");
			// Contract: the highlighted line count matches the source line count
			// (styling is added inline, never adds/drops lines).
			expect(lines.length).toBe(code.split("\n").length);
		}
	});

	it("deeply nested code does not overflow the highlighter", async () => {
		const theme = await getThemeByName("dark");
		for (const depth of [500, 5000, 20000]) {
			const code = `${"{".repeat(depth)}x${"}".repeat(depth)}`;
			let lines: string[];
			try {
				lines = highlightCode(code, "json", theme!);
			} catch (e) {
				throw new Error(`highlightCode(nested depth ${depth}) threw: ${e}`);
			}
			expect(Array.isArray(lines)).toBe(true);
		}
	});
});
