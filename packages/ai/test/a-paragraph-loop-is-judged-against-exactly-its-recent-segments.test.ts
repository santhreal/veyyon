/**
 * The paragraph checks of the streamed loop guard judge a segment against exactly the segments their
 * definition names, and against nothing kept from earlier.
 *
 * WHY THIS SUITE EXISTS. `ThinkingLoopDetector` judges every completed segment twice: a word-trigram
 * Jaccard against the last 16 segments, and a novelty score against the vocabulary of the last 8,
 * where a run of low-novelty segments that name no new reference trips. Neither is recomputed from
 * scratch per segment. The pooled vocabulary is a count per word, raised as a segment enters the
 * window and lowered as it leaves; the Jaccard walk stops as soon as the unchecked shingles could no
 * longer lift it to 0.8; a segment's references are matched only once a low-novelty segment needs
 * them, so most window entries hold text rather than an anchor set; and the length floor is read off
 * the token list. Each of those can drift from the definition without any healthy stream noticing:
 *
 *   - a count that is lowered but not removed, or a window one segment too wide, keeps a word
 *     "seen" after its segment left, and turns ordinary returning vocabulary into a stall;
 *   - an early exit one shingle too eager, or a threshold read as `>`, drops a cluster sitting
 *     exactly at 0.8;
 *   - a window entry still holding text that is skipped instead of matched makes a reference named
 *     in an earlier, fresh paragraph count as new, which resets a stall the definition counts;
 *   - a length floor read without the spaces between tokens ignores a segment the floor admits.
 *
 * THE CLASS. Every reuse distance from 1 to 11 segments, every shared-trigram count from 0 to the
 * segment size for sizes 9 through 40 in three placements, every distance from 1 to 12 between a
 * fresh paragraph naming a reference and the stall that repeats it, and every normalized length from
 * 50 to 70, each pinned to the exact segment that trips and the exact reason, or to no trip at all.
 *
 * WHAT THIS SUITE DOES NOT CATCH. What `CONCRETE_ANCHOR` counts as a reference, and how a raw
 * paragraph is tokenized beyond case, punctuation and bare numbers, are pinned in
 * `thinking-loop.test.ts`. The verbatim tail check is pinned in
 * `a-verbatim-repeat-trips-on-the-character-that-completes-it.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { ThinkingLoopDetector } from "@veyyon/ai/utils/thinking-loop";

/** `SEGMENT_WINDOW`: segments a new one is compared with for near-duplicates. */
const SEGMENT_WINDOW = 16;
/** `LEX_NOVELTY_WINDOW`: segments whose pooled vocabulary is the novelty baseline. */
const NOVELTY_WINDOW = 8;
/** `LEX_STALL_MIN_RUN`: consecutive low-information segments that trip a stall. */
const STALL_RUN = 8;
/** `SEGMENT_SIMILARITY`: word-trigram Jaccard at which two segments are near-duplicates. */
const SIMILARITY = 0.8;
/** `SEGMENT_MIN_NORM_CHARS`: normalized length below which a segment is ignored. */
const MIN_NORMALIZED = 60;

const STALL_REASON = `${STALL_RUN} low-information segments recycling recent wording`;

/** Distinct lowercase words: a two-letter tag and a three-letter index, so no two tags collide and no
 *  word reads as a code reference. */
function words(tag: string, count: number, from = 0): string[] {
	return Array.from({ length: count }, (_, i) => {
		const n = from + i;
		const letters = String.fromCharCode(
			97 + (Math.floor(n / 676) % 26),
			97 + (Math.floor(n / 26) % 26),
			97 + (n % 26),
		);
		return `${tag}${letters}`;
	});
}

/** A seeded shuffle, so each repeat of a vocabulary orders it differently and shares no run of
 *  three words with another repeat. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
	const out = items.slice();
	let state = (seed * 2654435761) >>> 0 || 1;
	for (let i = out.length - 1; i > 0; i--) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		const j = (state >>> 0) % (i + 1);
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}

/** Push each segment as one delta ending in a paragraph break, then flush; the index of the segment
 *  whose push tripped (`segments.length` for the flush), with its reason. */
function tripPoint(segments: readonly string[]): { at: number; reason: string } | null {
	const detector = new ThinkingLoopDetector();
	for (let at = 0; at < segments.length; at++) {
		const reason = detector.push(`${segments[at]}\n\n`);
		if (reason !== null) return { at, reason };
	}
	const reason = detector.flush();
	return reason === null ? null : { at: segments.length, reason };
}

describe("novelty is measured against the vocabulary of exactly the last eight segments", () => {
	// Segment `i` reuses, reshuffled, the words of segment `i - distance` and no others; every
	// segment before `distance` is fresh. A reused vocabulary is recycled wording while its segment is
	// in the window and fresh again once it has left.
	const SEGMENTS = 40;
	for (let distance = 1; distance <= NOVELTY_WINDOW + 3; distance++) {
		test(`a vocabulary reused ${distance} segment(s) later`, () => {
			const vocabularies = Array.from({ length: distance }, (_, r) => words(`v${String.fromCharCode(97 + r)}`, 12));
			const segments = Array.from({ length: SEGMENTS }, (_, i) =>
				shuffled(vocabularies[i % distance] as string[], i + 1).join(" "),
			);
			const trip = tripPoint(segments);
			if (distance <= NOVELTY_WINDOW) {
				// The run opens at the first reuse and reaches its length seven segments later.
				expect(trip).toEqual({ at: distance + STALL_RUN - 1, reason: STALL_REASON });
			} else {
				expect(trip).toBeNull();
			}
		});
	}
});

describe("a near-duplicate cluster trips exactly when the trigram Jaccard reaches 0.8", () => {
	// Five fresh segments, then four that share `shared` trigrams with each other and nothing else.
	// The fourth of them is the ninth segment counted, so it trips when its three predecessors are all
	// near-duplicates of it. Each ends in a bare number, which normalization drops, so four segments
	// sharing every trigram are still not one verbatim repeat.
	const placements = ["shared words first", "shared words last", "segments that grow"] as const;
	const fresh = Array.from({ length: 5 }, (_, i) => words(`f${String.fromCharCode(97 + i)}`, 14).join(" "));
	for (const placement of placements) {
		test(placement, () => {
			for (let trigrams = 9; trigrams <= 40; trigrams++) {
				for (let shared = 0; shared <= trigrams; shared++) {
					// `shared` trigrams need `shared + 2` common words; fewer than three common words share none.
					const common = words("cm", shared === 0 ? 0 : shared + 2);
					const sizes = [0, 1, 2, 3].map(k => trigrams + (placement === "segments that grow" ? k : 0));
					const dups = sizes.map((size, k) => {
						const own = words(`d${String.fromCharCode(97 + k)}`, size + 2 - common.length);
						const ordered = placement === "shared words last" ? [...own, ...common] : [...common, ...own];
						return `${ordered.join(" ")} ${k + 1}`;
					});
					const jaccard = (a: number, b: number): number => shared / (a + b - shared);
					const last = sizes[3] as number;
					const cluster = 1 + sizes.slice(0, 3).filter(size => jaccard(last, size) >= SIMILARITY).length;
					const trip = tripPoint([...fresh, ...dups]);
					const expected =
						cluster >= 4
							? { at: 8, reason: `4 near-identical segments within the last ${SEGMENT_WINDOW}` }
							: null;
					expect({ trigrams, shared, trip }).toEqual({ trigrams, shared, trip: expected });
				}
			}
		});
	}
});

describe("a reference named in an earlier fresh paragraph is not new to a stall that repeats it", () => {
	// Twelve fresh paragraphs carry the filler vocabulary plus words of their own, so none of them is
	// low-novelty and none has its references matched while it streams. One of them names `parse_header`.
	// Then filler paragraphs reshuffle the filler vocabulary and name `parse_header` every time. The
	// first filler continues a stall only if that reference is still in the window.
	const FRESH = 12;
	const filler = words("fw", 12);
	const fresh = (named: number | undefined) =>
		Array.from({ length: FRESH }, (_, j) => {
			const own = words(`r${String.fromCharCode(97 + j)}`, 12);
			return `${[...filler, ...own].join(" ")}${j === named ? " parse_header" : ""}`;
		});
	const fillers = Array.from({ length: 12 }, (_, k) => `${shuffled(filler, k + 7).join(" ")} parse_header`);

	for (let distance = 1; distance <= FRESH; distance++) {
		test(`named ${distance} paragraph(s) before the first filler`, () => {
			const trip = tripPoint([...fresh(FRESH - distance), ...fillers]);
			// In the window, the first filler opens the run; out of it, the first filler resets the run
			// and the second opens it.
			const opens = distance <= NOVELTY_WINDOW ? FRESH : FRESH + 1;
			expect(trip).toEqual({ at: opens + STALL_RUN - 1, reason: STALL_REASON });
		});
	}

	test("never named before the fillers", () => {
		expect(tripPoint([...fresh(undefined), ...fillers])).toEqual({ at: FRESH + STALL_RUN, reason: STALL_REASON });
	});
});

describe("a segment counts exactly when its normalized text reaches 60 characters", () => {
	// Eight segments that normalize to the same tokens and differ in case, separators and a bare
	// number, so the raw text never repeats verbatim. They trip as an eight-segment cluster when they
	// count, and never when the floor drops them.
	const separators = [" ", ", ", " - ", "  ", "; ", " / ", ": ", " + "];
	for (let length = 50; length <= 70; length++) {
		test(`normalized length ${length}`, () => {
			const letters = length - 7;
			const tokens = Array.from({ length: 8 }, (_, i) => {
				const size = Math.floor(letters / 8) + (i < letters % 8 ? 1 : 0);
				return `${words("nl", 1, i)[0]}${"q".repeat(size - 5)}`;
			});
			expect(tokens.join(" ").length).toBe(length);
			const segments = separators.map(
				(separator, k) =>
					`${tokens.map((token, i) => ((i + k) % 2 === 0 ? token : token.toUpperCase())).join(separator)} ${100 + k}`,
			);
			const trip = tripPoint(segments);
			if (length >= MIN_NORMALIZED) {
				expect(trip).toEqual({ at: 7, reason: `8 near-identical segments within the last ${SEGMENT_WINDOW}` });
			} else {
				expect(trip).toBeNull();
			}
		});
	}
});
