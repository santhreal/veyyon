/**
 * After SWAP on [start,end], every line outside that range is byte-identical
 * to the original line at that index (accounting for body length delta).
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP preserves outside range identity", () => {
	const n = 15;
	const lines = Array.from({ length: n }, (_, i) => `UNIQUE-${i + 1}-${i * 7}`);
	const base = lines.join("\n");

	for (let start = 1; start <= 5; start++) {
		for (let end = start; end <= start + 3; end++) {
			for (const bodyLen of [1, 3, 5]) {
				it(`SWAP ${start}.=${end} body=${bodyLen}`, () => {
					const body = Array.from({ length: bodyLen }, (_, i) => `NEW-${i}`);
					const rows = body.map(l => `+${l}`).join("\n");
					const { text } = applyEdits(base, parsePatch(`SWAP ${start}.=${end}:\n${rows}`).edits);
					const out = text.split("\n");
					// prefix
					for (let i = 0; i < start - 1; i++) {
						expect(out[i]).toBe(lines[i]);
					}
					// body
					for (let i = 0; i < bodyLen; i++) {
						expect(out[start - 1 + i]).toBe(body[i]);
					}
					// suffix
					const suffixStart = start - 1 + bodyLen;
					for (let j = 0; j < n - end; j++) {
						expect(out[suffixStart + j]).toBe(lines[end + j]);
					}
				});
			}
		}
	}
});
