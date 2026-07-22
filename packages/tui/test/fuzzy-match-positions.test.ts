/**
 * matchPositions — the DISPLAY side of fuzzy matching: which characters of a
 * candidate a highlight should mark for the typed query. Deliberately separate
 * from the scoring path (ranking can evolve without moving highlights) and the
 * ONE owner of hit-position logic so every list paints hits identically.
 *
 * Contracts locked here:
 *  1. Substring hits mark the contiguous occurrence, preferring a word
 *     boundary over an earlier mid-word occurrence (highlighting the start of
 *     "settings" for "set", not the "set" inside "asset" listed earlier).
 *  2. When no substring exists, the in-order subsequence positions are marked
 *     — the same characters the eye needs to verify a scattered match.
 *  3. Case-insensitive, original-index-preserving, sorted, de-duplicated.
 *  4. Blank queries mark nothing (no stray gold on an unfiltered list).
 */
import { describe, expect, it } from "bun:test";
import { matchPositions } from "../src/fuzzy";

describe("matchPositions — substring hits", () => {
	it("marks the contiguous occurrence of a plain substring", () => {
		expect(matchPositions("the", "/theme")).toEqual([1, 2, 3]);
	});

	it("prefers a word-boundary occurrence over an earlier mid-word one", () => {
		// "set" occurs mid-word in "asset" (index 2) but word-aligned in
		// "settings" (index 6) — the boundary occurrence wins.
		expect(matchPositions("set", "asset settings")).toEqual([6, 7, 8]);
	});

	it("is case-insensitive while returning original indices", () => {
		expect(matchPositions("PLAN", "/Plan")).toEqual([1, 2, 3, 4]);
	});
});

describe("matchPositions — subsequence fallback", () => {
	it("marks the in-order characters when no substring exists", () => {
		// "cmp" in "compact": c(0) m(2) p(3).
		expect(matchPositions("cmp", "compact")).toEqual([0, 2, 3]);
	});

	it("returns empty when the token is not even a subsequence", () => {
		expect(matchPositions("xyz", "compact")).toEqual([]);
	});
});

describe("matchPositions — query hygiene", () => {
	it("marks nothing for a blank query", () => {
		expect(matchPositions("", "/theme")).toEqual([]);
		expect(matchPositions("   ", "/theme")).toEqual([]);
	});

	it("merges multi-token hits sorted and de-duplicated", () => {
		const hits = matchPositions("se li", "session list");
		expect(hits).toEqual([...new Set(hits)].sort((a, b) => a - b));
		expect(hits).toContain(0); // "se" at word start
		expect(hits).toContain(8); // "li" at word start of "list"
	});
});
