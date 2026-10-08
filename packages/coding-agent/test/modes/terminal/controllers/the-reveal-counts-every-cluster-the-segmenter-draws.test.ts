/**
 * WHY THIS SUITE EXISTS. The streaming reveal counts and slices an answer in grapheme clusters.
 * It walks a run of ASCII one code unit per cluster without the segmenter and hands only the
 * stretches around non-ASCII units to `Intl.Segmenter`. A boundary the walk draws where the
 * segmenter draws none splits a cluster on screen: an accent revealed a frame after its letter, a
 * keycap or a flag torn in half, a CR revealed without its LF.
 *
 * THE CLASS: every code unit that joins an ASCII neighbour into one cluster, on either side, and
 * every ASCII class the segmentation rules single out (CR, LF, other controls, everything else).
 * The sweep builds those neighbourhoods out of every BMP code unit and every code point of the
 * astral blocks that hold joiners, prepends, emoji, modifiers, regional indicators and tags, rather
 * than out of a list of joiners someone remembered.
 *
 * WHAT IT DOES NOT CATCH: a disagreement between `Intl.Segmenter` and UAX #29 itself. The segmenter
 * is the reference here, as it is for every other grapheme walk in the product.
 */
import { describe, expect, it } from "bun:test";
import { BlockUnitCounter } from "@veyyon/coding-agent/modes/terminal/controllers/streaming-reveal";
import { getSegmenter } from "@veyyon/utils/width";

/** The code-unit end of every cluster `Intl.Segmenter` draws over the whole of `text`. */
function referenceEnds(text: string): number[] {
	const ends: number[] = [];
	for (const { index, segment } of getSegmenter().segment(text)) ends.push(index + segment.length);
	return ends;
}

/** Each ASCII grapheme class, on both sides of `unit`: other, LF, CR, another control. */
function neighbourhoods(unit: string): string {
	return `x${unit}y\n${unit}\r${unit}\r\n\t${unit}\u007f${unit}x`;
}

/** Every code unit 0x80-0xFFFF (lone surrogates included) and every code point of `astral`. */
function sweep(astral: ReadonlyArray<readonly [number, number]>): string[] {
	const parts: string[] = [];
	for (let unit = 0x80; unit <= 0xffff; unit++) parts.push(neighbourhoods(String.fromCharCode(unit)));
	for (const [from, to] of astral) {
		for (let point = from; point <= to; point++) parts.push(neighbourhoods(String.fromCodePoint(point)));
	}
	return parts;
}

/** Brahmi to Kaithi (Prepend and SpacingMark), every emoji block, and the tag characters. */
const ASTRAL_JOINER_BLOCKS: ReadonlyArray<readonly [number, number]> = [
	[0x11000, 0x110ff],
	[0x1f000, 0x1faff],
	[0xe0000, 0xe007f],
];

describe("the reveal counts every cluster the segmenter draws", () => {
	const text = sweep(ASTRAL_JOINER_BLOCKS).join("");
	const ends = referenceEnds(text);

	it("counts the clusters of a text the segmenter counts, next to every non-ASCII unit", () => {
		expect(new BlockUnitCounter().count(0, text)).toBe(ends.length);
	});

	it("ends each revealed prefix where the segmenter ends that cluster", () => {
		// One unit at a time, so every slice resumes from the cluster the previous one ended in.
		const counter = new BlockUnitCounter();
		const misplaced: { units: number; got: number; want: number }[] = [];
		for (let units = 1; units <= ends.length && misplaced.length < 5; units++) {
			const got = counter.slice(0, text, units).length;
			const want = ends[units - 1]!;
			if (got !== want) misplaced.push({ units, got, want });
		}
		expect(misplaced).toEqual([]);
	});

	it("keeps count and slice on the segmenter's clusters while an answer streams in pieces", () => {
		// Each piece can join the cluster the previous text ended in: an accent after a letter, a
		// joiner after an emoji, an LF after a CR, a second regional indicator after the first.
		const pieces = [
			"a",
			"bc ",
			"\r",
			"\n",
			"e",
			"\u0301",
			"\u200d",
			"\ud83d\udc69",
			"\ufe0f",
			"\u20e3",
			"#",
			"\ud83c\uddfa",
			"\ud83c\uddf8",
			"\u0600",
			"1",
			"\u0903",
			"\t",
			"\u{1f3fd}",
			"\ud83d",
			"\udc4d",
			" z",
		];
		let state = 0x5eed1234;
		const next = (): number => {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			return (state >>> 0) / 0x100000000;
		};
		const counter = new BlockUnitCounter();
		let streamed = "";
		let revealed = 0;
		for (let step = 0; step < 600; step++) {
			streamed += pieces[Math.floor(next() * pieces.length)]!;
			const want = referenceEnds(streamed);
			expect(counter.count(0, streamed)).toBe(want.length);
			revealed = Math.min(want.length, revealed + 1 + Math.floor(next() * 4));
			expect(counter.slice(0, streamed, revealed).length).toBe(want[revealed - 1]!);
		}
	});
});
