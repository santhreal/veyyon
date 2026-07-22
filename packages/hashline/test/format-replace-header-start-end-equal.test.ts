/**
 * formatReplaceHeader always uses N.=M: form even when start===end.
 */
import { describe, expect, it } from "bun:test";
import { formatReplaceHeader } from "@veyyon/hashline";

describe("formatReplaceHeader always range form", () => {
	for (let n = 1; n <= 15; n++) {
		it(`SWAP ${n}.=${n}:`, () => {
			expect(formatReplaceHeader(n, n)).toBe(`SWAP ${n}.=${n}:`);
		});
	}
});
