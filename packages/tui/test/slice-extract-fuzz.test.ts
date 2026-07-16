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
 * Deterministic LCG so a failure reproduces from the printed seed input.
 */
import { describe, it } from "bun:test";
import { extractSegments, sliceWithWidth, visibleWidth } from "@veyyon/pi-tui";
import { buildString, lcg } from "./helpers/adversarial-strings";

// Column / length arguments, including the pathological ones a resize storm or a
// bad geometry read can produce.
const INDICES = [0, 1, 2, 3, 5, 8, 40, 200, -1, -5, 2 ** 31, Number.MAX_SAFE_INTEGER, 0.5, 3.9, Number.NaN];

function isNonNegInt(n: number): boolean {
	return Number.isInteger(n) && n >= 0;
}

describe("slice/extract fuzz invariants", () => {
	it("sliceWithWidth never throws and returns a coherent {text, width}", () => {
		const rand = lcg(0x5a1c_e00d);
		for (let iter = 0; iter < 8000; iter++) {
			const line = buildString(rand);
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
		}
	});

	it("sliceWithWidth (strict) never exceeds the requested length on realistic content", () => {
		// Strict mode caps the slice at `length` cells. Restrict to plain ASCII +
		// well-formed ANSI, where the native slice width and JS visibleWidth agree
		// (the broader native/JS oracle divergence is out of scope here — see
		// width-math-fuzz), so the cap can be asserted precisely.
		const ASCII = "the quick brown fox \x1b[31mjumps\x1b[0m over 0123456789 lazy dog";
		const rand = lcg(0x1abe_11ed);
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
		const rand = lcg(0xe57a_c701);
		for (let iter = 0; iter < 8000; iter++) {
			const line = buildString(rand);
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
		}
	});
});
