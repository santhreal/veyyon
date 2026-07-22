/**
 * INS.POST on each anchor 1..50 of a 50-line file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 5000 POST 1 to 50", () => {
	const n = 50;
	const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");

	for (let a = 1; a <= n; a++) {
		it(`POST ${a}`, () => {
			const { text } = applyEdits(base, parsePatch(`INS.POST ${a}:\n+X`).edits);
			expect(text.split("\n").length).toBe(n + 1);
			expect(text.split("\n")[a]).toBe("X");
		});
	}
});
