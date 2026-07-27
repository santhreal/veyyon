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
// The fuzz driver is shared, not copied. This file carried a byte-identical
// `lcg` because the only implementation lived under `packages/tui/test/`, which is
// not importable from here; two copies of a seeded RNG mean "the same seed" stops
// meaning the same stream the moment either is tuned. The FRAGMENTS below stay
// local on purpose -- they are code-flavored, not the shared width-adversarial pool.
import { fuzzStrings } from "@veyyon/utils/adversarial-strings";

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

/**
 * Sources that broke the highlighter before, replayed first on every run and under every seed.
 *
 * Empty is the honest state. Add the string a failure's `corpus entry:` line prints, with a comment
 * naming the bug it locks out; see `docs/internal/fuzzing.md`.
 */
const HIGHLIGHT_CORPUS: readonly string[] = [];

describe("highlightCode fuzz", () => {
	it("never throws and always returns a string array on adversarial code", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		fuzzStrings({ seed: 0x11_9c_0de, iterations: 6000, corpus: HIGHLIGHT_CORPUS, build: buildCode }, (code, rand) => {
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
		});
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
