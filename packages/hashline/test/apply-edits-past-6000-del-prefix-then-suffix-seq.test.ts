/**
 * Sequential DEL prefix k then DEL suffix m on remaining: exact middle slice.
 * Why: sequential renumber after prefix DEL must use new indices for suffix.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 DEL prefix then suffix seq", () => {
	const n = 30;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let pref = 1; pref <= 10; pref++) {
		for (let suf = 1; suf <= 10; suf++) {
			if (pref + suf >= n) continue;
			it(`prefix ${pref} then suffix ${suf}`, () => {
				const afterPref = applyEdits(base, parsePatch(pref === 1 ? "DEL 1" : `DEL 1.=${pref}`).edits).text;
				const remaining = n - pref;
				const start = remaining - suf + 1;
				const header = start === remaining ? `DEL ${start}` : `DEL ${start}.=${remaining}`;
				const final = applyEdits(afterPref, parsePatch(header).edits).text;
				const expected = lines.slice(pref, n - suf);
				expect(final === "" ? [] : final.split("\n")).toEqual(expected);
			});
		}
	}
});
