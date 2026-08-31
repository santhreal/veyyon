/**
 * firstChangedLine for every DEL start..=end on n=50 is start.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 firstChangedLine DEL range n50", () => {
	const n = 50;
	const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");

	for (let start = 1; start <= n; start++) {
		for (let end = start; end <= n; end++) {
			it(`DEL ${start}.=${end}`, () => {
				const header = start === end ? `DEL ${start}` : `DEL ${start}.=${end}`;
				expect(applyEdits(base, parsePatch(header).edits).firstChangedLine).toBe(start);
			});
		}
	}
});
