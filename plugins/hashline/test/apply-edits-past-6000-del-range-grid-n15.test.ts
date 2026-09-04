/**
 * Full DEL start..=end grid on n=15: exact remaining join for every window.
 * Why: complete range-delete property table on a mid-size file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 DEL range grid n15", () => {
	const n = 15;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let start = 1; start <= n; start++) {
		for (let end = start; end <= n; end++) {
			it(`DEL ${start}.=${end}`, () => {
				const header = start === end ? `DEL ${start}` : `DEL ${start}.=${end}`;
				const { text, firstChangedLine } = applyEdits(base, parsePatch(header).edits);
				const expected = [...lines.slice(0, start - 1), ...lines.slice(end)];
				expect(text === "" ? [] : text.split("\n")).toEqual(expected);
				expect(firstChangedLine).toBe(start);
			});
		}
	}
});
