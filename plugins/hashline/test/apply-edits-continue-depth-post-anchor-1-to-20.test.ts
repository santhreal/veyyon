/**
 * INS.POST on each anchor 1..20 of a 20-line file: length becomes 21.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits continue depth POST anchor 1 to 20", () => {
	const n = 20;
	const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");

	for (let a = 1; a <= n; a++) {
		it(`POST ${a}`, () => {
			const { text } = applyEdits(base, parsePatch(`INS.POST ${a}:\n+X`).edits);
			expect(text.split("\n").length).toBe(n + 1);
			expect(text.split("\n")[a]).toBe("X");
		});
	}
});
