/**
 * SWAP range start..=end with a k-row body (k>=1) for several ranges on n=15:
 * exact splice. k=0 (a bodyless SWAP) is not a splice — it is rejected with
 * EMPTY_REPLACE (silent-delete footgun removed), asserted separately per range.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, EMPTY_REPLACE, parsePatch } from "@veyyon/hashline";

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
		it(`SWAP ${start}.=${end} with an empty body is rejected`, () => {
			expect(() => parsePatch(`SWAP ${start}.=${end}:\n`)).toThrow(EMPTY_REPLACE);
		});
		for (let k = 1; k <= 6; k++) {
			it(`SWAP ${start}.=${end} k=${k}`, () => {
				const rows = Array.from({ length: k }, (_, i) => `+B${i + 1}`).join("\n");
				const { text, firstChangedLine } = applyEdits(base, parsePatch(`SWAP ${start}.=${end}:\n${rows}`).edits);
				const body = Array.from({ length: k }, (_, i) => `B${i + 1}`);
				const expected = [...lines.slice(0, start - 1), ...body, ...lines.slice(end)];
				expect(text === "" ? [] : text.split("\n")).toEqual(expected);
				expect(firstChangedLine).toBe(start);
			});
		}
	}
});
