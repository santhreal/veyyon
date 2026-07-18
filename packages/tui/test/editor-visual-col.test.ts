/**
 * Coverage for the editor's visual-column ↔ code-unit mapping
 * (`visualColAtOffset` / `offsetAtVisualCol` / `maxSegmentVisualCol` in
 * editor.ts) — the math behind up/down cursor navigation and preferred-column
 * memory across wrapped lines. These are width-aware (a CJK char is 2 cells, an
 * emoji cluster is one grapheme of width ≥ 2) and had no direct tests. A bug
 * here lands the cursor a cell off or mid-cluster on vertical nav.
 *
 * Beyond exact-value cases this locks the invariants vertical nav relies on:
 *   1. offsetAtVisualCol always returns a grapheme-cluster boundary — a column
 *      that falls in the middle of a wide char/cluster snaps to the cluster
 *      start, never between surrogate halves.
 *   2. Both maps are monotonic non-decreasing in their input.
 *   3. Column round-trip: col→offset→col preserves the visual column at every
 *      boundary (offset can't round-trip exactly across zero-width graphemes).
 *   4. Neither throws on adversarial Unicode.
 */
import { describe, expect, it } from "bun:test";
import { maxSegmentVisualCol, offsetAtVisualCol, visualColAtOffset } from "@veyyon/tui/components/editor";
import { getSegmenter, visibleWidth } from "@veyyon/tui/utils";
import { lcg } from "./helpers/adversarial-strings";

/** Grapheme-cluster boundaries (code-unit indices, incl. 0 and length). */
function boundaries(text: string): Set<number> {
	const set = new Set<number>([0]);
	let i = 0;
	for (const { segment } of getSegmenter().segment(text)) {
		i += segment.length;
		set.add(i);
	}
	return set;
}

// Sum per-grapheme visibleWidth exactly as visualColAtOffset does, so the width
// assertions can't diverge from the source's own width model.
function totalWidth(text: string): number {
	let w = 0;
	for (const { segment } of getSegmenter().segment(text)) w += visibleWidth(segment);
	return w;
}

describe("visual-col mapping — exact behavior", () => {
	// "a中b": a=1 cell @off0, 中=2 cells @off1, b=1 cell @off2; total 4 cells.
	const t = "a中b";

	it("maps offsets to visual columns across a wide char", () => {
		expect(visualColAtOffset(t, 0)).toBe(0);
		expect(visualColAtOffset(t, 1)).toBe(1); // after "a"
		expect(visualColAtOffset(t, 2)).toBe(3); // after the width-2 "中"
		expect(visualColAtOffset(t, 3)).toBe(4); // end
	});

	it("maps visual columns back to offsets, snapping into a wide char to its start", () => {
		expect(offsetAtVisualCol(t, 0)).toBe(0);
		expect(offsetAtVisualCol(t, 1)).toBe(1); // start of "中"
		expect(offsetAtVisualCol(t, 2)).toBe(1); // MID "中" snaps back to its start
		expect(offsetAtVisualCol(t, 3)).toBe(2); // after "中"
		expect(offsetAtVisualCol(t, 4)).toBe(3); // end
		expect(offsetAtVisualCol(t, 99)).toBe(3); // past end clamps to length
	});

	it("reports the max cursor column per wrap segment", () => {
		expect(maxSegmentVisualCol(t, true)).toBe(4); // last segment: full width
		expect(maxSegmentVisualCol(t, false)).toBe(3); // non-last: before the final grapheme
	});

	it("never splits an emoji cluster when snapping a mid-cluster column", () => {
		const s = "👨‍👩‍👧x"; // family cluster (8 units, 2 cells) then "x"
		expect(offsetAtVisualCol(s, 1)).toBe(0); // mid-cluster column → cluster start
		expect(visualColAtOffset(s, s.length)).toBe(totalWidth(s));
	});
});

describe("visual-col mapping — invariants (fuzz)", () => {
	const FRAGMENTS: readonly string[] = [
		"a",
		"Z",
		" ",
		"中",
		"日本",
		"👨‍👩‍👧",
		"🇺🇸",
		"é",
		"\u{1f600}",
		"\t",
		"1",
		String.fromCharCode(0xd800),
		"~",
	];

	function build(rand: () => number): string {
		const n = Math.floor(rand() * 16);
		let out = "";
		for (let k = 0; k < n; k++) out += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)];
		return out;
	}

	it("offsetAtVisualCol always lands on a grapheme boundary; both maps stay monotonic", () => {
		const rand = lcg(0x2b_9d_f0_01);
		for (let iter = 0; iter < 15_000; iter++) {
			const text = build(rand);
			const bounds = boundaries(text);
			const width = totalWidth(text);

			let prevOffset = 0;
			for (let col = 0; col <= width + 3; col++) {
				let off: number;
				try {
					off = offsetAtVisualCol(text, col);
				} catch (e) {
					throw new Error(`offsetAtVisualCol(${JSON.stringify(text)}, ${col}) threw: ${e}`);
				}
				expect(bounds.has(off)).toBe(true); // 1. grapheme boundary
				expect(off).toBeGreaterThanOrEqual(prevOffset); // 2. monotonic
				prevOffset = off;
			}

			let prevCol = 0;
			for (let off = 0; off <= text.length; off++) {
				const col = visualColAtOffset(text, off);
				expect(col).toBeGreaterThanOrEqual(prevCol); // 2. monotonic
				prevCol = col;
			}
			expect(visualColAtOffset(text, 0)).toBe(0);
			expect(visualColAtOffset(text, text.length)).toBe(width);
		}
		// 30s timeout: on a saturated gate machine (parallel=4 full run) this
		// 15k-iter fuzz loop races bun's 5s default despite passing in ~2s isolated.
	}, 30_000);

	it("col→offset→col round-trips the visual column at every boundary", () => {
		// Offset round-trip can't be exact when zero-width graphemes (combining
		// marks, ZWJ) put two boundaries at the same column — offsetAtVisualCol
		// then snaps past the zero-width mark to the next visible boundary. The
		// invariant that always holds (and that vertical nav depends on) is that
		// the *column* survives the round-trip, and the recovered offset is itself
		// a grapheme boundary.
		const rand = lcg(0x77_c0_ff_ee);
		for (let iter = 0; iter < 8000; iter++) {
			const text = build(rand);
			const bounds = boundaries(text);
			for (const b of bounds) {
				const col = visualColAtOffset(text, b);
				const off = offsetAtVisualCol(text, col);
				expect(bounds.has(off)).toBe(true);
				expect(visualColAtOffset(text, off)).toBe(col);
			}
		}
	}, 30_000);
});
