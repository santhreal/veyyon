// WHY: a file's snapshot tag is a 16-bit xxHash32 of its text with every run of
// spaces, tabs and CRs at the end of a line removed, so a CRLF checkout or an
// editor that trims line ends keeps the tag a read minted. `computeFileHash` used
// to express that normalization as one lookahead regex; it is now a fast path that
// returns text with no line-end whitespace untouched, and a scan over line ends
// for everything else. The defect class is a normalization that disagrees with
// the definition: it trims too little (a whitespace-only line, a run before EOF,
// a CR before LF, a mixed run), trims too much (interior or leading whitespace, a
// CR inside a line, a character outside the set), or takes the fast path on text
// that needs trimming. Either way a tag stops matching the file, and an edit
// anchored on a fresh read is rejected as stale, or a stale anchor validates.
//
// The suite derives the expected tag from the definition, line by line, for every
// string up to six characters over an alphabet holding each member of the set,
// the newline, a letter and one whitespace character outside the set (U+00A0),
// so every ordering of runs, line ends and interior characters appears. A seeded
// 10,000-line document exercises the scan across many copied segments.
//
// It pins the tag formula (xxHash32, seed 0, low 16 bits, four uppercase hex
// digits): a change to the formula invalidates every tag a session recorded, and
// this suite fails until that change is made on purpose. It does not catch a
// defect confined to strings longer than six characters whose shape no shorter
// string or the seeded document reproduces.

import { describe, expect, it } from "bun:test";
import { computeFileHash, HL_FILE_HASH_LENGTH } from "@veyyon/hashline";

const ALPHABET = ["a", " ", "\t", "\r", "\n", "\u00a0"] as const;
const MAX_LENGTH = 6;

/** The normalization as documented: each line with its trailing `[ \t\r]` run removed. */
function trimLineEnds(text: string): string {
	return text
		.split("\n")
		.map(line => line.replace(/[ \t\r]+$/, ""))
		.join("\n");
}

/**
 * The tag of text that is already normalized. `Bun.hash.xxHash32` is the hash the
 * tag is defined over; `node:crypto` has no xxHash32.
 */
function tagOf(normalized: string): string {
	return (Bun.hash.xxHash32(normalized, 0) & 0xffff).toString(16).padStart(HL_FILE_HASH_LENGTH, "0").toUpperCase();
}

function* everyString(maxLength: number): Generator<string> {
	let layer = [""];
	yield "";
	for (let length = 1; length <= maxLength; length++) {
		const next: string[] = [];
		for (const prefix of layer) {
			for (const char of ALPHABET) {
				const text = prefix + char;
				next.push(text);
				yield text;
			}
		}
		layer = next;
	}
}

/** Deterministic line soup: code-like lines, some ending in runs drawn from the set. */
function seededDocument(lines: number): string {
	let state = 0x9e3779b9;
	const next = (): number => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x1_0000_0000;
	};
	const tails = ["", "", "", " ", "  ", "\t", " \t ", "\r", " \r", "\t\r"];
	const out: string[] = [];
	for (let i = 0; i < lines; i++) {
		const indent = "\t".repeat(Math.floor(next() * 4));
		const body = next() < 0.1 ? "" : `const value_${i} = compute(${i}, "a b\tc");`;
		out.push(indent + body + tails[Math.floor(next() * tails.length)]);
	}
	return out.join("\n");
}

describe("a file tag ignores only whitespace at line ends", () => {
	it("matches the per-line definition for every short string over the boundary alphabet", () => {
		const mismatches: string[] = [];
		let checked = 0;
		for (const text of everyString(MAX_LENGTH)) {
			checked++;
			if (computeFileHash(text) !== tagOf(trimLineEnds(text))) mismatches.push(JSON.stringify(text));
		}
		// Every string of length 0..MAX_LENGTH over the alphabet was compared.
		expect(checked).toBe((ALPHABET.length ** (MAX_LENGTH + 1) - 1) / (ALPHABET.length - 1));
		expect(mismatches).toEqual([]);
	});

	it("matches the per-line definition on a long document with mixed line endings", () => {
		const document = seededDocument(10_000);
		expect(computeFileHash(document)).toBe(tagOf(trimLineEnds(document)));
		const crlf = document.split("\n").join("\r\n");
		expect(computeFileHash(crlf)).toBe(tagOf(trimLineEnds(crlf)));
		expect(computeFileHash(crlf)).toBe(computeFileHash(trimLineEnds(document)));
	});
});
