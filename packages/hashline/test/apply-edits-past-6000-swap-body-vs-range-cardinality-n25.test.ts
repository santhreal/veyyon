/**
 * SWAP start..=end with body length 1..10 on n=25: cardinality = prefix+body+suffix.
 * Why: body length is independent of deleted span size.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 SWAP body vs range cardinality n25", () => {
	const n = 25;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let start = 1; start <= n; start++) {
		for (let end = start; end <= Math.min(start + 4, n); end++) {
			for (let k = 1; k <= 10; k++) {
				it(`SWAP ${start}.=${end} k=${k}`, () => {
					const body = Array.from({ length: k }, (_, i) => `+B${i}`).join("\n");
					const out = applyEdits(base, parsePatch(`SWAP ${start}.=${end}:\n${body}`).edits).text.split("\n");
					expect(out).toHaveLength(start - 1 + k + (n - end));
					expect(out.slice(0, start - 1)).toEqual(lines.slice(0, start - 1));
					expect(out.slice(start - 1, start - 1 + k)).toEqual(Array.from({ length: k }, (_, i) => `B${i}`));
					expect(out.slice(start - 1 + k)).toEqual(lines.slice(end));
				});
			}
		}
	}
});
