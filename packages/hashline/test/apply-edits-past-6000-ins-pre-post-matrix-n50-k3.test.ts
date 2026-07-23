/**
 * INS.PRE and INS.POST single-line matrix on n=50 with k=3 body rows.
 * Why: insert position and multi-row body must keep neighbors exact.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 INS PRE POST matrix n50 k3", () => {
	const n = 50;
	const k = 3;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");
	const body = Array.from({ length: k }, (_, i) => `+I${i + 1}`).join("\n");
	const inserted = Array.from({ length: k }, (_, i) => `I${i + 1}`);

	for (let a = 1; a <= n; a++) {
		it(`POST ${a} k=3`, () => {
			const out = applyEdits(base, parsePatch(`INS.POST ${a}:\n${body}`).edits).text.split("\n");
			expect(out).toEqual([...lines.slice(0, a), ...inserted, ...lines.slice(a)]);
		});

		it(`PRE ${a} k=3`, () => {
			const out = applyEdits(base, parsePatch(`INS.PRE ${a}:\n${body}`).edits).text.split("\n");
			expect(out).toEqual([...lines.slice(0, a - 1), ...inserted, ...lines.slice(a - 1)]);
		});
	}
});
