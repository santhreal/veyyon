/**
 * A bodyless `SWAP i.=i:` on each line of a 5-line file is rejected; `DEL i`
 * removes that line. Locks the strict contract at single-line granularity: the
 * parser throws EMPTY_REPLACE rather than silently deleting (silent data loss),
 * and the explicit DEL yields the file with exactly that line gone.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, EMPTY_REPLACE, parsePatch } from "@veyyon/hashline";

describe("bodyless SWAP each line is rejected; DEL removes it (n=5)", () => {
	const base = ["a", "b", "c", "d", "e"];
	const text = base.join("\n");
	for (let i = 1; i <= 5; i++) {
		it(`line ${i}`, () => {
			expect(() => parsePatch(`SWAP ${i}.=${i}:`)).toThrow(EMPTY_REPLACE);
			const viaDel = applyEdits(text, parsePatch(`DEL ${i}`).edits).text;
			const want = base.filter((_, j) => j + 1 !== i).join("\n");
			expect(viaDel).toBe(want);
		});
	}
});
