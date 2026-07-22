/**
 * Bodyless SWAP each line of 5-line file equals DEL that line.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits bodyless SWAP equals DEL each line", () => {
	const base = ["a", "b", "c", "d", "e"];
	const text = base.join("\n");
	for (let i = 1; i <= 5; i++) {
		it(`line ${i}`, () => {
			const viaSwap = applyEdits(text, parsePatch(`SWAP ${i}.=${i}:`).edits).text;
			const viaDel = applyEdits(text, parsePatch(`DEL ${i}`).edits).text;
			expect(viaSwap).toBe(viaDel);
			const want = base.filter((_, j) => j + 1 !== i).join("\n");
			expect(viaSwap).toBe(want);
		});
	}
});
