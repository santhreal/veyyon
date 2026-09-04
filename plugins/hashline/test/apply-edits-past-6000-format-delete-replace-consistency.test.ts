/**
 * formatDeleteHeader vs formatReplaceHeader: single-line and range string forms.
 * Why: tools that emit headers must not invent a second string dialect.
 */
import { describe, expect, it } from "bun:test";
import { formatDeleteHeader, formatReplaceHeader } from "@veyyon/hashline";

describe("applyEdits past 6000 format delete replace consistency", () => {
	for (let i = 1; i <= 50; i++) {
		it(`single ${i}`, () => {
			expect(formatDeleteHeader(i)).toBe(`DEL ${i}`);
			expect(formatDeleteHeader(i, i)).toBe(`DEL ${i}`);
			expect(formatReplaceHeader(i, i)).toBe(`SWAP ${i}.=${i}:`);
		});
	}

	for (let s = 1; s <= 20; s++) {
		for (let e = s + 1; e <= Math.min(s + 10, 40); e++) {
			it(`range ${s}.=${e}`, () => {
				expect(formatDeleteHeader(s, e)).toBe(`DEL ${s}.=${e}`);
				expect(formatReplaceHeader(s, e)).toBe(`SWAP ${s}.=${e}:`);
			});
		}
	}
});
