/**
 * SWAP range start..=end with body k rows for several ranges on n=15.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 SWAP range body k grid", () => {
	const n = 15;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	const ranges: [number, number][] = [
		[1, 1],
		[1, 3],
		[2, 5],
		[5, 10],
		[8, 15],
		[1, 15],
	];

	for (const [start, end] of ranges) {
		for (let k = 0; k <= 6; k++) {
			it(`SWAP ${start}.=${end} k=${k}`, () => {
				const rows =
					k === 0
						? ""
						: Array.from({ length: k }, (_, i) => `+B${i + 1}`).join("\n");
				const patch = k === 0 ? `SWAP ${start}.=${end}:\n` : `SWAP ${start}.=${end}:\n${rows}`;
				const { text, firstChangedLine } = applyEdits(base, parsePatch(patch).edits);
				const body = k === 0 ? [] : Array.from({ length: k }, (_, i) => `B${i + 1}`);
				const expected = [...lines.slice(0, start - 1), ...body, ...lines.slice(end)];
				expect(text === "" ? [] : text.split("\n")).toEqual(expected);
				expect(firstChangedLine).toBe(start);
			});
		}
	}
});
