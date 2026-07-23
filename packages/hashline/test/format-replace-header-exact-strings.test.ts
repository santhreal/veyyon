/**
 * formatReplaceHeader exact strings for ranges 1..8.
 */
import { describe, expect, it } from "bun:test";
import { formatReplaceHeader } from "@veyyon/hashline";

describe("formatReplaceHeader exact strings", () => {
	for (let start = 1; start <= 8; start++) {
		for (const end of [start, start + 1, start + 3]) {
			if (end > 20) continue;
			it(`SWAP ${start}.=${end}:`, () => {
				expect(formatReplaceHeader(start, end)).toBe(`SWAP ${start}.=${end}:`);
			});
		}
	}
});
