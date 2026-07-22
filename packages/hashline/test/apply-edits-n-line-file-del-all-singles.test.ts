/**
 * On an N-line file, DEL each line individually (separate apply) leaves n-1 lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL each single line of N-line files", () => {
	for (const n of [1, 3, 5, 7]) {
		const text = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
		for (let i = 1; i <= n; i++) {
			it(`n=${n} DEL ${i}`, () => {
				const { text: out } = applyEdits(text, parsePatch(`DEL ${i}`).edits);
				const want = Array.from({ length: n }, (_, j) => `L${j + 1}`).filter(
					(_, j) => j + 1 !== i,
				);
				expect(out).toBe(want.join("\n"));
			});
		}
	}
});
