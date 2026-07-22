/**
 * DEL prefix 1..=k then DEL new-suffix on remaining for n=80.
 * Why: sequential window shrinks must leave exact middle slice.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 DEL prefix then suffix n80", () => {
	const n = 80;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let pref = 1; pref <= 15; pref++) {
		for (let suf = 1; suf <= 15; suf++) {
			if (pref + suf >= n) continue;
			it(`pref=${pref} suf=${suf}`, () => {
				const afterPref = applyEdits(base, parsePatch(`DEL 1.=${pref}`).edits).text;
				const rem = n - pref;
				const afterSuf = applyEdits(
					afterPref,
					parsePatch(`DEL ${rem - suf + 1}.=${rem}`).edits,
				).text;
				expect(afterSuf.split("\n")).toEqual(lines.slice(pref, n - suf));
			});
		}
	}
});
