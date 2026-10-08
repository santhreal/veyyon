/**
 * The streamed loop guard reaches the verdict its definition gives, on the delta that completes it,
 * however a provider cuts the stream into deltas.
 *
 * WHY THIS SUITE EXISTS. `ThinkingLoopDetector.push` keeps two pieces of state between deltas so that
 * a delta costs about its own length. The verbatim tail is a code-unit buffer that each delta is
 * appended to and that moves its last 900 units to the front when it fills. The paragraph splitter
 * resumes its blank-line search where the pending text's trailing whitespace begins rather than at the
 * start of the paragraph. Each is a cut away from a defect the one-char and one-segment-per-delta
 * suites cannot see:
 *
 *   - a buffer move that keeps the wrong 900 units, or a delta longer than the window copied from the
 *     wrong offset, judges a tail the stream never ended with;
 *   - a resumed search that starts after the first line break of a blank line split across deltas,
 *     or that keeps its position after a segment is cut from the front or after a flush, merges two
 *     paragraphs into one;
 *   - a whitespace test narrower than `\s` stops the resume point inside a blank line that holds a
 *     no-break, ideographic or em space.
 *
 * THE CLASS. Verbatim: streams of a lead-in at every length around one and two buffer fills, followed
 * by a unit of 2 to 200 chars repeated past the window's length or by no loop, cut at fixed sizes from
 * 1 to 1,100 chars and at seeded random sizes, are judged at every delta against a reference that
 * reads the last 900 chars of the stream as one string. Paragraphs: identical paragraphs separated by
 * every blank-line shape (ASCII spaces and tabs, CRLF, vertical tab and form feed, no-break,
 * ideographic and em space, line separator, byte-order mark, a 40-space run), each shape in turn
 * completing the eighth paragraph, cut at every size from 1 to 64 and at seeded random sizes, trip on
 * the delta holding the line break that completes the eighth blank line. The same holds when every
 * paragraph overruns the 700-char segment cap, and after a flushed thinking block that ended in
 * whitespace when the first delta after it ends at each char inside the first blank line.
 *
 * WHAT THIS SUITE DOES NOT CATCH. What the verbatim and paragraph checks count as a loop is pinned in
 * `a-verbatim-repeat-trips-on-the-character-that-completes-it.test.ts` and
 * `a-paragraph-loop-is-judged-against-exactly-its-recent-segments.test.ts`; this suite pins only that
 * cutting the stream leaves the verdict where the definition puts it. A blank line of three or more
 * line breaks ends where the delta holding them ends, so its leftover breaks open the next segment
 * under one cut and not another; no paragraph sweep here uses one.
 */
import { describe, expect, test } from "bun:test";
import { ThinkingLoopDetector } from "@veyyon/ai/utils/thinking-loop";

/** `VERBATIM_TAIL_WINDOW`: chars of the stream's end the verbatim check reads. */
const WINDOW = 900;
/** `VERBATIM_MAX_UNIT`: the longest unit length the verbatim check probes. */
const MAX_UNIT = 200;
/** `VERBATIM_MIN_REPEATED_CHARS`: the repeated-char floor a verbatim run has to clear. */
const MIN_REPEATED_CHARS = 180;
/** `SEGMENT_CHAR_CAP`: chars after which a paragraph with no blank line is cut. */
const SEGMENT_CAP = 700;
/** `SEGMENT_MIN_COUNT`: substantial segments before the paragraph checks may trip. */
const MIN_SEGMENTS = 8;
/** `SEGMENT_WINDOW`: segments a new one is compared with for near-duplicates. */
const SEGMENT_WINDOW = 16;

const UNIT_CONTENT = /[\p{L}\p{Extended_Pictographic}]/u;

/** The verbatim verdict for a stream that has delivered `text` up to `end`: the shortest unit at the
 *  end of its last {@link WINDOW} chars that carries a letter or emoji and repeats back-to-back four
 *  times over at least {@link MIN_REPEATED_CHARS} chars, unless it is a whitespace-free run inside a
 *  longer token. */
function verbatimVerdict(text: string, end: number): string | null {
	const tail = text.slice(Math.max(0, end - WINDOW), end);
	const length = tail.length;
	for (let len = 2; len <= Math.min(MAX_UNIT, Math.floor(length / 4)); len++) {
		const unit = tail.slice(length - len);
		if (!UNIT_CONTENT.test(unit)) continue;
		let pos = length - len;
		let count = 1;
		while (pos - len >= 0 && tail.slice(pos - len, pos) === unit) {
			count++;
			pos -= len;
		}
		if (count < 4 || count * len < MIN_REPEATED_CHARS) continue;
		if (!/\s/.test(unit) && pos > 0 && !/\s/.test(tail[pos - 1] as string)) continue;
		return `repeated "${unit.trim()}" ${count}× back-to-back`;
	}
	return null;
}

/** A seeded generator of floats in [0, 1). */
function seeded(seed: number): () => number {
	let state = (seed * 2654435761) >>> 0 || 1;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 4294967296;
	};
}

const WORDS = (
	"cache index entry shard table manifest checksum ledger upload staging bucket review build owner " +
	"release step order block retry verify report trace query result field value window buffer stream " +
	"delta token parser schema record header footer column marker offset length cursor anchor branch"
).split(" ");

/** Text of `length` chars mixing words, digits, punctuation, CJK and emoji, with single line breaks
 *  and never a blank line; it starts with a letter. */
function mixedText(random: () => number, length: number): string {
	let text = "";
	while (text.length < length) {
		const roll = random();
		if (roll < 0.6) text += WORDS[Math.floor(random() * WORDS.length)];
		else if (roll < 0.7) text += String(Math.floor(random() * 10_000));
		else if (roll < 0.8) text += String.fromCharCode(0x4e00 + Math.floor(random() * 2000));
		else if (roll < 0.85) text += String.fromCodePoint(0x1f300 + Math.floor(random() * 200));
		else text += ",.;:-()"[Math.floor(random() * 7)];
		text += random() < 0.08 ? "\n" : " ";
	}
	return `x${text}`.slice(0, length);
}

/** Feeds `text` to `detector` in deltas sized by `cut`; the stream offset where the delta that
 *  tripped ends, with its reason, or null. */
function feed(
	detector: ThinkingLoopDetector,
	text: string,
	cut: (at: number) => number,
): { end: number; reason: string } | null {
	for (let at = 0; at < text.length; ) {
		const end = Math.min(text.length, at + cut(at));
		const reason = detector.push(text.slice(at, end));
		if (reason !== null) return { end, reason };
		at = end;
	}
	return null;
}

/** The end of the delta, under `cut`, that holds the char at `index`. */
function deltaEnd(index: number, length: number, cut: (at: number) => number): number {
	let at = 0;
	while (true) {
		const end = Math.min(length, at + cut(at));
		if (index < end) return end;
		at = end;
	}
}

describe("the verbatim check judges every delta on the last 900 chars the stream delivered", () => {
	// Lead-ins put each buffer move, and the first delta longer than the window, at every alignment
	// that matters: short of one fill, at it, past it, and around two fills.
	const LEADS = [0, 7, 180, 899, 900, 901, 1250, 1799, 1800, 1801, 2400];
	const UNITS = [0, 2, 3, 45, 60, 89, 113, 199, 200];
	const CUTS: [name: string, cut: (random: () => number) => number][] = [
		...[1, 5, 37, 211, 899, 900, 901, 1100].map(
			size => [`${size}-char deltas`, () => size] as [string, () => number],
		),
		[
			"seeded deltas of 1 to 1,100 chars",
			random => {
				const roll = random();
				return roll < 0.7
					? 1 + Math.floor(random() * 12)
					: roll < 0.95
						? 13 + Math.floor(random() * 300)
						: 300 + Math.floor(random() * 800);
			},
		],
	];

	for (const [name, cutOf] of CUTS) {
		test(`cut into ${name}`, () => {
			const mismatches: unknown[] = [];
			let trips = 0;
			for (const lead of LEADS) {
				for (const len of UNITS) {
					const random = seeded(lead * 1000 + len + 1);
					// A unit opens on a letter and ends on a space, so every looping stream is a loop.
					const unit = len === 0 ? "" : `${mixedText(random, len - 1)} `;
					// More copies than the window holds, so a delta that ends deep in the loop is judged on a
					// count that reads the window's first char.
					const copies = len === 0 ? 0 : Math.ceil(WINDOW / len) + 3;
					// The stream ends on the loop: a delta that carried it and text past it would end on a tail
					// that is no loop, and the check judges where a delta ends.
					const text = mixedText(random, lead) + unit.repeat(copies);
					const detector = new ThinkingLoopDetector();
					let expected: { end: number; reason: string } | null = null;
					let actual: { end: number; reason: string } | null = null;
					for (let at = 0; at < text.length && expected === null && actual === null; ) {
						const end = Math.min(text.length, at + cutOf(random));
						const reason = detector.push(text.slice(at, end));
						if (reason !== null) actual = { end, reason };
						const want = verbatimVerdict(text, end);
						if (want !== null) expected = { end, reason: want };
						at = end;
					}
					if (expected !== null) trips++;
					if (!Bun.deepEquals(actual, expected)) mismatches.push({ lead, len, expected, actual });
				}
			}
			expect(mismatches).toEqual([]);
			// Every looping stream trips under every cut; a sweep whose loops stopped tripping would agree
			// with the reference while judging nothing.
			expect(trips).toBe(LEADS.length * (UNITS.length - 1));
		});
	}
});

/** A paragraph of `length` chars: distinct words with single line breaks, no blank line, no code
 *  reference, and no back-to-back repeat. */
function paragraph(length: number): string {
	const random = seeded(length);
	let text = "";
	while (text.length < length) {
		text += WORDS[Math.floor(random() * WORDS.length)];
		text += random() < 0.1 ? "\n" : " ";
	}
	return `${text.slice(0, length - 1)}.`;
}

/** Blank lines of exactly two line breaks with nothing after the second, so each ends where the same
 *  char completes it under every cut. */
const SEPARATORS = [
	"\n\n",
	"\n \n",
	"  \n\t\n",
	"\r\n\r\n",
	"\n\v\f\n",
	"\n\u00a0\n",
	"\n\u3000\n",
	"\n\u2003\u2028\n",
	"\n\ufeff\n",
	`\n${" ".repeat(40)}\n`,
];

const CLUSTER_REASON = `${MIN_SEGMENTS} near-identical segments within the last ${SEGMENT_WINDOW}`;

/** Every cut the paragraph sweeps apply: each fixed size from 1 to 64, then seeded sizes of 1 to 300. */
const PARAGRAPH_CUTS: [name: string, cut: () => (at: number) => number][] = [
	...Array.from(
		{ length: 64 },
		(_, i) => [`${i + 1}-char`, () => () => i + 1] as [string, () => (at: number) => number],
	),
	...Array.from(
		{ length: 16 },
		(_, i) =>
			[
				`seeded ${i + 1}`,
				() => {
					const random = seeded(7919 * (i + 1));
					const sizes = new Map<number, number>();
					return (at: number) => {
						let size = sizes.get(at);
						if (size === undefined) {
							size = 1 + Math.floor(random() * (random() < 0.8 ? 16 : 300));
							sizes.set(at, size);
						}
						return size;
					};
				},
			] as [string, () => (at: number) => number],
	),
];

/** Ten copies of `body`, the `i`th followed by separator `rotation + i`; the offset of the char that
 *  completes the eighth blank line, and where the eighth body starts. */
function paragraphStream(body: string, rotation: number): { text: string; eighthBlank: number; eighthBody: number } {
	let text = "";
	let eighthBlank = -1;
	let eighthBody = -1;
	for (let i = 0; i < 10; i++) {
		if (i === MIN_SEGMENTS - 1) eighthBody = text.length;
		text += body;
		const separator = SEPARATORS[(rotation + i) % SEPARATORS.length] as string;
		if (i === MIN_SEGMENTS - 1) eighthBlank = text.length + separator.lastIndexOf("\n");
		text += separator;
	}
	return { text, eighthBlank, eighthBody };
}

describe("a paragraph loop trips on the delta that completes its eighth blank line", () => {
	const BODY = paragraph(300);

	for (let rotation = 0; rotation < SEPARATORS.length; rotation++) {
		test(`with ${JSON.stringify(SEPARATORS[(rotation + MIN_SEGMENTS - 1) % SEPARATORS.length])} completing it`, () => {
			const { text, eighthBlank } = paragraphStream(BODY, rotation);
			const expected: unknown[] = [];
			const actual: unknown[] = [];
			for (const [name, cutOf] of PARAGRAPH_CUTS) {
				expected.push({ name, trip: { end: deltaEnd(eighthBlank, text.length, cutOf()), reason: CLUSTER_REASON } });
				actual.push({ name, trip: feed(new ThinkingLoopDetector(), text, cutOf()) });
			}
			expect(actual).toEqual(expected);
		});
	}

	test("when every paragraph overruns the segment cap, on the delta holding the eighth body's cap", () => {
		// Each body is cut at the cap and its last 50 chars are too short to count, so the eighth
		// capped chunk is the eighth substantial segment and the blank line after each body has to be
		// found in what the cut left.
		const body = paragraph(SEGMENT_CAP + 50);
		const expected: unknown[] = [];
		const actual: unknown[] = [];
		for (let rotation = 0; rotation < SEPARATORS.length; rotation++) {
			const { text, eighthBody } = paragraphStream(body, rotation);
			for (const [name, cutOf] of PARAGRAPH_CUTS) {
				expected.push({
					rotation,
					name,
					trip: { end: deltaEnd(eighthBody + SEGMENT_CAP, text.length, cutOf()), reason: CLUSTER_REASON },
				});
				actual.push({ rotation, name, trip: feed(new ThinkingLoopDetector(), text, cutOf()) });
			}
		}
		expect(actual).toEqual(expected);
	});

	test("after a flushed thinking block that ended in whitespace, wherever the first delta ends in the first blank line", () => {
		// The flushed block holds no letters, so it counts as no segment. Its trailing whitespace begins
		// past the first blank line of what follows, so a resume point kept from it would pass over a
		// line break the first delta ends on and merge the first two paragraphs.
		const block = `${Array.from({ length: 90 }, (_, i) => String((i * 7919) % 10_000)).join(" ")}\n${" ".repeat(30)}`;
		const expected: unknown[] = [];
		const actual: unknown[] = [];
		for (let rotation = 0; rotation < SEPARATORS.length; rotation++) {
			const { text, eighthBlank } = paragraphStream(BODY, rotation);
			const first = SEPARATORS[rotation] as string;
			// The first delta ends after the blank line's first line break and before the one completing it.
			for (let into = first.indexOf("\n") + 1; into <= first.lastIndexOf("\n"); into++) {
				for (const [name, cutOf] of PARAGRAPH_CUTS.filter((_, i) => i % 16 === 0)) {
					const cut = () => {
						const rest = cutOf();
						return (at: number) => (at === 0 ? BODY.length + into : rest(at));
					};
					const detector = new ThinkingLoopDetector();
					const flushed = { block: detector.push(block), flush: detector.flush() };
					expected.push({
						rotation,
						into,
						name,
						flushed: { block: null, flush: null },
						trip: { end: deltaEnd(eighthBlank, text.length, cut()), reason: CLUSTER_REASON },
					});
					actual.push({ rotation, into, name, flushed, trip: feed(detector, text, cut()) });
				}
			}
		}
		expect(block.lastIndexOf("\n")).toBeGreaterThan(BODY.length + 1);
		expect(actual).toEqual(expected);
	});
});
