/**
 * Sequential DEL prefix then suffix on n=50 for pref,suf in 1..15.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 DEL prefix then suffix n50", () => {
	const n = 50;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let pref = 1; pref <= 15; pref++) {
		for (let suf = 1; suf <= 15; suf++) {
			if (pref + suf >= n) continue;
			it(`prefix ${pref} then suffix ${suf}`, () => {
				const afterPref = applyEdits(
					base,
					parsePatch(pref === 1 ? "DEL 1" : `DEL 1.=${pref}`).edits,
				).text;
				const remaining = n - pref;
				const start = remaining - suf + 1;
				const header =
					start === remaining ? `DEL ${start}` : `DEL ${start}.=${remaining}`;
				const final = applyEdits(afterPref, parsePatch(header).edits).text;
				expect(final === "" ? [] : final.split("\n")).toEqual(lines.slice(pref, n - suf));
			});
		}
	}
});
