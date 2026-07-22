/**
 * Bodyless SWAP equals DEL for every line of an N-line file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatDeleteHeader, formatReplaceHeader, parsePatch } from "@veyyon/hashline";

describe("bodyless SWAP equals DEL", () => {
	const n = 6;
	const text = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");

	for (let i = 1; i <= n; i++) {
		it(`line ${i}`, () => {
			const viaSwap = applyEdits(text, parsePatch(formatReplaceHeader(i, i)).edits).text;
			const viaDel = applyEdits(text, parsePatch(formatDeleteHeader(i)).edits).text;
			expect(viaSwap).toBe(viaDel);
		});
	}

	for (let start = 1; start <= n; start++) {
		for (let end = start; end <= Math.min(start + 2, n); end++) {
			it(`range ${start}.=${end}`, () => {
				const viaSwap = applyEdits(text, parsePatch(formatReplaceHeader(start, end)).edits).text;
				const viaDel = applyEdits(text, parsePatch(formatDeleteHeader(start, end)).edits).text;
				expect(viaSwap).toBe(viaDel);
			});
		}
	}
});
