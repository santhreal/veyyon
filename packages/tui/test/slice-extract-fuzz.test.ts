/**
 * Fuzz + property tests for the ANSI-aware column primitives sliceWithWidth and
 * extractSegments. Both are Rust natives on the overlay/seam-repaint hot path in
 * tui.ts (partial-repaint compositing), fed line content that can contain
 * adversarial UTF-16 — lone surrogates, malformed ANSI/OSC, combining /
 * zero-width / wide graphemes — at arbitrary (possibly negative, fractional,
 * huge, NaN) column indices. They must never panic and must return coherent
 * results: string fields are strings and every reported width is a finite
 * non-negative integer.
 *
 * Driven by `fuzzStrings`, so a failing line is reported SHRUNK to the fragment that broke it
 * rather than as the 300-character string it arrived in, and so any past failure written into the
 * corpus below is replayed before a single new input is drawn. See `docs/internal/fuzzing.md`.
 */
import { describe, it } from "bun:test";
import { extractSegments, sliceWithWidth, visibleWidth } from "@veyyon/tui";
// `fuzzStrings` for the two cases that need adversarial CONTENT; the raw generator for the
// strict-cap case, whose input is a fixed ASCII line and whose only randomness is the columns.
import { fuzzSeed, fuzzStrings, lcg } from "@veyyon/utils/adversarial-strings";

// Column / length arguments, including the pathological ones a resize storm or a
// bad geometry read can produce.
const INDICES = [0, 1, 2, 3, 5, 8, 40, 200, -1, -5, 2 ** 31, Number.MAX_SAFE_INTEGER, 0.5, 3.9, Number.NaN];

function isNonNegInt(n: number): boolean {
	return Number.isInteger(n) && n >= 0;
}

/**
 * Lines that broke these primitives before, replayed first on every run and under every seed.
 *
 * Empty is the honest state: nothing has failed since `fuzzStrings` started reporting a
 * paste-ready `corpus entry:` line. Add the entry a failure prints, with the bug it locks out in a
 * comment beside it.
 */
const SLICE_CORPUS: readonly string[] = [];

/** Same, for `extractSegments`. See {@link SLICE_CORPUS}. */
const EXTRACT_CORPUS: readonly string[] = [];

describe("slice/extract fuzz invariants", () => {
	it("sliceWithWidth never throws and returns a coherent {text, width}", () => {
		fuzzStrings({ seed: 0x5a1c_e00d, iterations: 8000, corpus: SLICE_CORPUS }, (line, rand) => {
			const startCol = INDICES[Math.floor(rand() * INDICES.length)]!;
			const length = INDICES[Math.floor(rand() * INDICES.length)]!;
			const strict = rand() < 0.5;
			let result: { text: string; width: number };
			try {
				result = sliceWithWidth(line, startCol, length, strict);
			} catch (e) {
				throw new Error(`sliceWithWidth(${JSON.stringify(line)}, ${startCol}, ${length}, ${strict}) threw: ${e}`);
			}
			if (typeof result.text !== "string") {
				throw new Error(`sliceWithWidth text is not a string: ${JSON.stringify(result)}`);
			}
			if (!isNonNegInt(result.width)) {
				throw new Error(
					`sliceWithWidth(${JSON.stringify(line)}, ${startCol}, ${length}, ${strict}) width=${result.width} not a non-negative integer`,
				);
			}
		});
	});

	it("sliceWithWidth (strict) never exceeds the requested length on realistic content", () => {
		// Strict mode caps the slice at `length` cells. Restrict to plain ASCII +
		// well-formed ANSI, where the native slice width and JS visibleWidth agree
		// (the broader native/JS oracle divergence is out of scope here — see
		// width-math-fuzz), so the cap can be asserted precisely.
		const ASCII = "the quick brown fox \x1b[31mjumps\x1b[0m over 0123456789 lazy dog";
		const rand = lcg(fuzzSeed(0x1abe_11ed));
		for (let iter = 0; iter < 4000; iter++) {
			const start = Math.floor(rand() * 40);
			const length = 1 + Math.floor(rand() * 30);
			const result = sliceWithWidth(ASCII, start, length, true);
			if (result.width > length) {
				throw new Error(`strict slice width ${result.width} > requested ${length}: ${JSON.stringify(result.text)}`);
			}
			if (visibleWidth(result.text) > length) {
				throw new Error(
					`strict slice visibleWidth ${visibleWidth(result.text)} > requested ${length}: ${JSON.stringify(result.text)}`,
				);
			}
		}
	});

	it("extractSegments never throws and returns coherent before/after widths", () => {
		fuzzStrings({ seed: 0xe57a_c701, iterations: 8000, corpus: EXTRACT_CORPUS }, (line, rand) => {
			const beforeEnd = INDICES[Math.floor(rand() * INDICES.length)]!;
			const afterStart = INDICES[Math.floor(rand() * INDICES.length)]!;
			const afterLen = INDICES[Math.floor(rand() * INDICES.length)]!;
			const strictAfter = rand() < 0.5;
			let result: { before: string; beforeWidth: number; after: string; afterWidth: number };
			try {
				result = extractSegments(line, beforeEnd, afterStart, afterLen, strictAfter);
			} catch (e) {
				throw new Error(
					`extractSegments(${JSON.stringify(line)}, ${beforeEnd}, ${afterStart}, ${afterLen}, ${strictAfter}) threw: ${e}`,
				);
			}
			if (typeof result.before !== "string" || typeof result.after !== "string") {
				throw new Error(`extractSegments returned non-string segment: ${JSON.stringify(result)}`);
			}
			if (!isNonNegInt(result.beforeWidth) || !isNonNegInt(result.afterWidth)) {
				throw new Error(
					`extractSegments(${JSON.stringify(line)}, ${beforeEnd}, ${afterStart}, ${afterLen}, ${strictAfter}) widths=(${result.beforeWidth}, ${result.afterWidth}) not non-negative integers`,
				);
			}
		});
	});
});
