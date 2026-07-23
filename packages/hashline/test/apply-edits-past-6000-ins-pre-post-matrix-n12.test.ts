/**
 * Full PRE/POST × anchor matrix on n=12 with multi-row body k=1..4.
 * Why: multi-row PRE/POST must insert the full body block at the anchor side.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 INS PRE POST matrix n12", () => {
	const n = 12;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let a = 1; a <= n; a++) {
		for (let k = 1; k <= 4; k++) {
			it(`POST ${a} k=${k}`, () => {
				const rows = Array.from({ length: k }, (_, i) => `+P${i + 1}`).join("\n");
				const { text } = applyEdits(base, parsePatch(`INS.POST ${a}:\n${rows}`).edits);
				const out = text.split("\n");
				expect(out).toHaveLength(n + k);
				expect(out.slice(0, a)).toEqual(lines.slice(0, a));
				expect(out.slice(a, a + k)).toEqual(Array.from({ length: k }, (_, i) => `P${i + 1}`));
				expect(out.slice(a + k)).toEqual(lines.slice(a));
			});

			it(`PRE ${a} k=${k}`, () => {
				const rows = Array.from({ length: k }, (_, i) => `+R${i + 1}`).join("\n");
				const { text } = applyEdits(base, parsePatch(`INS.PRE ${a}:\n${rows}`).edits);
				const out = text.split("\n");
				expect(out).toHaveLength(n + k);
				expect(out.slice(0, a - 1)).toEqual(lines.slice(0, a - 1));
				expect(out.slice(a - 1, a - 1 + k)).toEqual(Array.from({ length: k }, (_, i) => `R${i + 1}`));
				expect(out.slice(a - 1 + k)).toEqual(lines.slice(a - 1));
			});
		}
	}
});
