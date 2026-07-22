/**
 * SWAP start..=end with body length 1..remaining on n=40: exact splice.
 * Why: multi-line replace body length must not corrupt surrounding lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 SWAP range body length n40", () => {
	const n = 40;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let start = 1; start <= n; start++) {
		for (let end = start; end <= Math.min(start + 8, n); end++) {
			for (let k = 1; k <= 5; k++) {
				it(`SWAP ${start}.=${end} bodyK=${k}`, () => {
					const body = Array.from({ length: k }, (_, i) => `+B${i + 1}`).join("\n");
					const { text, firstChangedLine } = applyEdits(
						base,
						parsePatch(`SWAP ${start}.=${end}:\n${body}`).edits,
					);
					const expected = [
						...lines.slice(0, start - 1),
						...Array.from({ length: k }, (_, i) => `B${i + 1}`),
						...lines.slice(end),
					];
					expect(text.split("\n")).toEqual(expected);
					expect(firstChangedLine).toBe(start);
				});
			}
		}
	}
});
