/**
 * Disjoint INS.POST + SWAP multi-hunk on n=35: exact interleave.
 * Why: insert after original line must not steal swap of another original line.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 POST then SWAP disjoint n35", () => {
	const n = 35;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let post = 1; post <= n; post++) {
		for (let sw = 1; sw <= n; sw++) {
			if (post === sw) continue;
			it(`POST ${post} SWAP ${sw}`, () => {
				const out = applyEdits(base, parsePatch(`INS.POST ${post}:\n+P\nSWAP ${sw}.=${sw}:\n+S`).edits).text.split(
					"\n",
				);
				const expected: string[] = [];
				for (let i = 1; i <= n; i++) {
					expected.push(i === sw ? "S" : lines[i - 1]!);
					if (i === post) expected.push("P");
				}
				expect(out).toEqual(expected);
			});
		}
	}
});
