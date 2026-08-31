/**
 * Multi-line SWAP shrink to single body row: net length decreases by span-1.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits multiline body to single line grid", () => {
	const n = 10;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let start = 1; start <= 6; start++) {
		for (let span = 2; span <= 4; span++) {
			const end = start + span - 1;
			if (end > n) continue;
			it(`SWAP ${start}.=${end} → one row`, () => {
				const { text } = applyEdits(base, parsePatch(`SWAP ${start}.=${end}:\n+ONE`).edits);
				const out = text.split("\n");
				expect(out.length).toBe(n - span + 1);
				expect(out[start - 1]).toBe("ONE");
				expect(out.slice(0, start - 1)).toEqual(lines.slice(0, start - 1));
				expect(out.slice(start)).toEqual(lines.slice(end));
			});
		}
	}
});
