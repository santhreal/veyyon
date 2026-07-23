/**
 * INS.POST / INS.PRE at every anchor 1..60000 on n=60000 (chunked its).
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 POST PRE 1 to 60000", () => {
	const n = 60000;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");
	const chunk = 1000;

	for (let start = 1; start <= n; start += chunk) {
		const end = Math.min(start + chunk - 1, n);
		it(`POST anchors ${start}..${end}`, () => {
			for (let a = start; a <= end; a++) {
				const { text, firstChangedLine } = applyEdits(base, parsePatch(`INS.POST ${a}:\n+P`).edits);
				expect(text.split("\n")[a]).toBe("P");
				expect(firstChangedLine).toBe(a);
			}
		});
		it(`PRE anchors ${start}..${end}`, () => {
			for (let a = start; a <= end; a++) {
				const { text, firstChangedLine } = applyEdits(base, parsePatch(`INS.PRE ${a}:\n+R`).edits);
				expect(text.split("\n")[a - 1]).toBe("R");
				expect(firstChangedLine).toBe(a);
			}
		});
	}
});
