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
import { wordWrapLine } from "@veyyon/pi-tui/components/editor";
import { buildString, lcg } from "./helpers/adversarial-strings";

const WIDTHS = [0, 1, 2, 3, 5, 8, 20, -1, Number.NaN, Number.POSITIVE_INFINITY];

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
});
