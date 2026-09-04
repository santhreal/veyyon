/**
 * Walk down a file swapping each line in sequence: final content is all X-prefixed.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits sequential SWAP walk property", () => {
	for (const n of [3, 5, 8]) {
		it(`walk n=${n}`, () => {
			let t = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
			for (let line = 1; line <= n; line++) {
				t = applyEdits(t, parsePatch(`SWAP ${line}.=${line}:\n+X${line}`).edits).text;
			}
			expect(t.split("\n")).toEqual(Array.from({ length: n }, (_, i) => `X${i + 1}`));
		});
	}
});
