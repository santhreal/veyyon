/**
 * Multi-hunk DEL odds then remaining via original indices on n=80.
 * Why: two-pass concurrent deletes must empty the file exactly.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 multi-hunk DEL odds evens n80", () => {
	const n = 80;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	it("DEL all odds in one multi-hunk leaves only evens", () => {
		const odds = Array.from({ length: n }, (_, i) => i + 1).filter((x) => x % 2 === 1);
		const hunks = odds.map((x) => `DEL ${x}`).join("\n");
		const out = applyEdits(base, parsePatch(hunks).edits).text;
		const expected = lines.filter((_, i) => (i + 1) % 2 === 0);
		expect(out.split("\n")).toEqual(expected);
	});

	it("DEL all lines multi-hunk empties", () => {
		const hunks = Array.from({ length: n }, (_, i) => `DEL ${i + 1}`).join("\n");
		const out = applyEdits(base, parsePatch(hunks).edits).text;
		expect(out).toBe("");
	});

	it("DEL all then HEAD rebuild restores content", () => {
		const empty = applyEdits(
			base,
			parsePatch(Array.from({ length: n }, (_, i) => `DEL ${i + 1}`).join("\n")).edits,
		).text;
		expect(empty).toBe("");
		const body = lines.map((l) => `+${l}`).join("\n");
		const back = applyEdits(empty, parsePatch(`INS.HEAD:\n${body}`).edits).text;
		expect(back).toBe(base);
	});
});
