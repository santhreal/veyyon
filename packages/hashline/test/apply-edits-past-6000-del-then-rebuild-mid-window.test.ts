/**
 * DEL middle window then INS.HEAD prefix + INS.TAIL suffix to reconstruct.
 * Why: partial clear must rejoin with exact exterior lines after rebuild.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 DEL then rebuild mid window", () => {
	const n = 20;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let start = 2; start <= 10; start++) {
		for (let end = start; end <= Math.min(start + 8, n - 1); end++) {
			it(`cut ${start}.=${end} keep ends`, () => {
				const header = start === end ? `DEL ${start}` : `DEL ${start}.=${end}`;
				const mid = applyEdits(base, parsePatch(header).edits).text;
				const expected = [...lines.slice(0, start - 1), ...lines.slice(end)];
				expect(mid === "" ? [] : mid.split("\n")).toEqual(expected);
				// rebuild deleted block via POST after line start-1
				const body = lines
					.slice(start - 1, end)
					.map((l) => `+${l}`)
					.join("\n");
				const anchor = start - 1;
				const restored = applyEdits(
					mid,
					parsePatch(`INS.POST ${anchor}:\n${body}`).edits,
				).text;
				expect(restored).toBe(base);
			});
		}
	}
});
