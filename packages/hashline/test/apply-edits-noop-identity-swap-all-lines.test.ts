/**
 * Identity SWAP of every single line on an n-line file leaves text unchanged.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits noop identity SWAP all lines", () => {
	for (const n of [1, 3, 7, 12]) {
		const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
		const base = lines.join("\n");
		for (let line = 1; line <= n; line++) {
			it(`n=${n} identity SWAP ${line}`, () => {
				const { text } = applyEdits(
					base,
					parsePatch(`SWAP ${line}.=${line}:\n+${lines[line - 1]}`).edits,
				);
				expect(text).toBe(base);
			});
		}
	}
});
