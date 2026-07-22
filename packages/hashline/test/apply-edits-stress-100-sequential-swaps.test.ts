/**
 * 100 sequential SWAPs on a rotating line index: no throw, length stable.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits stress 100 sequential SWAPs", () => {
	it("rotating line on n=7 file", () => {
		const n = 7;
		let t = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
		for (let i = 0; i < 100; i++) {
			const line = (i % n) + 1;
			t = applyEdits(t, parsePatch(`SWAP ${line}.=${line}:\n+V${i}`).edits).text;
			expect(t.split("\n")).toHaveLength(n);
		}
		// last writes on each line index: V for last time that line was hit
		const out = t.split("\n");
		for (let line = 1; line <= n; line++) {
			// last i where i % n + 1 === line → i = line-1 + k*n max < 100
			const lastI = line - 1 + Math.floor((99 - (line - 1)) / n) * n;
			expect(out[line - 1]).toBe(`V${lastI}`);
		}
	});
});
