/**
 * Fuzz + adversarial tests for the LaTeX→unicode converter. `latexToUnicode`
 * and `renderMathInText` run on model-authored output, so malformed input —
 * unbalanced braces, unclosed commands, deep nesting, stray control sequences,
 * lone surrogates — must never throw, never hang (a non-advancing parse loop),
 * and never overflow the stack (a deeply nested payload is a trivial DoS).
 *
 * Deterministic LCG so a failure reproduces from the printed seed input.
 */
import { describe, expect, it } from "bun:test";
import { latexToUnicode, renderMathInText } from "@veyyon/tui";
import { FRAGMENTS, fuzzStrings } from "@veyyon/utils/adversarial-strings";

// LaTeX-flavored adversarial tokens on top of the generic fragment pool.
const LATEX_TOKENS: readonly string[] = [
	"{",
	"}",
	"\\frac",
	"\\sqrt",
	"\\frac{a}{b}",
	"\\sqrt{",
	"^",
	"_",
	"^{",
	"_{",
	"\\begin{matrix}",
	"\\end{matrix}",
	"\\begin{matrix}", // deliberately unbalanced
	"\\mathbb{",
	"\\text{",
	"\\overset",
	"\\substack",
	"&",
	"\\\\",
	"\\alpha",
	"\\notacommand",
	"$",
	"\\(",
	"\\)",
	"~",
	"\\&",
	"\\%",
	"'",
];

const POOL = [...LATEX_TOKENS, ...FRAGMENTS];

function buildLatex(rand: () => number): string {
	const n = Math.floor(rand() * 40);
	let out = "";
	for (let i = 0; i < n; i++) out += POOL[Math.floor(rand() * POOL.length)];
	return out;
}

/**
 * Inputs that broke the converter before, replayed first on every run and under every seed.
 *
 * Empty is the honest state. Add the string a failure's `corpus entry:` line prints, with a comment
 * naming the bug it locks out; see `docs/internal/fuzzing.md`.
 */
const LATEX_CORPUS: readonly string[] = [];

/** Same, for the mixed prose-and-math renderer. See {@link LATEX_CORPUS}. */
const MIXED_TEXT_CORPUS: readonly string[] = [];

describe("latex fuzz invariants", () => {
	it("latexToUnicode never throws or hangs on adversarial input", () => {
		fuzzStrings({ seed: 0x1a7e_5000, iterations: 8000, corpus: LATEX_CORPUS, build: buildLatex }, s => {
			let out: string;
			try {
				out = latexToUnicode(s);
			} catch (e) {
				throw new Error(`latexToUnicode(${JSON.stringify(s)}) threw: ${e}`);
			}
			if (typeof out !== "string") {
				throw new Error(`latexToUnicode(${JSON.stringify(s)}) returned ${typeof out}`);
			}
		});
	}, 30_000);

	it("renderMathInText never throws on adversarial mixed text", () => {
		fuzzStrings(
			{
				seed: 0x9a2b_7711,
				iterations: 6000,
				corpus: MIXED_TEXT_CORPUS,
				// Math delimiters around adversarial bodies, which is the shape the renderer sees in a
				// model's answer: inline `$...$` and `\(...\)` in one line of prose.
				build: rand => `prefix $${buildLatex(rand)}$ mid \\(${buildLatex(rand)}\\) tail`,
			},
			s => {
				try {
					const out = renderMathInText(s);
					expect(typeof out).toBe("string");
				} catch (e) {
					throw new Error(`renderMathInText(${JSON.stringify(s)}) threw: ${e}`);
				}
			},
		);
	}, 30_000);

	it("does not overflow the stack on deeply nested input", () => {
		// A model can emit arbitrarily nested braces/fractions; the converter must
		// bound its work rather than recurse until the stack blows (a DoS). The
		// `\sqrt[…]`/`\xrightarrow[…]` cases exercise the OPTIONAL-argument path,
		// which parses its `[…]` source in a child parser — that child must inherit
		// the parent's depth, or a nested-optional-arg chain launders past
		// `#MAX_DEPTH` and overflows the stack (regression: it did, throwing a
		// RangeError at depth ~8k and re-scanning O(n^2)).
		for (const depth of [200, 1000, 5000, 20000]) {
			const nestedBraces = `${"{".repeat(depth)}x${"}".repeat(depth)}`;
			const nestedFrac = `${"\\frac{a}".repeat(depth)}{b}`;
			const nestedScripts = `${"x^{".repeat(depth)}y${"}".repeat(depth)}`;
			const nestedSqrtOpt = `${"\\sqrt[".repeat(depth)}2${"]{x}".repeat(depth)}`;
			const nestedXarrowOpt = `${"\\xrightarrow[".repeat(depth)}a${"]{b}".repeat(depth)}`;
			for (const payload of [nestedBraces, nestedFrac, nestedScripts, nestedSqrtOpt, nestedXarrowOpt]) {
				let out: string;
				try {
					out = latexToUnicode(payload);
				} catch (e) {
					throw new Error(`latexToUnicode(nested depth ${depth}) threw: ${e}`);
				}
				expect(typeof out).toBe("string");
			}
		}
	}, 30_000);

	// 30s timeouts on these fuzz loops: on a saturated gate machine (parallel=4
	// full run) wall-clock triples vs isolated and races bun's 5s default.
	it("optional-argument nesting stays bounded and shallow math is unaffected", () => {
		// The depth guard degrades a deep optional-arg chain to literal text without
		// crashing; a huge payload must complete in roughly linear time (the old
		// fresh-parser laundering was quadratic — 5k-deep took ~750ms and 10k-deep
		// blew the stack). 100k-deep here is ~1.4MB of input and must return.
		const attack = `${"\\sqrt[".repeat(100_000)}2${"]{x}".repeat(100_000)}`;
		expect(typeof latexToUnicode(attack)).toBe("string");
		// Real (shallow) optional-argument math is untouched by the fix.
		expect(latexToUnicode("\\sqrt[3]{x}")).toBe("∛x");
		expect(latexToUnicode("\\sqrt[3]{abc}")).toBe("∛(abc)");
		expect(latexToUnicode("\\xrightarrow[n\\to\\infty]{f}")).toBe("→ᶠ_(n→∞)");
	}, 30_000);
});
