/**
 * formatDeleteHeader / formatReplaceHeader round-trip parse+apply for ranges 1..50.
 * Why: formatter string must equal what parsePatch accepts and applyEdits runs.
 * formatReplaceHeader already includes the trailing colon.
 */
import { describe, expect, it } from "bun:test";
import {
	applyEdits,
	formatDeleteHeader,
	formatReplaceHeader,
	parsePatch,
} from "@veyyon/hashline";

describe("applyEdits past 6000 format header roundtrip 1 to 50", () => {
	const n = 50;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let i = 1; i <= n; i++) {
		it(`formatDeleteHeader single ${i}`, () => {
			const header = formatDeleteHeader(i);
			expect(header).toBe(`DEL ${i}`);
			const { text } = applyEdits(base, parsePatch(header).edits);
			expect(text === "" ? [] : text.split("\n")).toEqual(lines.filter((_, j) => j + 1 !== i));
		});

		it(`formatReplaceHeader single ${i}`, () => {
			const header = formatReplaceHeader(i, i);
			expect(header).toBe(`SWAP ${i}.=${i}:`);
			const patch = `${header}\n+Z${i}`;
			const { text } = applyEdits(base, parsePatch(patch).edits);
			const out = text.split("\n");
			expect(out[i - 1]).toBe(`Z${i}`);
		});
	}

	for (let start = 1; start <= 10; start++) {
		for (let end = start; end <= Math.min(start + 5, n); end++) {
			it(`formatDeleteHeader range ${start}.=${end}`, () => {
				const header = formatDeleteHeader(start, end);
				expect(header).toBe(start === end ? `DEL ${start}` : `DEL ${start}.=${end}`);
				const { text } = applyEdits(base, parsePatch(header).edits);
				const expected = lines.filter((_, j) => j + 1 < start || j + 1 > end);
				expect(text === "" ? [] : text.split("\n")).toEqual(expected);
			});
		}
	}
});
