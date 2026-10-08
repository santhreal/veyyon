/**
 * WHY. `dropFrontBytes` keeps the tail of a string under a byte budget by walking characters off its
 * front, where `truncateTailBytes` encodes the window and decodes the cut. The class this closes: a
 * walk that counts a character at the wrong width, splits a surrogate pair, stops one character early
 * or late, or drops a character at or past the end it was given, so the kept tail or its byte count
 * differs from the encoder's cut. The first and last code point of every UTF-8 width is swept, against
 * the encoder as the oracle, under every budget from below zero to past the text, walked whole and
 * walked in two legs split at every index.
 *
 * Not caught: a caller that passes a `bytes` which is not the length of what it keeps.
 */
import { describe, expect, it } from "bun:test";
import { dropFrontBytes, truncateTailBytes } from "../src/byte-truncate";

/**
 * The first and last code point of each UTF-8 width, one to four bytes, with the two either side of
 * the surrogate range; a four-byte character is a surrogate pair.
 */
const BOUNDARIES = [
	"\u0000",
	"\u007F",
	"\u0080",
	"\u07FF",
	"\u0800",
	"\uD7FF",
	"\uE000",
	"\uFFFF",
	"\u{10000}",
	"\u{10FFFF}",
];

/** The tail of `text` a walk over all of it keeps, as `truncateTailBytes` states one. */
function walkWhole(text: string, max: number): { text: string; bytes: number } {
	const cut = dropFrontBytes(text, 0, text.length, Buffer.byteLength(text, "utf-8"), max);
	return { text: text.substring(cut.start), bytes: cut.bytes };
}

describe("dropFrontBytes", () => {
	// Every character follows every other, so each budget cuts at each boundary between two widths.
	const text = BOUNDARIES.flatMap(first => BOUNDARIES.map(second => first + second)).join("");
	const total = Buffer.byteLength(text, "utf-8");

	it("keeps the tail and the byte count the encoder keeps, for every character width and budget", () => {
		for (let max = -1; max <= total + 1; max++) {
			expect({ max, ...walkWhole(text, max) }).toEqual({ max, ...truncateTailBytes(text, max) });
		}
	});

	it("never drops a character that starts at the end it was given, and resumes where it stopped", () => {
		for (const max of [0, 7, Math.floor(total / 2), total - 1]) {
			for (let end = 0; end <= text.length; end++) {
				const first = dropFrontBytes(text, 0, end, total, max);
				// A pair whose first half sits before `end` is dropped whole, so the walk can stop one
				// unit past it, and never further.
				expect({ max, end, past: first.start > end + 1 }).toEqual({ max, end, past: false });
				const second = dropFrontBytes(text, first.start, text.length, first.bytes, max);
				expect({ max, end, ...second }).toEqual({
					max,
					end,
					...dropFrontBytes(text, 0, text.length, total, max),
				});
			}
		}
	});

	it("keeps a lone surrogate as it is, counting the three bytes of the U+FFFD it encodes to", () => {
		for (const lone of ["\uD800", "\uDC00"]) {
			expect({ lone, kept: walkWhole(`ab${lone}c`, 4) }).toEqual({ lone, kept: { text: `${lone}c`, bytes: 4 } });
			expect({ lone, kept: walkWhole(`ab${lone}c`, 3) }).toEqual({ lone, kept: { text: "c", bytes: 1 } });
		}
		// Two low surrogates are two characters, and so is the last character below the surrogates
		// followed by one.
		for (const first of ["\uDC00", "\uD7FF"]) {
			expect({ first, kept: walkWhole(`${first}\uDC00c`, 4) }).toEqual({
				first,
				kept: { text: "\uDC00c", bytes: 4 },
			});
		}
	});
});
