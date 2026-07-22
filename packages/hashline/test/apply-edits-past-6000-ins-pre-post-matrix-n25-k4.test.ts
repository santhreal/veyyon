/**
 * PRE/POST × anchor on n=25 with body k=1..4.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 INS PRE POST matrix n25 k4", () => {
	const n = 25;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let a = 1; a <= n; a++) {
		for (let k = 1; k <= 4; k++) {
			it(`POST ${a} k=${k}`, () => {
				const rows = Array.from({ length: k }, (_, i) => `+P${i + 1}`).join("\n");
				const out = applyEdits(base, parsePatch(`INS.POST ${a}:\n${rows}`).edits).text.split(
					"\n",
				);
				expect(out).toHaveLength(n + k);
				expect(out.slice(a, a + k)).toEqual(
					Array.from({ length: k }, (_, i) => `P${i + 1}`),
				);
			});

			it(`PRE ${a} k=${k}`, () => {
				const rows = Array.from({ length: k }, (_, i) => `+R${i + 1}`).join("\n");
				const out = applyEdits(base, parsePatch(`INS.PRE ${a}:\n${rows}`).edits).text.split(
					"\n",
				);
				expect(out).toHaveLength(n + k);
				expect(out.slice(a - 1, a - 1 + k)).toEqual(
					Array.from({ length: k }, (_, i) => `R${i + 1}`),
				);
			});
		}
	}
});
