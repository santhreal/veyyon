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
import { latexToUnicode, renderMathInText } from "@veyyon/pi-tui";
import { FRAGMENTS, lcg } from "./helpers/adversarial-strings";

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

describe("latex fuzz invariants", () => {
	it("latexToUnicode never throws or hangs on adversarial input", () => {
		const rand = lcg(0x1a7e_5000);
		for (let iter = 0; iter < 8000; iter++) {
			const s = buildLatex(rand);
			let out: string;
			try {
				out = latexToUnicode(s);
			} catch (e) {
				throw new Error(`latexToUnicode(${JSON.stringify(s)}) threw: ${e}`);
			}
			if (typeof out !== "string") {
				throw new Error(`latexToUnicode(${JSON.stringify(s)}) returned ${typeof out}`);
			}
		}
	});

	it("renderMathInText never throws on adversarial mixed text", () => {
		const rand = lcg(0x9a2b_7711);
		for (let iter = 0; iter < 6000; iter++) {
			const s = `prefix $${buildLatex(rand)}$ mid \\(${buildLatex(rand)}\\) tail`;
			try {
				const out = renderMathInText(s);
				expect(typeof out).toBe("string");
			} catch (e) {
				throw new Error(`renderMathInText(${JSON.stringify(s)}) threw: ${e}`);
			}
		}
	});

	it("does not overflow the stack on deeply nested input", () => {
		// A model can emit arbitrarily nested braces/fractions; the converter must
		// bound its work rather than recurse until the stack blows (a DoS).
		for (const depth of [200, 1000, 5000, 20000]) {
			const nestedBraces = "{".repeat(depth) + "x" + "}".repeat(depth);
			const nestedFrac = "\\frac{a}".repeat(depth) + "{b}";
			const nestedScripts = "x^{".repeat(depth) + "y" + "}".repeat(depth);
			for (const payload of [nestedBraces, nestedFrac, nestedScripts]) {
				let out: string;
				try {
					out = latexToUnicode(payload);
				} catch (e) {
					throw new Error(`latexToUnicode(nested depth ${depth}) threw: ${e}`);
				}
				expect(typeof out).toBe("string");
			}
		}
	});
});
