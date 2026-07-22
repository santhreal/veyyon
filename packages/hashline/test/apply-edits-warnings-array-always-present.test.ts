/**
 * applyEdits result always has text + firstChangedLine; warnings only when set.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits result shape", () => {
	const cases = [
		"DEL 1",
		"SWAP 1.=1:\n+x",
		"INS.HEAD:\n+h",
		"INS.TAIL:\n+t",
		"INS.POST 1:\n+p",
		"DEL 1.=3",
	];
	for (const patch of cases) {
		it(patch.split("\n")[0]!, () => {
			const base = "a\nb\nc\nd";
			const r = applyEdits(base, parsePatch(patch).edits);
			expect(typeof r.text).toBe("string");
			expect("firstChangedLine" in r).toBe(true);
			if (r.warnings !== undefined) {
				expect(Array.isArray(r.warnings)).toBe(true);
			}
		});
	}
});
