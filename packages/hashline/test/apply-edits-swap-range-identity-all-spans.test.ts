/**
 * Identity multi-line SWAP for every span on n=8: text unchanged.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP range identity all spans", () => {
	const n = 8;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let start = 1; start <= n; start++) {
		for (let end = start; end <= n; end++) {
			it(`identity SWAP ${start}.=${end}`, () => {
				const body = lines
					.slice(start - 1, end)
					.map(l => `+${l}`)
					.join("\n");
				const { text } = applyEdits(
					base,
					parsePatch(`SWAP ${start}.=${end}:\n${body}`).edits,
				);
				expect(text).toBe(base);
			});
		}
	}
});
