/**
 * Every single-line SWAP on an n-line file places body and preserves others.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits single-line SWAP grid", () => {
	for (const n of [3, 5, 9]) {
		const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
		const base = lines.join("\n");
		for (let line = 1; line <= n; line++) {
			it(`n=${n} SWAP ${line}`, () => {
				const { text } = applyEdits(base, parsePatch(`SWAP ${line}.=${line}:\n+X${line}`).edits);
				const out = text.split("\n");
				expect(out).toHaveLength(n);
				for (let i = 0; i < n; i++) {
					if (i + 1 === line) expect(out[i]).toBe(`X${line}`);
					else expect(out[i]).toBe(lines[i]);
				}
			});
		}
	}
});
