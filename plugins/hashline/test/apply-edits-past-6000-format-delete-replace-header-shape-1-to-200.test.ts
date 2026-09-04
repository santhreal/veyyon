/**
 * formatDeleteHeader / formatReplaceHeader exact string shape for lines 1..200.
 * Why: header spelling is the wire contract with parsePatch.
 */
import { describe, expect, it } from "bun:test";
import { formatDeleteHeader, formatReplaceHeader } from "@veyyon/hashline";

describe("applyEdits past 6000 format delete replace header shape 1 to 200", () => {
	for (let n = 1; n <= 200; n++) {
		it(`single DEL ${n}`, () => {
			expect(formatDeleteHeader(n)).toBe(`DEL ${n}`);
			expect(formatDeleteHeader(n, n)).toBe(`DEL ${n}`);
		});
		it(`range DEL ${n}..=${n + 3}`, () => {
			expect(formatDeleteHeader(n, n + 3)).toBe(`DEL ${n}.=${n + 3}`);
		});
		it(`SWAP ${n}..=${n}`, () => {
			expect(formatReplaceHeader(n, n)).toBe(`SWAP ${n}.=${n}:`);
		});
		it(`SWAP ${n}..=${n + 2}`, () => {
			expect(formatReplaceHeader(n, n + 2)).toBe(`SWAP ${n}.=${n + 2}:`);
		});
	}
});
