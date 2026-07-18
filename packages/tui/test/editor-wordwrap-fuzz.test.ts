/**
 * Fuzz + invariant tests for the editor's line word-wrapper.
 *
 * `wordWrapLine` splits one buffer line into layout chunks, and each chunk
 * carries [startIndex, endIndex) offsets back into the ORIGINAL line. The editor
 * uses those offsets to map a cursor position to a layout line, so a chunk whose
 * indices fall out of range or go backwards would land the cursor on the wrong
 * character — corrupting the next insert/delete. It runs on every line the user
 * or model produces (mixed wide/combining/ZWJ graphemes, control bytes, long
 * unbreakable tokens), so it must never throw and must always emit in-range,
 * forward-ordered indices, at any width.
 *
 * Deterministic LCG so a failing (line, width) pair reproduces from the seed.
 */
import { describe, expect, it } from "bun:test";
import { wordWrapLine } from "@veyyon/tui/components/editor";
import { getSegmenter, visibleWidth } from "@veyyon/tui/utils";
import { buildString, lcg } from "./helpers/adversarial-strings";

const WIDTHS = [0, 1, 2, 3, 5, 8, 20, -1, Number.NaN, Number.POSITIVE_INFINITY];

function graphemeCount(text: string): number {
	let n = 0;
	for (const _ of getSegmenter().segment(text)) n++;
	return n;
}

function assertChunkInvariants(line: string, chunks: ReturnType<typeof wordWrapLine>): void {
	expect(Array.isArray(chunks)).toBe(true);
	expect(chunks.length).toBeGreaterThan(0); // always at least one (possibly empty) chunk
	let prevStart = -1;
	for (const chunk of chunks) {
		expect(typeof chunk.text).toBe("string");
		// Indices are valid code-unit offsets into the original line, ordered
		// start <= end, and never past the line's end.
		expect(Number.isInteger(chunk.startIndex)).toBe(true);
		expect(Number.isInteger(chunk.endIndex)).toBe(true);
		expect(chunk.startIndex).toBeGreaterThanOrEqual(0);
		expect(chunk.endIndex).toBeGreaterThanOrEqual(chunk.startIndex);
		expect(chunk.endIndex).toBeLessThanOrEqual(line.length);
		// Start offsets advance (or hold) across chunks — never rewind, or a later
		// cursor position would resolve to an earlier layout line.
		expect(chunk.startIndex).toBeGreaterThanOrEqual(prevStart);
		prevStart = chunk.startIndex;
	}
}

describe("wordWrapLine fuzz invariants", () => {
	it("never throws and emits in-range, forward-ordered chunk indices", () => {
		const rand = lcg(0x2ec_0_a11);
		for (let iter = 0; iter < 10000; iter++) {
			const line = buildString(rand);
			for (const width of WIDTHS) {
				let chunks: ReturnType<typeof wordWrapLine>;
				try {
					chunks = wordWrapLine(line, width);
				} catch (e) {
					throw new Error(`wordWrapLine(${JSON.stringify(line)}, ${width}) threw: ${e}`);
				}
				assertChunkInvariants(line, chunks);
			}
		}
	});

	it("returns the whole line as one chunk when it already fits", () => {
		// A line at or under the width is not split; the single chunk spans it.
		const chunks = wordWrapLine("hello world", 80);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]!.text).toBe("hello world");
		expect(chunks[0]!.startIndex).toBe(0);
		expect(chunks[0]!.endIndex).toBe("hello world".length);
	});

	it("breaks an unbreakable long token into width-bounded pieces", () => {
		// A single token wider than maxWidth falls back to grapheme wrapping; each
		// piece (plain ASCII, so the width oracle is unambiguous) fits the width.
		const chunks = wordWrapLine("a".repeat(50), 10);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(10);
	});

	it("keeps every chunk within the visible width, even with wide/CJK graphemes", () => {
		// The layout contract that matters for wide characters: a chunk's VISIBLE
		// width (a CJK char is 2 cells) never exceeds maxWidth — the only exception
		// is a single grapheme cluster wider than maxWidth (e.g. a 2-cell char at
		// width 1), which physically cannot be split, so it stands alone. A wrapper
		// that miscounts wide-char width would overflow the viewport and corrupt the
		// rendered column layout.
		//
		// Scoped to a CLEAN pool (letters / CJK / emoji / combining / spaces): a raw
		// ANSI/OSC escape split across a wrap boundary leaves a fragment whose width
		// is inherently ambiguous (the JS `visibleWidth` oracle and the wrapper
		// disagree on partial escapes — the known width-model divergence), and editor
		// buffer lines are plain typed text, not escape sequences. The escape-heavy
		// path is already covered by the never-throws / in-range-indices fuzz above.
		const CLEAN: readonly string[] = [
			"a",
			"Word",
			" ",
			"  ",
			"中",
			"日本語",
			"👨‍👩‍👧",
			"🇯🇵",
			"é",
			"\u{1f600}",
			"-",
			"'",
			"x1",
			"。",
		];
		const rand = lcg(0x9a_5c_11_fe);
		for (let iter = 0; iter < 8000; iter++) {
			const n = Math.floor(rand() * 24);
			let line = "";
			for (let k = 0; k < n; k++) line += CLEAN[Math.floor(rand() * CLEAN.length)];
			for (const width of [1, 2, 3, 5, 8, 13]) {
				for (const chunk of wordWrapLine(line, width)) {
					const w = visibleWidth(chunk.text);
					if (w > width) {
						// Only tolerated when the chunk is a lone, unsplittable grapheme.
						expect(graphemeCount(chunk.text)).toBe(1);
					}
				}
			}
		}
	});

	it("gives exact packing for known wide-char lines", () => {
		// 2-cell CJK chars pack two-per-line at width 4, with the remainder alone.
		expect(wordWrapLine("中中中中中", 4).map(c => c.text)).toEqual(["中中", "中中", "中"]);
		// Mixed 1-/2-cell greedily fills width 3: "a中"(3) "b中"(3) "c中"(3) "d"(1).
		expect(wordWrapLine("a中b中c中d", 3).map(c => c.text)).toEqual(["a中", "b中", "c中", "d"]);
		// At width 1 each 2-cell char stands alone (unsplittable, tolerated overflow).
		expect(wordWrapLine("中中", 1).map(c => c.text)).toEqual(["中", "中"]);
	});
});
