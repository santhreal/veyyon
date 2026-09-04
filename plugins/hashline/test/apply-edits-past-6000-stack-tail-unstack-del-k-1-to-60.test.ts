/**
 * Stack k TAIL inserts then DEL suffix restores base for k=1..60.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 stack TAIL unstack DEL k 1 to 60", () => {
	const base = "A\nB\nC";
	const baseLen = 3;

	for (let k = 1; k <= 60; k++) {
		it(`stack ${k} TAIL then DEL suffix`, () => {
			const rows = Array.from({ length: k }, (_, i) => `+T${i + 1}`).join("\n");
			const stacked = applyEdits(base, parsePatch(`INS.TAIL:\n${rows}`).edits).text;
			const start = baseLen + 1;
			const end = baseLen + k;
			const header = start === end ? `DEL ${start}` : `DEL ${start}.=${end}`;
			expect(applyEdits(stacked, parsePatch(header).edits).text).toBe(base);
		});
	}
});
