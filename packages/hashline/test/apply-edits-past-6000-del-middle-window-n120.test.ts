/**
 * DEL middle window start..=end for sliding windows on n=120.
 * Why: interior range deletes must keep prefix+suffix exact.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 DEL middle window n120", () => {
	const n = 120;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let width = 1; width <= 20; width++) {
		for (let start = 1; start <= n - width + 1; start += Math.max(1, Math.floor(n / 20))) {
			const end = start + width - 1;
			it(`DEL ${start}.=${end}`, () => {
				const header = start === end ? `DEL ${start}` : `DEL ${start}.=${end}`;
				const out = applyEdits(base, parsePatch(header).edits).text;
				expect(out === "" ? [] : out.split("\n")).toEqual([
					...lines.slice(0, start - 1),
					...lines.slice(end),
				]);
			});
		}
	}
});
