/**
 * The streamed verbatim guard trips on the character that completes a loop, and on no other.
 *
 * WHY THIS SUITE EXISTS. `ThinkingLoopDetector` runs its verbatim check on every streamed delta, so
 * the check reads the rolling tail in place: index arithmetic for the window start, a block walk
 * that compares char codes, and the distance from the end to the nearest letter standing in for a
 * per-unit regex. Each of those is an off-by-one away from a defect the earlier suites cannot see:
 *
 *   - a repeat counted one copy early or late, or a 180-char floor read as 135, trips on legitimate
 *     text or lets a runaway stream further than the guard promises;
 *   - a block comparison that skips its first or last char counts a numbered list as a loop;
 *   - a letter scan that stops short loses a long unit whose only letter sits far from its end;
 *   - a letter filter that is skipped turns a hexdump after a label into a loop;
 *   - a token-boundary rule that misreads the window start never trips on a space-free script.
 *
 * THE CLASS. Every unit length the detector probes, 2 through 200, is driven char by char, and the
 * trip is pinned to the exact character: not one earlier, with the exact unit and copy count in the
 * reason. The sweeps run over a spaced Latin unit, a space-free CJK unit, a unit whose only letter
 * is its first char, the same with an emoji, a letter-free unit behind a label, and lists whose
 * items differ in one char that every streamed offset rotates through each block position. Each
 * repeat sweep runs twice: opening the stream, where the window start is the run start, and behind
 * a lead-in line, where the window already holds four blocks when the run holds three, so a copy
 * count read one short has room to trip. Every ASCII char, and a sample beyond it, is swept as a
 * unit's lone leading char, so the char-code shortcut for ASCII agrees with the Unicode properties.
 *
 * WHAT THIS SUITE DOES NOT CATCH. A tail that ends between the two halves of a surrogate pair can
 * report a unit that starts mid-pair; no sweep here splits a pair. A unit longer than 200 chars is
 * pinned in `a-sentence-repeated-forever-is-a-loop.test.ts`, and a whitespace-free run inside a
 * longer token in `a-long-name-that-cycles-is-not-a-sampler-loop.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { ThinkingLoopDetector } from "@veyyon/ai/utils/thinking-loop";

/** `VERBATIM_MAX_UNIT`: the longest unit length the detector probes. */
const MAX_UNIT = 200;
/** `VERBATIM_MIN_REPEATED_CHARS`: the repeated-char floor a run has to clear. */
const MIN_REPEATED_CHARS = 180;
/** Back-to-back copies a run needs whatever its length. */
const MIN_COPIES = 4;

const UNIT_LENGTHS = Array.from({ length: MAX_UNIT - 1 }, (_, i) => i + 2);

/** Copies of a `len`-char unit the guard needs before the run is a loop. */
function copiesToTrip(len: number): number {
	return Math.max(MIN_COPIES, Math.ceil(MIN_REPEATED_CHARS / len));
}

/** Stream `text` one char per delta; the index of the char whose delta tripped, with its reason. */
function tripPoint(text: string): { at: number; reason: string } | null {
	const detector = new ThinkingLoopDetector();
	for (let at = 0; at < text.length; at++) {
		const reason = detector.push(text[at] as string);
		if (reason !== null) return { at, reason };
	}
	return null;
}

/** A 200+ char sentence with no internal back-to-back repeat; every prefix is a primitive unit. */
const LATIN =
	"Checked the cache index again and the entry is still missing from the shard table, so I will " +
	"rebuild the manifest, verify each checksum against the upstream ledger, and then retry the upload " +
	"to the staging bucket before reporting back.";

/** 200 distinct CJK ideographs: a space-free script with no internal repeat. 37 is coprime to 2000. */
const CJK = Array.from({ length: MAX_UNIT }, (_, i) => String.fromCharCode(0x4e00 + ((i * 37) % 2000))).join("");

/** A 200+ char line ending in a newline, which no unit ends with, so the run starts after it. */
const LEAD_IN =
	"Here is where the release checklist stands after this morning's review with the build owners, " +
	"listed in the order the remaining steps have to run so that nothing downstream is blocked on an " +
	"earlier one.\n";

describe("a verbatim repeat trips on the character that completes it", () => {
	const families: [name: string, unit: (len: number) => string][] = [
		["a spaced Latin sentence", len => LATIN.slice(0, len)],
		["a space-free CJK run", len => CJK.slice(0, len)],
		["a unit whose only letter is its first char", len => `a${".".repeat(len - 1)}`],
		["a unit whose only content is a leading emoji", len => `\u{1F525}${".".repeat(len - 2)}`],
	];

	const leads: [name: string, text: string][] = [
		["opening the stream", ""],
		["behind a lead-in line", LEAD_IN],
	];

	for (const [name, unitOf] of families) {
		for (const [where, lead] of leads) {
			test(`${name} ${where}, at every unit length the guard probes`, () => {
				if (lead) expect(lead.length).toBeGreaterThan(MAX_UNIT);
				const expected: { len: number; trip: { at: number; reason: string } | null }[] = [];
				const actual: typeof expected = [];
				for (const len of UNIT_LENGTHS) {
					const unit = unitOf(len);
					const copies = copiesToTrip(len);
					expected.push({
						len,
						trip: {
							at: lead.length + copies * len - 1,
							reason: `repeated "${unit.trim()}" ${copies}× back-to-back`,
						},
					});
					// A unit shorter than `len` is a fixture that stopped probing that length; report it as
					// a miss rather than skip it. Two copies past the trip: a late trip is seen late, not never.
					actual.push({
						len,
						trip: unit.length === len ? tripPoint(lead + unit.repeat(copies + 2)) : null,
					});
				}
				expect(actual).toEqual(expected);
			});
		}
	}

	test("a unit's lone leading char is content exactly when it is a letter or a pictograph, for every ASCII char", () => {
		// The letter scan answers ASCII from the char code and everything else from the Unicode
		// properties, so every ASCII char is swept and the definition is the expectation.
		const content = /[\p{L}\p{Extended_Pictographic}]/u;
		const len = 50;
		const copies = copiesToTrip(len);
		const chars = [
			...Array.from({ length: 0x80 }, (_, code) => String.fromCharCode(code)),
			"é",
			"ж",
			"中",
			"ª",
			"€",
			"·",
			"\u00a0",
		];
		const expected = chars.map(char => {
			const unit = `${char}${".".repeat(len - 1)}`;
			return {
				char,
				trip: content.test(char)
					? { at: copies * len - 1, reason: `repeated "${unit.trim()}" ${copies}× back-to-back` }
					: null,
			};
		});
		const actual = chars.map(char => ({ char, trip: tripPoint(`${char}${".".repeat(len - 1)}`.repeat(copies + 2)) }));
		expect(actual).toEqual(expected);
	});
});

describe("text that is not a verbatim loop streams through untouched", () => {
	test("a letter-free unit right after a label, at every unit length", () => {
		// A hexdump or a numeric table repeats legitimately. Right after its label the label's letters
		// are still inside the probed span, so the letter test alone keeps a short numeric unit from
		// tripping.
		const digits = Array.from({ length: 60 }, (_, i) => String((i * 7919) % 10007)).join(" | ");
		const tripped: number[] = [];
		for (const len of UNIT_LENGTHS) {
			const unit = digits.slice(0, len);
			if (tripPoint(`Row dump:\n${unit.repeat(copiesToTrip(len) + 4)}`) !== null) tripped.push(len);
		}
		expect(tripped).toEqual([]);
	});

	test("a list whose items differ in one char, wherever the stream cuts the block", () => {
		// Each item is the same sentence with one changed letter. Streamed one char at a time, the
		// changed letter passes through every position of the tail block, including its first and
		// last, so a comparison that skips either end sees identical copies.
		const shards = Array.from({ length: 26 }, (_, i) => String.fromCharCode(0x41 + i));
		for (const template of [
			(shard: string) => `Checked shard ${shard} and found nothing new. `,
			(shard: string) => `${shard}: checked and found nothing new; `,
			(shard: string) => `Checked and found nothing new in ${shard}`,
		]) {
			expect({ list: template("X"), trip: tripPoint(shards.map(template).join("")) }).toEqual({
				list: template("X"),
				trip: null,
			});
		}
	});
});
